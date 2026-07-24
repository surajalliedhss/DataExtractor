export async function navigateToPatients(page) {
  console.log("Navigating to Patients...");
  await page.waitForSelector('li[ui-sref="patients.list"]');
  await page.click('li[ui-sref="patients.list"]');
  await page.waitForURL((url) => url.toString().includes("/patients"), {
    timeout: 10000,
  });
  console.log("Patients page loaded. URL:", page.url());
}
export async function navigateToPatientByStatus(page, baseUrl, status) {
  await page.waitForSelector('tr[ui-sref^="patient.edit.overview"]');
  const rows = page.locator('tr[ui-sref^="patient.edit.overview"]');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const rowStatus = await row.locator('td[md-order-by="status"]').innerText();
    if (rowStatus.trim().toLowerCase() === status.toLowerCase()) {
      const href = await row.getAttribute("href");
      const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
      console.log(`Found patient with status "${status}", navigating to:`, url);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      console.log("Patient page loaded:", page.url());
      return;
    }
  }
  console.warn(`No patient found with status "${status}"`);
}
export async function navigateToOrdersTab(page) {
  console.log("Navigating to Orders tab...");
  await page.locator('md-tab-item:has(span:text("Orders"))').click();
  await page.waitForTimeout(1000);
  console.log("Orders tab clicked.");
}
export async function downloadOrderImage(page, downloadDir = "./downloads") {
  const fs = await import("fs");
  const path = await import("path");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  const pdfUrlPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("PDF URL not captured within 30s")),
      30000,
    );
    page.on("request", (request) => {
      const url = request.url();
      if (
        url.includes("s3.us-west-2.amazonaws.com") &&
        url.includes("X-Amz-Signature")
      ) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
  await page.locator('button[aria-label="view order image"]').click();
  console.log("Clicked order image button, waiting for S3 PDF request...");
  let saved = false;
  try {
    const pdfUrl = await pdfUrlPromise;
    console.log("Captured S3 URL:", pdfUrl.substring(0, 80) + "...");
    const https = await import("https");
    const filename = `order-${Date.now()}.pdf`;
    const filepath = path.join(downloadDir, filename);
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);
      https
        .get(pdfUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", (err) => {
          fs.unlink(filepath, () => {});
          reject(err);
        });
    });
    console.log("PDF saved to:", filepath);
    saved = true;
  } catch (err) {
    console.warn(
      "S3 interception failed:",
      err.message,
      "— falling back to CDP print...",
    );
  }
  if (!saved) {
    await page.waitForSelector(".react-pdf__Page__canvas", { timeout: 10000 });
    const client = await page.context().newCDPSession(page);
    const { data } = await client.send("Page.printToPDF", {
      printBackground: true,
      paperWidth: 8.5,
      paperHeight: 11,
    });
    const buffer = Buffer.from(data, "base64");
    const filename = `order-${Date.now()}.pdf`;
    const filepath = path.join(downloadDir, filename);
    fs.writeFileSync(filepath, buffer);
    console.log("PDF saved via CDP to:", filepath);
  }
  await page.locator('button[aria-label="close"]').click();
}
