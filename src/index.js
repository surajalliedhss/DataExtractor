import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";
import { login } from "./auth.js";
import {
  navigateToPatients,
  getAllPatientsByStatus,
  navigateToOrdersTab,
  navigateToDocumentsTab,
  downloadOrderImage,
  scrapeAndDownloadDocuments,
} from "./scraper.js";
import { createOrdersExcel, updateDocumentsExcel } from "./excel.js";
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

    try {
      await page.goto(patient.url, { waitUntil: "domcontentloaded" });
      await navigateToOrdersTab(page);

      const orders = await downloadOrderImage(page, process.env.APP_URL, ORDERS_DIR);

      if (orders.length > 0) {
        for (const order of orders) {
          const entry = { ...order, patientId: patient.patientId };
          console.log("Pushing order entry:", entry);
          allOrders.push(entry);
        }
      } else {
        console.log("No orders found for this patient.");
        allOrders.push({
          patientId: patient.patientId,
          orderId: `patient-${patient.patientId}`,
          route: "",
          schedule: "",
          downloadStatus: "No Orders Found",
        });
      }

      // ---- Documents section ----
      await page.goto(patient.url, { waitUntil: "domcontentloaded" });
      await navigateToDocumentsTab(page);
      const docs = await scrapeAndDownloadDocuments(page, patient.patientId, DOCUMENTS_DIR);
      allDocuments.push(...docs);
      console.log(`Documents scraped for patient ${patient.patientId}: ${docs.length} found.`);
      // ---------------------------

      markPatientDone(patient.patientId, checkpoint);
      processed++;
      console.log(`Patient ${patient.patientId} done. (${processed}/${PATIENT_LIMIT})`);
    } catch (err) {
      console.error(`Error processing patient ${patient.patientId}:`, err.message);
      allOrders.push({
        patientId: patient.patientId,
        orderId: `patient-${patient.patientId}`,
        route: "",
        schedule: "",
        downloadStatus: `Error: ${err.message.slice(0, 60)}`,
      });
      processed++;
    }
  }

  await createOrdersExcel(allOrders.filter(Boolean), DOWNLOAD_DIR);
  await updateDocumentsExcel(allDocuments, DOWNLOAD_DIR);

  await browser.close();
}

run().catch(console.error);
