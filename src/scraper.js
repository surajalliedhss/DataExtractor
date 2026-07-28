import fs from "fs";
import path from "path";
import https from "https";

function extractOrderId(url) {
  const match = url.match(/\/orders\/(\d+)/);
  return match ? match[1] : `unknown-${Date.now()}`;
}

async function getRouteAndSchedule(page) {
  const routeEl = page.locator("td.order-medicine").nth(1);
  const route =
    (await routeEl.count()) > 0 ? (await routeEl.innerText()).trim() : "";

  const scheduleEl = page
    .locator('tr[ng-repeat*="administrationDetails"] dosage-information-react span')
    .first();
  const schedule =
    (await scheduleEl.count()) > 0
      ? (await scheduleEl.innerText()).trim()
      : "";

  return { route, schedule };
}

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

export async function getAllPatientsByStatus(page, baseUrl, status) {
  const patients = [];

  // Sort by Patient ID ascending
  const patientIdHeader = page.locator('th[md-order-by="identifier"]');
  await patientIdHeader.waitFor({ timeout: 15000 });

  await patientIdHeader.click();
  await page.waitForTimeout(1500);

  const sortIcon = patientIdHeader.locator("md-icon.md-sort-icon");
  let iconClass = await sortIcon.getAttribute("class").catch(() => "");
  if (iconClass.includes("md-desc") || !iconClass.includes("md-asc")) {
    await patientIdHeader.click();
    await page.waitForTimeout(1500);
  }

  iconClass = await sortIcon.getAttribute("class").catch(() => "");
  console.log(`Sort state: ${iconClass}`);

  // Change rows per page to 100
  const rowsSelect = page.locator('md-table-pagination md-select[aria-label^="Rows"]');
  await rowsSelect.click();
  await page.waitForTimeout(500);
  await page.locator('md-option[value="100"]').click();

  await page.waitForFunction(
    () => document.querySelectorAll('tr[ui-sref^="patient.edit.overview"]').length > 20,
    { timeout: 15000 }
  ).catch(() => {
    console.warn("Rows per page may not have changed — continuing with current count.");
  });

  await page.waitForTimeout(1000);

  let pageNumber = 1;

  while (true) {
    await page.waitForSelector('tr[ui-sref^="patient.edit.overview"]', { timeout: 15000 });

    const rowData = await page.$$eval(
      'tr[ui-sref^="patient.edit.overview"]',
      (rows) =>
        rows.map((row) => ({
          href: row.getAttribute("href") ?? "",
          status: row.querySelector('td[md-order-by="status"]')?.innerText?.trim() ?? "",
        }))
    );

    console.log(`Page ${pageNumber}: ${rowData.length} rows found.`);

    for (const { href, status: rowStatus } of rowData) {
      if (rowStatus.toLowerCase() === status.toLowerCase()) {
        if (!href) continue;
        const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
        const patientId = url.match(/\/patient\/(\d+)/)?.[1] ?? "unknown";
        patients.push({ patientId, url });
      }
    }

    const nextBtn = page.locator('button[aria-label="Next"]');
    const isDisabled = await nextBtn.getAttribute("disabled");
    if (isDisabled !== null) {
      console.log("No more pages.");
      break;
    }

    const firstRowHref = await page.$eval(
      'tr[ui-sref^="patient.edit.overview"]',
      (row) => row.getAttribute("href")
    );

    await nextBtn.click();

    await page.waitForFunction(
      (prevHref) => {
        const first = document.querySelector('tr[ui-sref^="patient.edit.overview"]');
        return first && first.getAttribute("href") !== prevHref;
      },
      firstRowHref,
      { timeout: 15000 }
    );

    await page.waitForTimeout(500);
    pageNumber++;
  }

  console.log(`Collected ${patients.length} patients with status "${status}".`);
  return patients;
}


export async function navigateToOrdersTab(page) {
  await page.locator('md-tab-item:has(span:text("Orders"))').click();
  await page.waitForTimeout(1000);
}

