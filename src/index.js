console.log("cwd =", process.cwd());
import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";
import { login } from "./auth.js";
import {
  navigateToPatients,
  getAllPatientsByStatus,
  navigateToOrdersTab,
  navigateToDocumentsTab,
  navigateToAppointmentsTab,
  downloadOrderImage,
  scrapeAndDownloadDocuments,
  scrapeCompletedAppointmentUrls,
  scrapeTreatmentNote,
  getPatientDisplayId,
  navigateToWeightHeightTab,
  scrapeWeightHeight,
  selectLocation,
} from "./scraper.js";
import { createOrdersExcel, updateDocumentsExcel, updateTreatmentNotesExcel } from "./excel.js";
import { loadCheckpoint, markPatientDone, isPatientDone } from "./checkpoint.js";
import { withTimeout, retryOnce } from "./utils.js";
import path from "path";

const TAB_TIMEOUT = 30000;      // per navigation/scrape step
const PATIENT_TIMEOUT = 120000; // hard cap per patient, covers the retry tooimport { loadCheckpoint, markPatientDone, isPatientDone } from "./checkpoint.js";

dotenv.config();

async function processPatient(page, patient, ORDERS_DIR, DOCUMENTS_DIR) {
  const orders = [];
  const documents = [];
  const treatmentNotes = [];

  await page.goto(patient.url, { waitUntil: "domcontentloaded" });
  const displayId =
    (await withTimeout(getPatientDisplayId(page), TAB_TIMEOUT, "getPatientDisplayId")) ??
    patient.patientId;

  await withTimeout(navigateToWeightHeightTab(page), TAB_TIMEOUT, "navigateToWeightHeightTab");
  const weightHeight = await withTimeout(scrapeWeightHeight(page), TAB_TIMEOUT, "scrapeWeightHeight");

  await withTimeout(navigateToOrdersTab(page), TAB_TIMEOUT, "navigateToOrdersTab");
  const orderResults = await withTimeout(
    downloadOrderImage(page, process.env.APP_URL, ORDERS_DIR),
    TAB_TIMEOUT,
    "downloadOrderImage"
  );

  if (orderResults.length > 0) {
    for (const order of orderResults) {
      orders.push({ ...order, ...weightHeight, patientId: displayId });
    }
  } else {
    orders.push({
      patientId: displayId,
      orderId: `patient-${patient.patientId}`,
      route: "",
      schedule: "",
      weightLbs: weightHeight.weightLbs,
      weightKgs: weightHeight.weightKgs,
      heightIn: weightHeight.heightIn,
      heightCm: weightHeight.heightCm,
      downloadStatus: "No Orders Found",
    });
  }

  // ---- Documents ----
  await page.goto(patient.url, { waitUntil: "domcontentloaded" });
  console.log("================================");
  console.log("Patient:", patient.patientId);
  console.log("URL:", page.url());
  await withTimeout(navigateToDocumentsTab(page), TAB_TIMEOUT, "navigateToDocumentsTab");
  // ADD THIS
  const rows = page.locator('tbody[md-body] tr[md-row]');

  console.log("Rows on page:", await rows.count());

  if (await rows.count() > 0) {
    console.log(
      "First description:",
      await rows.nth(0).locator("td").nth(3).innerText()
    );
  }
  const docs = await withTimeout(
    scrapeAndDownloadDocuments(page, patient.patientId, DOCUMENTS_DIR),
    TAB_TIMEOUT,
    "scrapeAndDownloadDocuments"
  );
  console.log("Docs returned:", docs.length);

  docs.forEach((d) => { d.patientId = displayId; });
  documents.push(...docs);

  // ---- Treatment Notes ----
  await page.goto(patient.url, { waitUntil: "domcontentloaded" });
  await withTimeout(navigateToAppointmentsTab(page), TAB_TIMEOUT, "navigateToAppointmentsTab");
  const completedAppts = await withTimeout(
    scrapeCompletedAppointmentUrls(page, process.env.APP_URL),
    TAB_TIMEOUT,
    "scrapeCompletedAppointmentUrls"
  );

  for (const appt of completedAppts) {
    try {
      const note = await withTimeout(
        scrapeTreatmentNote(page, patient.patientId, appt.url, process.env.APP_URL),
        TAB_TIMEOUT,
        `scrapeTreatmentNote ${appt.url}`
      );
      note.appointmentDate = appt.date;
      note.patientId = displayId;
      treatmentNotes.push(note);
    } catch (err) {
      console.warn(`Failed to scrape treatment note ${appt.url}:`, err.message);
    }
  }

  return { displayId, orders, documents, treatmentNotes };
}

