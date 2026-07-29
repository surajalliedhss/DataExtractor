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

export async function navigateToAppointmentsTab(page) {
  const apptTab = page.locator('md-tab-item:has(span:text("Appointments"))');

  // Scroll through tab pagination if needed
  let attempts = 0;
  while ((await apptTab.count()) === 0 || !(await apptTab.isVisible())) {
    const nextBtn = page.locator('md-next-button[aria-label="Next Page"]');
    if ((await nextBtn.count()) === 0 || await nextBtn.getAttribute("aria-disabled") === "true") break;
    await nextBtn.click();
    await page.waitForTimeout(500);
    if (++attempts > 5) break;
  }

  await apptTab.click();
  await page.waitForTimeout(1500);
}

export async function scrapeCompletedAppointmentUrls(page, baseUrl) {
  const urls = [];

  const rows = page.locator('tbody[md-body] tr[md-row]');
  const count = await rows.count();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const cells = row.locator('td[md-cell]');

    // Status is column index 2
    const status = (await cells.nth(2).innerText()).trim();
    if (status !== "Complete") continue;

    // "View Completed Note" link is inside the menu — get href directly
    const viewLink = row.locator('a[aria-label="View Completed Note"]');
    if ((await viewLink.count()) === 0) {
      // Try opening the menu first
      const menuBtn = row.locator('button[aria-label="more_vert"]');
      if ((await menuBtn.count()) > 0) {
        await menuBtn.click();
        await page.waitForTimeout(300);
      }
    }

    const href = await viewLink.getAttribute("href").catch(() => null);
    if (href) {
      const fullUrl = href.startsWith("http") ? href : `${baseUrl}${href}`;
      // Extract appointment date from column 0 for reference
      const dateText = (await cells.nth(0).innerText()).trim().split("\n")[0];
      // Extract order ID from column 3
      const orderId = (await cells.nth(3).innerText()).trim();
      urls.push({ url: fullUrl, date: dateText, orderId });
    }

    // Close menu if it was opened
    const backdrop = page.locator('.md-backdrop');
    if ((await backdrop.count()) > 0) await backdrop.click();
  }

  return urls;
}

async function getIvAccessRow(page, tabLabelText) {
  const tabId = await page
    .locator('#iv-access-tabs md-tab-item', { hasText: tabLabelText })
    .first()
    .getAttribute('aria-controls', { timeout: 2000 })
    .catch(() => null);

  return tabId
    ? page.locator(`#${tabId} tbody tr[md-row]`).first()
    : page.locator('__no_tab_found__');
}

