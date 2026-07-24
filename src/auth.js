export async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/login`);
  await page.waitForSelector("#username");
  await page.fill("#username", process.env.APP_EMAIL);
  await page.click('button[name="action"][value="default"]');
  console.log("Email submitted, waiting for password field...");
  await page.waitForSelector("#password", { timeout: 10000 });
  await page.fill("#password", process.env.APP_PASSWORD);
  await page.click('button[type="submit"]');
  console.log("Password submitted, checking for OTP or dashboard...");
  await page.waitForTimeout(3000);
  const currentUrl = page.url();
  console.log("Current URL after login:", currentUrl);
  if (
    currentUrl.includes("mfa") ||
    currentUrl.includes("otp") ||
    currentUrl.includes("verify")
  ) {
    console.log("OTP screen detected — please enter OTP manually...");
    await page.pause();
  }
  console.log("Login complete. URL:", page.url());
}