async function run() {
  const PATIENT_LIMIT = parseInt(process.env.PATIENT_LIMIT ?? "20", 10);
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "./downloads";
  const ORDERS_DIR = path.join(DOWNLOAD_DIR, "orders");
  const DOCUMENTS_DIR = path.join(DOWNLOAD_DIR, "documents");
  const sessionFile = "session.json";
  const hasSession = fs.existsSync(sessionFile);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasSession ? sessionFile : undefined,
  });
  const page = await context.newPage();

  await page.goto(process.env.APP_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  if (page.url().includes("/login") || page.url().includes("/authorize")) {
    await login(page, process.env.APP_URL);
    await context.storageState({ path: sessionFile });
    await page.waitForURL(
      (url) => !url.toString().includes("/authorize"),
      { timeout: 30000 }
    );
    await page.waitForTimeout(2000);
  }

  const checkpoint = loadCheckpoint();
  const allOrders = [];
  const allDocuments = [];
  const allTreatmentNotes = [];
  await selectLocation(page, process.env.LOCATION_NAME);
  await navigateToPatients(page);

  const rows = page.locator('tbody[md-body] tr[md-row]');

  await rows.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => { });

  console.log("Rows:", await rows.count());

  const firstDescription = await rows.nth(0).locator("td").nth(3).innerText().catch(() => "");
  console.log("First document:", firstDescription);

  const patients = await getAllPatientsByStatus(
    page,
    process.env.APP_URL,
    "New"
  );

  let processed = 0;

  for (const patient of patients) {
    if (processed >= PATIENT_LIMIT) {
      console.log(`Reached limit of ${PATIENT_LIMIT} patients. Stopping.`);
      break;
    }

    if (isPatientDone(patient.patientId, checkpoint)) {
      console.log(`Skipping patient ${patient.patientId} — already completed.`);
      processed++;
      continue;
    }

    console.log(`[${processed + 1}/${PATIENT_LIMIT}] Processing patient ${patient.patientId}...`);

    try {
      // Whole patient (including the one retry) must finish inside 2 minutes,
      // otherwise it's abandoned and we move on.
      const result = await withTimeout(
        retryOnce(
          () => processPatient(page, patient, ORDERS_DIR, DOCUMENTS_DIR),
          `patient ${patient.patientId}`
        ),
        PATIENT_TIMEOUT,
        `patient ${patient.patientId} (overall)`
      );

      // Keep running totals for the console summary only.
      allOrders.push(...result.orders);
      allDocuments.push(...result.documents);
      allTreatmentNotes.push(...result.treatmentNotes);

      // Write ONLY this patient's rows — excel.js already dedupes against
      // what's on disk, so passing just the new batch keeps each write fast
      // instead of re-scanning the whole growing array every time.
      await createOrdersExcel(result.orders.filter(Boolean), DOWNLOAD_DIR);
      await updateDocumentsExcel(result.documents, DOWNLOAD_DIR);
      await updateTreatmentNotesExcel(result.treatmentNotes, DOWNLOAD_DIR);

      // Checkpoint is written AFTER the excel writes succeed, so a crash
      // mid-run can never mark a patient "done" whose data isn't saved yet.
      markPatientDone(patient.patientId, checkpoint);
      processed++;
      console.log(`Patient ${patient.patientId} done. (${processed}/${PATIENT_LIMIT})`);
    } catch (err) {
      console.error(
        `Patient ${patient.patientId} failed/timed out after retry:`,
        err.message
      );

      const errorRow = {
        patientId: patient.patientId,
        orderId: `patient-${patient.patientId}`,
        route: "",
        schedule: "",
        downloadStatus: `Error: ${err.message.slice(0, 60)}`,
      };
      allOrders.push(errorRow);
      await createOrdersExcel([errorRow], DOWNLOAD_DIR);

      // Do NOT markPatientDone — leave it unmarked so the next run retries it.
      processed++;

      // A timed-out step may leave the page mid-action (stuck click, open
      // dialog, wrong tab). Reset to a known page before the next patient.
      try {
        await page.goto(process.env.APP_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
      } catch (resetErr) {
        console.warn("Page reset after failure also failed:", resetErr.message);
      }
    }
  }

  console.log(
    `Run complete: ${allOrders.length} order rows, ${allDocuments.length} document rows, ${allTreatmentNotes.length} treatment notes processed.`
  );

  await browser.close();
}

run().catch(console.error);
