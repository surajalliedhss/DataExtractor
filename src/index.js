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
import { withTimeout } from "./utils.js"; // only used for the short per-step timeouts inside processPatient now
import path from "path";

const TAB_TIMEOUT = 30000;      // per navigation/scrape step
const PATIENT_TIMEOUT = 120000; // hard cap per patient — enforced by force-closing the page, see processPatientWithRecovery
const sessionFile = "session.json";
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

  await withTimeout(navigateToDocumentsTab(page), TAB_TIMEOUT, "navigateToDocumentsTab");
  const docs = await withTimeout(
    scrapeAndDownloadDocuments(page, patient.patientId, DOCUMENTS_DIR),
    TAB_TIMEOUT,
    "scrapeAndDownloadDocuments"
  );

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
      // NOTE: this catch swallows the error on purpose (one bad appointment
      // note shouldn't sink the whole patient) — but that means if the page
      // gets force-closed mid-loop by processPatientWithRecovery's deadline
      // timer, every remaining appointment fails near-instantly here and
      // this function can still return "successfully" with partial data.
      // processPatientWithRecovery checks for that explicitly — see
      // `deadlineHit` there — so it isn't mistaken for a real success.
      console.warn(`Failed to scrape treatment note ${appt.url}:`, err.message);
    }
  }

  return { displayId, orders, documents, treatmentNotes };
}

// Closes a page defensively: safe to call on an already-closed page, and
// bounded in case close() itself hangs.
async function safeClose(page, timeoutMs = 5000) {
  if (!page || page.isClosed()) return;
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => { }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// Opens a brand-new tab, points it at the app, and re-selects the clinic
// location so the tab is in a known-good state before anything else touches
// it. Only called when we actually suspect the previous page is poisoned —
// NOT on every patient — so this stays cheap in the common case.
async function recoverPage(context, oldPage, reason) {
  console.warn(`Recovering a fresh page (reason: ${reason})`);
  await safeClose(oldPage);

  const newPage = await context.newPage();
  await newPage.goto(process.env.APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (newPage.url().includes("/login") || newPage.url().includes("/authorize")) {
    console.warn("Session appears invalid — re-authenticating");
    await login(newPage, process.env.APP_URL);
    await context.storageState({ path: sessionFile }); // refresh saved session
  }
  await selectLocation(newPage, process.env.LOCATION_NAME);

  // Let the app settle after the location switch before handing the page
  // back, so the very next navigation isn't racing whatever the location
  // change is still doing client-side. networkidle can legitimately never
  // fire on apps with polling/websockets, so this is bounded and non-fatal.
  await newPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });
  await newPage.waitForTimeout(1000);

  return newPage;
}

// Tries a patient once on the given page; on failure, recovers a fresh page
// and tries exactly once more. The whole attempt (both tries, including
// recovery) is bounded by PATIENT_TIMEOUT — but the deadline is owned BY
// this function, not by an outer Promise.race. When it fires, it
// force-closes whichever page is currently in use. That's real
// cancellation: Playwright rejects any in-flight action on a closed page
// almost immediately, instead of a promise nobody's awaiting anymore
// quietly running to completion in the background. Nothing from this
// patient can still be alive by the time this function settles, so nothing
// from patient A can reach forward and touch patient B's page.
async function processPatientWithRecovery(context, page, patient, ORDERS_DIR, DOCUMENTS_DIR) {
  let currentPage = page;
  let deadlineHit = false;

  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    console.warn(
      `patient ${patient.patientId} hit the ${PATIENT_TIMEOUT}ms overall deadline — force-closing its page to cancel in-flight work`
    );
    safeClose(currentPage).catch(() => { });
  }, PATIENT_TIMEOUT);

  try {
    try {
      const result = await processPatient(currentPage, patient, ORDERS_DIR, DOCUMENTS_DIR);
      if (deadlineHit) {
        // processPatient can return "successfully" with partial data if the
        // deadline fired mid-treatment-notes-loop (see the comment there) —
        // treat that as a failure so the patient gets retried next run
        // instead of silently marked done with incomplete data.
        throw new Error(`exceeded ${PATIENT_TIMEOUT}ms overall deadline (page force-closed mid-run)`);
      }
      return { result, page: currentPage };
    } catch (err) {
      if (deadlineHit) throw err; // out of budget — don't burn more time on a retry that can't finish anyway
      console.warn(`patient ${patient.patientId} failed once (${err.message}) — retrying...`);
      currentPage = await recoverPage(context, currentPage, err.message);
      const result = await processPatient(currentPage, patient, ORDERS_DIR, DOCUMENTS_DIR);
      if (deadlineHit) {
        throw new Error(`exceeded ${PATIENT_TIMEOUT}ms overall deadline during retry (page force-closed mid-run)`);
      }
      return { result, page: currentPage };
    }
  } finally {
    // Critical: without this, a patient that finishes quickly leaves a live
    // timer armed for the rest of the original 120s window. Since `page`
    // usually carries over unchanged to the NEXT patient (no recovery
    // needed), that stale timer could fire late and force-close patient B's
    // page instead — reintroducing the exact cross-patient bug this is
    // meant to fix. Clearing it here scopes the deadline to just this call.
    clearTimeout(deadlineTimer);
  }
}

async function run() {
  const PATIENT_LIMIT = parseInt(process.env.PATIENT_LIMIT ?? "20", 10);
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "./downloads";
  const ORDERS_DIR = path.join(DOWNLOAD_DIR, "orders");
  const DOCUMENTS_DIR = path.join(DOWNLOAD_DIR, "documents");
  // const sessionFile = "session.json";
  const hasSession = fs.existsSync(sessionFile);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasSession ? sessionFile : undefined,
  });
  let page = await context.newPage();

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
    "New",
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
      // CHANGED: no outer withTimeout() here anymore. processPatientWithRecovery
      // owns its own PATIENT_TIMEOUT deadline and enforces it by force-closing
      // the page in use — real cancellation, not a race that just stops
      // waiting. Reuses the SAME page across patients when nothing goes
      // wrong (no per-patient page creation), and only recovers a fresh page
      // when a patient actually fails or blows its deadline.
      const { result, page: healthyPage } = await processPatientWithRecovery(
        context,
        page,
        patient,
        ORDERS_DIR,
        DOCUMENTS_DIR
      );
      page = healthyPage;

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

      // `page` may already be closed (the deadline timer force-closes it on
      // its way out), or still alive but left mid-action. Either way it's
      // untrustworthy — recoverPage()/safeClose() handle an already-closed
      // page fine, so this is safe to call unconditionally.
      try {
        page = await recoverPage(context, page, err.message);
      } catch (recoverErr) {
        console.error("Failed to recover a fresh page — aborting run:", recoverErr.message);
        throw recoverErr;
      }
    }
  }

  console.log(
    `Run complete: ${allOrders.length} order rows, ${allDocuments.length} document rows, ${allTreatmentNotes.length} treatment notes processed.`
  );

  await browser.close();
}

run().catch(console.error);