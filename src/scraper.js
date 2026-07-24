export async function navigateToPatients(page) {
  console.log("Navigating to Patients...");
  await page.waitForSelector('li[ui-sref="patients.list"]');
  await page.click('li[ui-sref="patients.list"]');
  await page.waitForURL((url) => url.toString().includes("/patients"), {
    timeout: 10000,
  });
  console.log("Patients page loaded. URL:", page.url());
}
