import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";
import { login } from "./auth.js";
import {
  navigateToPatients,
  navigateToPatientByStatus,
  navigateToOrdersTab,
  downloadOrderImage,
} from "./scraper.js";
dotenv.config();
async function run() {
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
  const landedUrl = page.url();
  console.log("Landed on:", landedUrl);
  if (!landedUrl.includes("/login")) {
    console.log("Session valid — already logged in. Skipping login step.");
  } else {
    console.log("Session missing or expired — logging in...");
    await login(page, process.env.APP_URL);
    await context.storageState({ path: sessionFile });
    console.log("Session saved.");
  }
  await navigateToPatients(page);
  await navigateToPatientByStatus(page, process.env.APP_URL, "Established");
  await navigateToOrdersTab(page);
  await downloadOrderImage(page, "./downloads");
  await page.pause();
  await browser.close();
}
run().catch(console.error);
