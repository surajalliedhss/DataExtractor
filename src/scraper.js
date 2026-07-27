export async function navigateToPatients(page) {
  await page.waitForSelector('li[ui-sref="patients.list"]');
  await page.click('li[ui-sref="patients.list"]');
  await page.waitForURL((url) => url.toString().includes("/patients"), {
    timeout: 10000,
  });
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
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    }
  }
  console.warn(`No patient found with status "${status}"`);
}
export async function navigateToOrdersTab(page) {
  await page.locator('md-tab-item:has(span:text("Orders"))').click();
  await page.waitForTimeout(1000);
}
export async function downloadOrderImageFromButton(
  page,
  buttonLocator,
  downloadDir = "./downloads",
  filePrefix = "order",
) {
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
  await buttonLocator.click();
  let saved = false;
  try {
    const pdfUrl = await pdfUrlPromise;
    const https = await import("https");
    const filename = `${filePrefix}-${Date.now()}.pdf`;
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
    saved = true;
  } catch (err) {
    console.warn(
      "S3 interception failed:",
      err.message,
      "— falling back to CDP...",
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
    const filename = `${filePrefix}-${Date.now()}.pdf`;
    const filepath = path.join(downloadDir, filename);
    fs.writeFileSync(filepath, buffer);
  }
  const closeBtn = page.locator('button[aria-label="close"]');
  const closeBtnCount = await closeBtn.count();
  if (closeBtnCount > 0) {
    await closeBtn.click();
  }
}
export async function downloadOrderImage(page, downloadDir = "./downloads") {
  const fileBtn = page.locator('button[aria-label="view order image"]');
  await downloadOrderImageFromButton(page, fileBtn, downloadDir, "order");
}
export async function downloadPreviousOrders(
  page,
  baseUrl,
  downloadDir = "./downloads",
) {
  const fs = await import("fs");
  const path = await import("path");
  const prevHeader = page.locator("header.app-subheader", {
    hasText: "Previous Orders",
  });
  const headerCount = await prevHeader.count();
  if (headerCount === 0) {
    return;
  }
  const arrowIcons = page.locator(
    'td.md-cell-icon md-icon[ui-sref^="order.show"]',
  );
  const count = await arrowIcons.count();
  if (count === 0) return;
  const hrefs = [];
  for (let i = 0; i < count; i++) {
    const href = await arrowIcons.nth(i).getAttribute("href");
    if (href) {
      hrefs.push(href.startsWith("http") ? href : `${baseUrl}${href}`);
    }
  }
  for (let i = 0; i < hrefs.length; i++) {
    await page.goto(hrefs[i], { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const fileBtn = page.locator('button[aria-label="insert_drive_file"]');
    const isDisabled = await fileBtn.getAttribute("disabled");
    if (isDisabled !== null) {
      continue;
    }
    await downloadOrderImageFromButton(
      page,
      fileBtn,
      downloadDir,
      `prev-order-${i + 1}`,
    );
  }
}