export async function downloadOrderImageFromButton(
  page,
  buttonLocator,
  downloadDir = "./downloads",
  orderId = `unknown-${Date.now()}`,
) {
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const filename = `${orderId}.pdf`;
  const filepath = path.join(downloadDir, filename);

  if (fs.existsSync(filepath)) {
    console.log(`Already downloaded, skipping: ${filename}`);
    return "Already Downloaded";
  }

  let saved = false;

  // Try S3 interception first
  try {
    const pdfUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("PDF URL not captured within 30s")),
        30000,
      );

      const onRequest = (request) => {
        const url = request.url();
        if (
          url.includes("s3.us-west-2.amazonaws.com") &&
          url.includes("X-Amz-Signature")
        ) {
          clearTimeout(timeout);
          page.off("request", onRequest); // clean up listener
          resolve(url);
        }
      };

      page.on("request", onRequest);

      buttonLocator.click().catch((err) => {
        clearTimeout(timeout);
        page.off("request", onRequest);
        reject(err);
      });
    });

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);
      https
        .get(pdfUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", (err) => {
          fs.unlink(filepath, () => { });
          reject(err);
        });
    });

    saved = true;
  } catch (err) {
    console.warn("S3 interception failed:", err.message, "— falling back to CDP...");
  }

  // CDP fallback
  if (!saved) {
    try {
      await page.waitForSelector(".react-pdf__Page__canvas", { timeout: 10000 });
      const client = await page.context().newCDPSession(page);
      const { data } = await client.send("Page.printToPDF", {
        printBackground: true,
        paperWidth: 8.5,
        paperHeight: 11,
      });
      fs.writeFileSync(filepath, Buffer.from(data, "base64"));
      saved = true;
    } catch (err) {
      console.warn("CDP fallback also failed:", err.message);
      return "Failed";
    }
  }

  if (!saved) return "Failed";

  console.log(`Saved: ${filepath}`);

  const closeBtn = page.locator('button[aria-label="close"]');
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click();
  }

  return "Downloaded";
}


