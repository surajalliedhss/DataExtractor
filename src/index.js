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
import path from "path";

dotenv.config();

async function run() {
  const PATIENT_LIMIT = parseInt(process.env.PATIENT_LIMIT ?? "20", 10);
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "./downloads";
  const ORDERS_DIR = path.join(DOWNLOAD_DIR, "orders");
  const DOCUMENTS_DIR = path.join(DOWNLOAD_DIR, "documents");
  const sessionFile = "session.json";
  const hasSession = fs.existsSync(sessionFile);
  const browser = await chromium.launch({ headless: false });
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

  const patients = await getAllPatientsByStatus(
    page,
    process.env.APP_URL,
    "Established"
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
    let displayId = patient.patientId;
    try {
      await page.goto(patient.url, { waitUntil: "domcontentloaded" });
      displayId = (await getPatientDisplayId(page)) ?? patient.patientId;
      await navigateToWeightHeightTab(page);
      const weightHeight = await scrapeWeightHeight(page);
      await navigateToOrdersTab(page);
      console.log(
        "Order cards:",
        await page.locator("order-detail-react").count()
      );

      console.log(
        "View Order buttons:",
        await page.locator('button[aria-label="view order image"]').count()
      );
      const orders = await downloadOrderImage(page, process.env.APP_URL, ORDERS_DIR);

      if (orders.length > 0) {
        for (const order of orders) {
          const entry = { ...order, ...weightHeight, patientId: displayId };   // was patient.patientId
          allOrders.push(entry);
        }
      } else {
        allOrders.push({
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

      // ---- Documents section ----
      await page.goto(patient.url, { waitUntil: "domcontentloaded" });
      await navigateToDocumentsTab(page);
      const docs = await scrapeAndDownloadDocuments(page, patient.patientId, DOCUMENTS_DIR);
      docs.forEach(d => { d.patientId = displayId; }); 
      allDocuments.push(...docs);
      console.log(`Documents scraped for patient ${patient.patientId}: ${docs.length} found.`);
      // ---------------------------

      markPatientDone(patient.patientId, checkpoint);
      processed++;
      console.log(`Patient ${patient.patientId} done. (${processed}/${PATIENT_LIMIT})`);
    } catch (err) {
      console.error(`Error processing patient ${patient.patientId}:`, err.message);
      allOrders.push({
        patientId: displayId,
        orderId: `patient-${patient.patientId}`,
        route: "",
        schedule: "",
        downloadStatus: `Error: ${err.message.slice(0, 60)}`,
      });
      processed++;
    }
    // ---- Treatment Notes section ----
    await page.goto(patient.url, { waitUntil: "domcontentloaded" });
    await navigateToAppointmentsTab(page);

    const completedAppts = await scrapeCompletedAppointmentUrls(page, process.env.APP_URL);
    console.log(`Found ${completedAppts.length} completed appointments for patient ${patient.patientId}`);

    for (const appt of completedAppts) {
      try {
        const note = await scrapeTreatmentNote(page, patient.patientId, appt.url, process.env.APP_URL);
        note.appointmentDate = appt.date;
        note.patientId = displayId;
        allTreatmentNotes.push(note);
        console.log(`Treatment note scraped: appointment ${note.appointmentId} (${appt.date})`);
      } catch (err) {
        console.warn(`Failed to scrape treatment note ${appt.url}:`, err.message);
      }
    }
    // ----------------------------------
  }

  await createOrdersExcel(allOrders.filter(Boolean), DOWNLOAD_DIR);
  await updateDocumentsExcel(allDocuments, DOWNLOAD_DIR);
  await updateTreatmentNotesExcel(allTreatmentNotes, DOWNLOAD_DIR);

  await browser.close();
}

run().catch(console.error);
