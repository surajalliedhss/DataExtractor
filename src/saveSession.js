import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config();
async function saveSession() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${process.env.APP_URL}/login`);
  console.log("Please log in manually including OTP...");
  console.log(
    "Once fully logged in, press Resume in the Playwright Inspector.",
  );
  await page.pause();
  await context.storageState({ path: "session.json" });
  console.log("Session saved to session.json");
  await browser.close();
}
saveSession().catch(console.error);
