import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";

const STATUS_COLORS = {
    "Downloaded": "FF90EE90",
    "Already Downloaded": "FFD3D3D3",
    "Skipped (no image)": "FFFFD700",
    "Failed": "FFFF6B6B",
    "No Orders Found": "FFFFA500",
};

export async function createOrdersExcel(orders, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();

    // Load existing file if it exists, otherwise start fresh
    if (fs.existsSync(filepath)) {
        await workbook.xlsx.readFile(filepath);
    }

    let sheet = workbook.getWorksheet("Orders");
    if (!sheet) {
        sheet = workbook.addWorksheet("Orders");
        sheet.columns = [
            { header: "Patient ID", key: "patientId", width: 15 },
            { header: "Order Number", key: "orderNumber", width: 18 },
            { header: "Downloaded PDF", key: "downloadedPdf", width: 22 },
            { header: "Route", key: "route", width: 15 },
            { header: "Schedule", key: "schedule", width: 30 },
            { header: "Download Status", key: "downloadStatus", width: 22 },
            { header: "Notes", key: "notes", width: 25 },
            { header: "ReferralRequested", key: "referralRequested", width: 20 },
            { header: "ReferralBy", key: "referralBy", width: 20 },
            { header: "ReferralPlan", key: "referralPlan", width: 20 },
            { header: "ReferralStatus", key: "referralStatus", width: 20 },
            { header: "ReferralDecision Reason", key: "referralDecisionReason", width: 25 },
            { header: "Referral Number", key: "referralNumber", width: 18 },
            { header: "ReferralApproved", key: "referralApproved", width: 20 },
            { header: "ReferralExpires", key: "referralExpires", width: 20 },
            { header: "ReferralTreatments", key: "referralTreatments", width: 22 },
            { header: "Approved Treatments", key: "approvedTreatments", width: 22 },
            { header: "Treatments Remaining", key: "treatmentsRemaining", width: 22 },
        ];

        sheet.getRow(1).font = { bold: true };
    }

    // Build a set of already-logged order IDs to avoid duplicate rows
    const existingOrderIds = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const orderNum = row.getCell(2).value;
        if (orderNum) existingOrderIds.add(String(orderNum));
    });

    let added = 0;
    for (const order of orders) {
        if (!order) continue;
        if (!order.orderId) {
            console.warn("Skipping order with missing orderId:", order);
            continue;
        }
        if (existingOrderIds.has(String(order.orderId))) continue;

        const row = sheet.addRow({
            patientId: order.patientId ?? "",
            orderNumber: order.orderId,
            downloadedPdf: `${order.orderId}.pdf`,
            route: order.route ?? "",
            schedule: order.schedule ?? "",
            downloadStatus: order.downloadStatus ?? "",
            notes: "",
            referralRequested: order.referralRequested ?? "",
            referralBy: order.referralBy ?? "",
            referralPlan: order.referralPlan ?? "",
            referralStatus: order.referralStatus ?? "",
            referralDecisionReason: order.referralDecisionReason ?? "",
            referralNumber: order.referralNumber ?? "",
            referralApproved: order.referralApproved ?? "",
            referralExpires: order.referralExpires ?? "",
            referralTreatments: order.referralTreatments ?? "",
            approvedTreatments: order.approvedTreatments ?? "",
            treatmentsRemaining: order.treatmentsRemaining ?? "",
        });


        const color = STATUS_COLORS[order.downloadStatus];
        if (color) {
            row.getCell(6).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: color },
            };
        }

        added++;
    }

    await workbook.xlsx.writeFile(filepath);
    console.log(`Excel updated: ${added} new rows added. File: ${filepath}`);
}

export async function updateDocumentsExcel(documents, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();

    if (fs.existsSync(filepath)) {
        await workbook.xlsx.readFile(filepath);
    }

    let sheet = workbook.getWorksheet("Documents");
    if (!sheet) {
        sheet = workbook.addWorksheet("Documents");
        sheet.columns = [
            { header: "Patient ID", key: "patientId", width: 15 },
            { header: "Received Date", key: "receivedDate", width: 18 },
            { header: "Category", key: "category", width: 25 },
            { header: "From", key: "from", width: 20 },
            { header: "Description", key: "description", width: 35 },
            { header: "Entered By", key: "enteredBy", width: 15 },
            { header: "Entered Date", key: "enteredDate", width: 18 },
            { header: "File", key: "filename", width: 30 },
            { header: "Download Status", key: "downloadStatus", width: 22 },
        ];
        sheet.getRow(1).font = { bold: true };
    }

    // Dedup by patientId + receivedDate + description
    const existingKeys = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const key = `${row.getCell(1).value}|${row.getCell(2).value}|${row.getCell(5).value}`;
        existingKeys.add(key);
    });

    let added = 0;
    for (const doc of documents) {
        const key = `${doc.patientId}|${doc.receivedDate}|${doc.description}`;
        if (existingKeys.has(key)) continue;

        const row = sheet.addRow(doc);

        const color = STATUS_COLORS[doc.downloadStatus];
        if (color) {
            row.getCell(9).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: color },
            };
        }

        added++;
    }

    await workbook.xlsx.writeFile(filepath);
    console.log(`Documents sheet updated: ${added} new rows added.`);
}