export async function downloadOrderImage(page, baseUrl, downloadDir = "./downloads") {
  const results = [];

  const orderCard = page.locator("order-detail-react").first();
  const cardCount = await orderCard.count();

  if (cardCount > 0) {
    const fileBtn = page.locator('button[aria-label="view order image"]').first();
    const detailBtn = page.locator('button[aria-label="go to order detail"]').first();
    const fileBtnCount = await fileBtn.count();
    const isDisabled = fileBtnCount > 0 ? await fileBtn.getAttribute("disabled") : "disabled";

    if (fileBtnCount > 0 && isDisabled === null) {
      // Extract orderId from the card text before navigating
      const orderText = await page
        .locator("order-detail-react p.MuiTypography-body1")
        .first()
        .innerText({ timeout: 5000 })
        .catch(() => "");

      const match = orderText.match(/#(\d+)/);
      const orderId = match ? match[1] : `unknown-${Date.now()}`;

      // Download the PDF via the file button
      const downloadStatus = await downloadOrderImageFromButton(page, fileBtn, downloadDir, orderId);
      await page.waitForTimeout(1000);

      // Navigate inside order detail to get route, schedule, referral
      let route = "", schedule = "", referralData = {};
      if ((await detailBtn.count()) > 0) {
        await detailBtn.click();
        await page.waitForTimeout(2000);

        const rs = await getRouteAndSchedule(page);
        route = rs.route;
        schedule = rs.schedule;
        referralData = await getReferralData(page);

        await page.goBack();
        await page.waitForTimeout(1500);
      } else {
        // Fallback: get route/schedule from card directly
        const rs = await getRouteAndSchedule(page);
        route = rs.route;
        schedule = rs.schedule;
      }

      results.push({ orderId, route, schedule, downloadStatus, ...referralData });
    }
  }

  const previousOrders = await downloadPreviousOrders(page, baseUrl, downloadDir);
  results.push(...previousOrders);

  return results;
}


export async function downloadPreviousOrders(
  page,
  baseUrl,
  downloadDir = "./downloads",
) {
  const prevHeader = page.locator("header.app-subheader", {
    hasText: "Previous Orders",
  });
  if ((await prevHeader.count()) === 0) return [];

  const arrowIcons = page.locator(
    'td.md-cell-icon md-icon[ui-sref^="order.show"]',
  );
  const count = await arrowIcons.count();
  if (count === 0) return [];

  const hrefs = [];
  for (let i = 0; i < count; i++) {
    const href = await arrowIcons.nth(i).getAttribute("href");
    if (href) {
      hrefs.push(href.startsWith("http") ? href : `${baseUrl}${href}`);
    }
  }

  const results = [];

  for (const orderUrl of hrefs) {
    const orderId = extractOrderId(orderUrl);
    const filepath = path.join(downloadDir, `${orderId}.pdf`);

    if (fs.existsSync(filepath)) {
      console.log(`Already downloaded, skipping: ${orderId}.pdf`);
      results.push({ orderId, route: "", schedule: "", downloadStatus: "Already Downloaded" });
      continue;
    }

    await page.goto(orderUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    const fileBtn = page.locator('button[aria-label="insert_drive_file"]');
    if ((await fileBtn.getAttribute("disabled")) !== null) {
      results.push({ orderId, route: "", schedule: "", downloadStatus: "Skipped (no image)" });
      continue;
    }

    const { route, schedule } = await getRouteAndSchedule(page);
    const downloadStatus = await downloadOrderImageFromButton(page, fileBtn, downloadDir, orderId);

    results.push({ orderId, route, schedule, downloadStatus });
  }

  return results;
}

async function getReferralData(page) {
  const empty = {
    referralRequested: "", referralBy: "", referralPlan: "", referralStatus: "",
    referralDecisionReason: "", referralNumber: "", referralApproved: "",
    referralExpires: "", referralTreatments: "", approvedTreatments: "", treatmentsRemaining: "",
  };

  // Check if referrals card exists
  const referralCard = page.locator('md-card:has(h2:text("Referrals"))').first();
  if ((await referralCard.count()) === 0) return empty;

  // Get the most recent referral row (first row — already ordered by -requestedDate)
  const firstRow = referralCard.locator('tbody[md-body] tr[md-row]').first();
  if ((await firstRow.count()) === 0) return empty;

  const cells = firstRow.locator('td[md-cell]');

  const getCell = async (index) => {
    const cell = cells.nth(index);
    return (await cell.count()) > 0 ? (await cell.innerText()).trim() : "";
  };

  return {
    referralRequested: await getCell(0),  // Requested
    referralBy: await getCell(1),  // By
    referralPlan: await getCell(2),  // Plan
    referralStatus: await getCell(3),  // Status
    referralDecisionReason: await getCell(4),  // Decision Reason
    referralNumber: await getCell(5),  // Referral Number
    referralApproved: await getCell(6),  // Approved
    referralExpires: await getCell(7),  // Expires
    approvedTreatments: await getCell(8),  // Treatments Approved
    treatmentsRemaining: await getCell(9),  // Treatments Remaining
  };
}

export async function navigateToDocumentsTab(page) {
  // Try clicking Documents tab directly first
  const docTab = page.locator('md-tab-item:has(span:text("Documents"))');

  // If tab is hidden behind pagination arrow, click next until visible
  let attempts = 0;
  while ((await docTab.count()) === 0 || !(await docTab.isVisible())) {
    const nextBtn = page.locator('md-next-button[aria-label="Next Page"]');
    if ((await nextBtn.count()) === 0 || await nextBtn.getAttribute("aria-disabled") === "true") break;
    await nextBtn.click();
    await page.waitForTimeout(500);
    if (++attempts > 5) break;
  }

  await docTab.click();
  await page.waitForTimeout(1000);
}

export async function scrapeAndDownloadDocuments(page, patientId, downloadDir = "./downloads/documents") {
  const results = [];

  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const rows = page.locator('tbody[md-body] tr[md-row]');
  const count = await rows.count();
  if (count === 0) return results;

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const cells = row.locator('td[md-cell]');

    const receivedDate = (await cells.nth(0).innerText()).trim();
    const category = (await cells.nth(1).innerText()).trim();
    const from = (await cells.nth(2).innerText()).trim();
    const description = (await cells.nth(3).innerText()).trim();
    const enteredBy = (await cells.nth(4).innerText()).trim();
    const enteredDate = (await cells.nth(5).innerText()).trim();

    const fileBtn = cells.nth(6).locator('button[aria-label="insert_drive_file"]');
    let downloadStatus = "No File";
    let filename = "";

    if ((await fileBtn.count()) > 0) {
      const cleanDate = receivedDate.replace(/\//g, "-");
      const cleanCategory = category.replace(/[^a-zA-Z0-9-_]/g, "_").replace(/_+/g, "_");
      const slug = `${patientId}_${cleanDate}_${cleanCategory}`;
      filename = `${slug}.pdf`;
      const filepath = path.join(downloadDir, filename);

      if (fs.existsSync(filepath)) {
        downloadStatus = "Already Downloaded";
      } else {
        try {
          await fileBtn.click();
          await page.waitForSelector('div.md-dialog-container', { state: 'visible', timeout: 10000 });
          await page.waitForTimeout(500);

          const printLink = page.locator('button[aria-label="print"] a[href*="s3.us-west-2.amazonaws.com"]').first();
          const s3Url = await printLink.getAttribute("href");

          if (s3Url) {
            await new Promise((resolve, reject) => {
              const file = fs.createWriteStream(filepath);
              https.get(s3Url, (response) => {
                response.pipe(file);
                file.on("finish", () => file.close(resolve));
              }).on("error", (err) => {
                fs.unlink(filepath, () => { });
                reject(err);
              });
            });
            downloadStatus = "Downloaded";
            console.log(`Saved: ${filepath}`);
          } else {
            downloadStatus = "Failed";
            console.warn(`No S3 URL found for document ${slug}`);
          }
        } catch (err) {
          downloadStatus = "Failed";
          console.warn(`Failed to download document ${slug}:`, err.message);
        } finally {
          // Close button: aria-label is on md-icon child, not the button — use ng-click instead
          const closeBtn = page.locator('button[ng-click="vm.cancel()"]').first();
          if ((await closeBtn.count()) > 0) {
            await closeBtn.click();
          }

          // Wait for dialog container to detach
          await page.waitForSelector('div.md-dialog-container', { state: 'detached', timeout: 10000 })
            .catch(() => page.waitForTimeout(1000));

          await page.waitForTimeout(300);
        }
      }
    }

    results.push({
      patientId,
      receivedDate,
      category,
      from,
      description,
      enteredBy,
      enteredDate,
      filename,
      downloadStatus,
    });
  }

  return results;
}