export async function scrapeTreatmentNote(page, patientId, appointmentUrl, baseUrl) {
  await page.goto(appointmentUrl, { waitUntil: "domcontentloaded" });

  // Wait for real data to land, not for the network to go fully quiet
  // (which may never happen) and not for a guessed fixed delay.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(
          'md-select[name="supervisingProvider"] .md-text'
        );
        if (!el) return false;
        const t = el.textContent.trim();
        return t.length > 0 && t !== "Loading providers...";
      },
      { timeout: 10000 }
    )
    .catch(() => { });

  const apptIdMatch = appointmentUrl.match(/\/appointment\/(\d+)\//);
  const appointmentId = apptIdMatch ? apptIdMatch[1] : "";

  // Everything below runs inside the browser in ONE call — no per-field round trips.
  const data = await page.evaluate(() => {
    const text = (el) => (el ? el.textContent.trim() : "");
    const val = (el) => (el ? el.value.trim() : "");

    function getDlText(root, ddText) {
      if (!root) return "";
      for (const dl of root.querySelectorAll("dl")) {
        const dd = Array.from(dl.querySelectorAll("dd")).find(
          (d) => d.textContent.trim() === ddText
        );
        if (dd) {
          const dt = dl.querySelector("dt");
          if (!dt) return "";
          const a = dt.querySelector("a");
          return (a ? a.textContent : dt.textContent).trim();
        }
      }
      return "";
    }

    function getDtBeforeDdText(ddText) {
      const dd = Array.from(document.querySelectorAll("dd")).find(
        (d) => d.textContent.trim() === ddText
      );
      if (!dd) return "";
      const dt = dd.previousElementSibling;
      return dt && dt.tagName === "DT" ? dt.textContent.trim() : "";
    }

    function getInputByLabelText(labelText) {
      const label = Array.from(document.querySelectorAll("label")).find((l) =>
        l.textContent.includes(labelText)
      );
      if (!label) return "";
      const container = label.closest(".MuiFormControl-root") || label.parentElement;
      return val(container ? container.querySelector("input") : null);
    }

    function getTabPanelRow(labelText) {
      const tabItem = Array.from(
        document.querySelectorAll("#iv-access-tabs md-tab-item")
      ).find((t) => t.textContent.includes(labelText));
      if (!tabItem) return null;
      const controls = tabItem.getAttribute("aria-controls");
      const panel = controls ? document.getElementById(controls) : null;
      return panel ? panel.querySelector("tbody tr[md-row]") : null;
    }

    function rowCell(row, index) {
      if (!row) return "";
      return text(row.querySelectorAll("td")[index]);
    }

    // Generic reader for the three "light-table" prep tables (main vial
    // selection, Diluent Selection, Mixed In). Maps header text -> cell text
    // for whichever row actually has Qty > 0 (the row that was really used),
    // falling back to the first row if none has a positive qty.
    function getPrepTableRow(tableEl) {
      if (!tableEl) return {};
      const headers = Array.from(tableEl.querySelectorAll("thead th"))
        .map((th) => th.textContent.trim())
        .filter(Boolean);
      const qtyIdx = headers.indexOf("Qty");
      const rows = Array.from(tableEl.querySelectorAll("tbody tr"));

      const readQty = (row) => {
        const cell = row.querySelectorAll("td")[qtyIdx];
        if (!cell) return NaN;
        const input = cell.querySelector("input");
        return parseFloat(input ? input.value : cell.textContent);
      };

      let chosen = rows.find((row) => {
        const q = readQty(row);
        return !isNaN(q) && q > 0;
      });
      if (!chosen) chosen = rows[0];
      if (!chosen) return {};

      const cells = chosen.querySelectorAll("td");
      const result = {};
      headers.forEach((h, i) => {
        const cell = cells[i];
        if (!cell) { result[h] = ""; return; }
        const input = cell.querySelector("input");
        result[h] = (input ? input.value : cell.textContent).trim();
      });
      return result;
    }

    // Allergies card (MUI data grid) — can list zero, one, or many allergens.
    function getAllergies() {
      const header = Array.from(document.querySelectorAll(".MuiCardHeader-title")).find(
        (h) => h.textContent.trim() === "Allergies"
      );
      if (!header) return [];
      const card = header.closest(".MuiPaper-root");
      if (!card) return [];
      const cells = card.querySelectorAll('[data-field="allergen"]');
      return Array.from(cells)
        .map((c) => {
          const content = c.querySelector(".MuiDataGrid-cellContent");
          return (content ? content.textContent : c.textContent).trim();
        })
        .filter(Boolean);
    }

    // Oral Medication card can have zero, one, or many rows (one per med given).
    function getOralMedications() {
      const card = Array.from(document.querySelectorAll("md-card")).find((c) => {
        const h2 = c.querySelector("h2");
        return h2 && h2.textContent.includes("Oral Medication");
      });
      if (!card) return [];
      const rows = card.querySelectorAll("tbody tr");
      return Array.from(rows).map((row) => {
        const cells = row.querySelectorAll("td");
        return {
          time: text(cells[0]),
          medication: text(cells[1]),
          dosage: text(cells[2]),
          qty: text(cells[3]),
          lot: text(cells[4]),
          expiration: text(cells[5]),
          administered: text(cells[6]),
        };
      });
    }

    // Narrative log (MUI data grid) can have zero, one, or many entries.
    function getNarrativeEntries() {
      const grid = document.querySelector(
        "treatment-narrative-log-react [role='grid']"
      );
      if (!grid) return [];
      const rows = grid.querySelectorAll("[role='row'][data-rowindex]");
      return Array.from(rows).map((row) => {
        const userSpan = row.querySelector('[data-field="createdByUserName"] span');
        const narrativeSpan = row.querySelector('[data-field="narrative"] span');
        const createdSpan = row.querySelector('[data-field="createdAt"] span');
        const updatedSpan = row.querySelector('[data-field="updatedAt"] span');

        const createdDate = createdSpan ? createdSpan.textContent.trim() : "";
        const createdTime = createdSpan ? createdSpan.getAttribute("aria-label") || "" : "";
        const updatedDate = updatedSpan ? updatedSpan.textContent.trim() : "";
        const updatedTime = updatedSpan ? updatedSpan.getAttribute("aria-label") || "" : "";

        return {
          user: userSpan
            ? (userSpan.getAttribute("aria-label") || userSpan.textContent).trim()
            : "",
          narrative: narrativeSpan ? narrativeSpan.textContent.trim() : "",
          created: [createdDate, createdTime].filter(Boolean).join(" "),
          updated: [updatedDate, updatedTime].filter(Boolean).join(" "),
        };
      });
    }

    const orderSummary = document.querySelector("order-summary");

    const supervisingProvider = text(
      document.querySelector('md-select[name="supervisingProvider"] .md-text')
    );
    const orderNumber = text(orderSummary?.querySelector("h2.flex"));
    const orderingProvider = getDlText(orderSummary, "Ordering Provider");
    const orderDate = getDlText(orderSummary, "Order Date");
    const orderExpires = getDlText(orderSummary, "Order Expires");
    const primaryDx = getDlText(orderSummary, "Primary Dx");
    const orderNotes = getDlText(orderSummary, "Notes");
    const medName = text(orderSummary?.querySelector("td.order-medicine:first-of-type"));
    const medRoute = text(orderSummary?.querySelector("td.order-medicine:nth-of-type(2)"));
    const medSchedule = text(orderSummary?.querySelector("dosage-information-react span"));
    const calcDose = text(orderSummary?.querySelector("td.md-cell-right-align"));

    const arrivalRow = document.querySelector('treatment-vital[type="arrival"] tbody tr');
    const arrivalTime = rowCell(arrivalRow, 0);
    const arrivalTemp = rowCell(arrivalRow, 1);
    const arrivalBP = rowCell(arrivalRow, 2);
    const arrivalHR = rowCell(arrivalRow, 3);
    const arrivalR = rowCell(arrivalRow, 4);
    const arrivalSpO2 = rowCell(arrivalRow, 5);

    const weightLbs = getInputByLabelText("Patient Weight (lbs)");
    const weightKgs = getInputByLabelText("Patient Weight (kgs)");
    const heightIn = getInputByLabelText("Patient Height (in)");
    const heightCm = getInputByLabelText("Patient Height (cm)");
    const lastKnownWeight = getInputByLabelText("Last Known");

    const treatmentHistory = Array.from(
      document.querySelectorAll("treatment-history tbody tr[md-row]")
    ).map((row) => {
      const cells = row.querySelectorAll("td");
      return {
        date: text(cells[0]),
        med: text(cells[1]),
        dosage: text(cells[2]),
        weight: text(cells[3]),
        staff: text(cells[4]),
      };
    });

    const pivRow = getTabPanelRow("PIV");
    const piccRow = getTabPanelRow("PICC/CVC");
    const portRow = getTabPanelRow("PORT");
    const oralMeds = getOralMedications();

    const flushCard = Array.from(document.querySelectorAll("md-card")).find((c) => {
      const h2 = c.querySelector("h2");
      return h2 && h2.textContent.includes("Line Flush");
    });
    const flushRow = flushCard ? flushCard.querySelector("tbody tr") : null;

    const adminTbodies = document.querySelectorAll("med-admin table.flush-table tbody");
    const startTr = adminTbodies[0] ? adminTbodies[0].querySelector("tr") : null;
    const stopTr = adminTbodies[1] ? adminTbodies[1].querySelector("tr") : null;
    const adminStart = rowCell(startTr, 0);
    const adminRate = rowCell(startTr, 2);
    const adminStop = rowCell(stopTr, 0);
    // No vital on a row collapses 5 columns into one <td colspan="5">,
    // so Stop row is Time(0) Event(1) Rate(2) Vitals(3) Staff(4) Infusion(5).
    const infusionDuration = rowCell(stopTr, 5);

    const departRow = document.querySelector('treatment-vital[type="departure"] tbody tr');
    const departTime = rowCell(departRow, 0);
    const departTemp = rowCell(departRow, 1);
    const departBP = rowCell(departRow, 2);
    const departHR = rowCell(departRow, 3);
    const departR = rowCell(departRow, 4);
    const departSpO2 = rowCell(departRow, 5);
    const departInitials = rowCell(departRow, 6);
    const timeInOffice = getDtBeforeDdText("Time in Office");
    const departureTime = val(document.querySelector('input[name="departureTime"]'));

    const narrativeEntries = getNarrativeEntries();

    const allergies = getAllergies().join(", ");

    // An appointment can prep multiple medications, each its own <med-prep>
    // component with its own vial / Diluent Selection / Mixed In tables.
    // Read every <med-prep> block and keep values positionally aligned
    // across medications (position 1 = med #1 everywhere, etc.).
    const medPrepEls = Array.from(document.querySelectorAll("med-prep"));

    const preps = medPrepEls.map((medPrepEl) => {
      const prepTables = medPrepEl.querySelectorAll("table.light-table");
      const mainPrepRow = getPrepTableRow(prepTables[0]);
      const diluentRow = getPrepTableRow(prepTables[1]);
      const mixedInRow = getPrepTableRow(prepTables[2]);

      return {
        prepMed: text(medPrepEl.querySelector("h2.flex")),
        medicationType: text(medPrepEl.querySelector("span.chip.specialty")),
        prepQty: mainPrepRow["Qty"] || "",
        prepVial: mainPrepRow["Vial"] || "",
        prepNDC: mainPrepRow["NDC"] || "",
        prepLot: mainPrepRow["Lot"] || "",
        prepExp: mainPrepRow["Exp"] || "",
        prepDiluentQty: diluentRow["Qty"] || "",
        prepDiluent: diluentRow["Diluent"] || "",
        prepDiluentNDC: diluentRow["NDC"] || "",
        prepDiluentLot: diluentRow["Lot"] || "",
        prepDiluentExp: diluentRow["Exp"] || "",
        prepMixedInQty: mixedInRow["Qty"] || "",
        prepMixedInFluid: mixedInRow["Fluid"] || "",
        prepMixedInNDC: mixedInRow["NDC"] || "",
        prepMixedInLot: mixedInRow["Lot"] || "",
        prepMixedInExp: mixedInRow["Exp"] || "",
      };
    });

    const joinPreps = (key) => preps.map((p) => p[key]).filter((v) => v !== "").join(", ");

    const prepMed = joinPreps("prepMed");
    const medicationType = joinPreps("medicationType");
    const prepQty = joinPreps("prepQty");
    const prepVial = joinPreps("prepVial");
    const prepNDC = joinPreps("prepNDC");
    const prepLot = joinPreps("prepLot");
    const prepExp = joinPreps("prepExp");
    const prepDiluentQty = joinPreps("prepDiluentQty");
    const prepDiluent = joinPreps("prepDiluent");
    const prepDiluentNDC = joinPreps("prepDiluentNDC");
    const prepDiluentLot = joinPreps("prepDiluentLot");
    const prepDiluentExp = joinPreps("prepDiluentExp");
    const prepMixedInQty = joinPreps("prepMixedInQty");
    const prepMixedInFluid = joinPreps("prepMixedInFluid");
    const prepMixedInNDC = joinPreps("prepMixedInNDC");
    const prepMixedInLot = joinPreps("prepMixedInLot");
    const prepMixedInExp = joinPreps("prepMixedInExp");

    return {
      supervisingProvider, orderNumber, orderingProvider, orderDate, orderExpires,
      primaryDx, orderNotes, medName, medRoute, medSchedule, calcDose,
      arrivalTime, arrivalTemp, arrivalBP, arrivalHR, arrivalR, arrivalSpO2,
      weightLbs, weightKgs, heightIn, heightCm, lastKnownWeight, treatmentHistory,
      pivStatus: rowCell(pivRow, 0), pivTime: rowCell(pivRow, 2),
      pivCatheter: rowCell(pivRow, 3), pivVein: rowCell(pivRow, 4),
      pivLocation: rowCell(pivRow, 5), pivPatent: rowCell(pivRow, 6),
      pivStaff: rowCell(pivRow, 7),
      piccStatus: rowCell(piccRow, 0), piccLineType: rowCell(piccRow, 1),
      piccArmCircumference: rowCell(piccRow, 2), piccLocation: rowCell(piccRow, 3),
      piccBloodReturn: rowCell(piccRow, 4), piccFlushOk: rowCell(piccRow, 5),
      piccLastDressingChange: rowCell(piccRow, 6),
      piccDressingChangedToday: rowCell(piccRow, 7),
      portStatus: rowCell(portRow, 0), portLocation: rowCell(portRow, 1),
      portNeedleSize: rowCell(portRow, 2), portNeedleLength: rowCell(portRow, 3),
      portBloodReturn: rowCell(portRow, 4), portFlushOk: rowCell(portRow, 5),
      portLastDressingChange: rowCell(portRow, 6), portMaintToday: rowCell(portRow, 7),
      flushTime: rowCell(flushRow, 0), flushType: rowCell(flushRow, 1),
      flushLot: rowCell(flushRow, 2), flushQty: rowCell(flushRow, 3),
      adminStart, adminStop, adminRate, infusionDuration,
      departTime, departTemp, departBP, departHR, departR, departSpO2,
      departInitials, timeInOffice, departureTime, allergies, medicationType,
      prepMed, prepVial, prepNDC, prepLot, prepExp,
      prepDiluentQty, prepDiluent, prepDiluentNDC, prepDiluentLot, prepDiluentExp,
      prepMixedInQty, prepMixedInFluid, prepMixedInNDC, prepMixedInLot, prepMixedInExp,
      omTime: oralMeds.map((m) => m.time).filter(Boolean).join(", "),
      omMedication: oralMeds.map((m) => m.medication).filter(Boolean).join(", "),
      omDosage: oralMeds.map((m) => m.dosage).filter(Boolean).join(", "),
      omQty: oralMeds.map((m) => m.qty).filter(Boolean).join(", "),
      omLot: oralMeds.map((m) => m.lot).filter(Boolean).join(", "),
      omExpiration: oralMeds.map((m) => m.expiration).filter(Boolean).join(", "),
      omAdministered: oralMeds.map((m) => m.administered).filter(Boolean).join(", "),
      narrativeUser: narrativeEntries.map((n, i) => `(${i + 1}) ${n.user}`).join(" | "),
      narrativeText: narrativeEntries.map((n, i) => `(${i + 1}) ${n.narrative}`).join(" | "),
      narrativeCreated: narrativeEntries.map((n, i) => `(${i + 1}) ${n.created}`).join(" | "),
      narrativeUpdated: narrativeEntries.map((n, i) => `(${i + 1}) ${n.updated}`).join(" | "),
    };
  });
  return {
    patientId,
    appointmentId,
    appointmentDate: appointmentUrl, // overridden by caller with the appointments-list date
    supervisingProvider: data.supervisingProvider,
    orderNumber: data.orderNumber.replace(/\n.*/g, "").trim(),
    orderingProvider: data.orderingProvider,
    orderDate: data.orderDate,
    orderExpires: data.orderExpires,
    primaryDx: data.primaryDx,
    orderNotes: data.orderNotes,
    medication: data.medName,
    route: data.medRoute,
    schedule: data.medSchedule,
    calculatedDose: data.calcDose,
    arrivalTime: data.arrivalTime,
    arrivalTemp: data.arrivalTemp,
    arrivalBP: data.arrivalBP,
    arrivalHR: data.arrivalHR,
    arrivalR: data.arrivalR,
    arrivalSpO2: data.arrivalSpO2,
    weightLbs: data.weightLbs,
    weightKgs: data.weightKgs,
    heightIn: data.heightIn,
    heightCm: data.heightCm,
    lastKnownWeight: data.lastKnownWeight,
    treatmentHistory: data.treatmentHistory
      .map((h) => `${h.date}: ${h.med} ${h.dosage} (${h.staff})`)
      .join(" | "),
    pivStatus: data.pivStatus,
    pivTime: data.pivTime,
    pivCatheter: data.pivCatheter,
    pivVein: data.pivVein,
    pivLocation: data.pivLocation,
    pivPatent: data.pivPatent,
    pivStaff: data.pivStaff,
    piccStatus: data.piccStatus,
    piccLineType: data.piccLineType,
    piccArmCircumference: data.piccArmCircumference,
    piccLocation: data.piccLocation,
    piccBloodReturn: data.piccBloodReturn,
    piccFlushOk: data.piccFlushOk,
    piccLastDressingChange: data.piccLastDressingChange,
    piccDressingChangedToday: data.piccDressingChangedToday,
    portStatus: data.portStatus,
    portLocation: data.portLocation,
    portNeedleSize: data.portNeedleSize,
    portNeedleLength: data.portNeedleLength,
    portBloodReturn: data.portBloodReturn,
    portFlushOk: data.portFlushOk,
    portLastDressingChange: data.portLastDressingChange,
    portMaintToday: data.portMaintToday,
    flushTime: data.flushTime,
    flushType: data.flushType,
    flushLot: data.flushLot,
    flushQty: data.flushQty,
    adminStart: data.adminStart,
    adminStop: data.adminStop,
    adminRate: data.adminRate,
    infusionDuration: data.infusionDuration,
    departureTime: data.departureTime,
    departTime: data.departTime,
    departTemp: data.departTemp,
    departBP: data.departBP,
    departHR: data.departHR,
    departR: data.departR,
    departSpO2: data.departSpO2,
    departInitials: data.departInitials,
    timeInOffice: data.timeInOffice,
    allergies: data.allergies,
    medicationType: data.medicationType,
    prepMed: data.prepMed,
    prepQty: data.prepQty,
    prepVial: data.prepVial,
    prepNDC: data.prepNDC,
    prepLot: data.prepLot,
    prepExp: data.prepExp,
    prepDiluentQty: data.prepDiluentQty,
    prepDiluent: data.prepDiluent,
    prepDiluentNDC: data.prepDiluentNDC,
    prepDiluentLot: data.prepDiluentLot,
    prepDiluentExp: data.prepDiluentExp,
    prepMixedInQty: data.prepMixedInQty,
    prepMixedInFluid: data.prepMixedInFluid,
    prepMixedInNDC: data.prepMixedInNDC,
    prepMixedInLot: data.prepMixedInLot,
    prepMixedInExp: data.prepMixedInExp,
    omTime: data.omTime,
    omMedication: data.omMedication,
    omDosage: data.omDosage,
    omQty: data.omQty,
    omLot: data.omLot,
    omExpiration: data.omExpiration,
    omAdministered: data.omAdministered,
    narrativeUser: data.narrativeUser,
    narrativeText: data.narrativeText,
    narrativeCreated: data.narrativeCreated,
    narrativeUpdated: data.narrativeUpdated,
  };
}
