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
        if (existingOrderIds.has(String(order.orderId))) continue;

        const row = sheet.addRow({
            patientId: order.patientId ?? "",
            orderNumber: order.orderId,
            downloadedPdf: `${order.orderId}.pdf`,
            route: order.route ?? "",
            schedule: order.schedule ?? "",
            downloadStatus: order.downloadStatus ?? "",
            notes: "",
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
