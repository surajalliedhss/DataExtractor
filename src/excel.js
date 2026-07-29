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

export async function updateTreatmentNotesExcel(notes, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();
    if (fs.existsSync(filepath)) await workbook.xlsx.readFile(filepath);

    let sheet = workbook.getWorksheet("TreatmentNotes");
    if (!sheet) {
        sheet = workbook.addWorksheet("TreatmentNotes");
        sheet.columns = [
            { header: "Patient ID", key: "patientId", width: 15 },
            { header: "Appointment ID", key: "appointmentId", width: 18 },
            { header: "Appointment Date", key: "appointmentDate", width: 22 },
            { header: "Supervising Provider", key: "supervisingProvider", width: 25 },
            { header: "Order Number", key: "orderNumber", width: 20 },
            { header: "Ordering Provider", key: "orderingProvider", width: 25 },
            { header: "Order Date", key: "orderDate", width: 15 },
            { header: "Order Expires", key: "orderExpires", width: 15 },
            { header: "Primary Dx", key: "primaryDx", width: 35 },
            { header: "Order Notes", key: "orderNotes", width: 30 },
            { header: "Medication", key: "medication", width: 18 },
            { header: "Route", key: "route", width: 12 },
            { header: "Schedule", key: "schedule", width: 25 },
            { header: "Calculated Dose", key: "calculatedDose", width: 15 },
            { header: "Arrival Time", key: "arrivalTime", width: 12 },
            { header: "Arrival Temp", key: "arrivalTemp", width: 12 },
            { header: "Arrival BP", key: "arrivalBP", width: 12 },
            { header: "Arrival HR", key: "arrivalHR", width: 12 },
            { header: "Arrival R", key: "arrivalR", width: 10 },
            { header: "Arrival SpO2", key: "arrivalSpO2", width: 12 },
            { header: "Weight (lbs)", key: "weightLbs", width: 12 },
            { header: "Weight (kgs)", key: "weightKgs", width: 12 },
            { header: "Height (in)", key: "heightIn", width: 12 },
            { header: "Height (cm)", key: "heightCm", width: 12 },
            { header: "Last Known Weight", key: "lastKnownWeight", width: 18 },
            { header: "Treatment History", key: "treatmentHistory", width: 50 },
            { header: "PIV Status", key: "pivStatus", width: 12 },
            { header: "PIV Time", key: "pivTime", width: 12 },
            { header: "PIV Catheter", key: "pivCatheter", width: 20 },
            { header: "PIV Vein", key: "pivVein", width: 18 },
            { header: "PIV Location", key: "pivLocation", width: 12 },
            { header: "PIV Patent", key: "pivPatent", width: 10 },
            { header: "PIV Staff", key: "pivStaff", width: 12 },
            { header: "PICC Status", key: "piccStatus", width: 12 },
            { header: "PICC Line Type", key: "piccLineType", width: 16 },
            { header: "PICC Arm Circumference", key: "piccArmCircumference", width: 18 },
            { header: "PICC Location", key: "piccLocation", width: 14 },
            { header: "PICC Blood Return", key: "piccBloodReturn", width: 14 },
            { header: "PICC Flush OK", key: "piccFlushOk", width: 14 },
            { header: "PICC Last Dressing Change", key: "piccLastDressingChange", width: 20 },
            { header: "PICC Dressing Changed Today", key: "piccDressingChangedToday", width: 20 },
            { header: "PORT Status", key: "portStatus", width: 12 },
            { header: "PORT Location", key: "portLocation", width: 14 },
            { header: "PORT Needle Size", key: "portNeedleSize", width: 14 },
            { header: "PORT Needle Length", key: "portNeedleLength", width: 16 },
            { header: "PORT Blood Return", key: "portBloodReturn", width: 14 },
            { header: "PORT Flush OK", key: "portFlushOk", width: 14 },
            { header: "PORT Last Dressing Change", key: "portLastDressingChange", width: 20 },
            { header: "PORT Maint Today", key: "portMaintToday", width: 14 },
            { header: "OM Time", key: "omTime", width: 20 },
            { header: "OM Medication", key: "omMedication", width: 25 },
            { header: "OM Dosage", key: "omDosage", width: 20 },
            { header: "OM Qty", key: "omQty", width: 14 },
            { header: "OM Lot", key: "omLot", width: 18 },
            { header: "OM Expiration", key: "omExpiration", width: 18 },
            { header: "OM Administered", key: "omAdministered", width: 22 },
            { header: "Flush Time", key: "flushTime", width: 12 },
            { header: "Flush Type", key: "flushType", width: 18 },
            { header: "Flush Lot", key: "flushLot", width: 14 },
            { header: "Flush Qty", key: "flushQty", width: 10 },
            { header: "Admin Start", key: "adminStart", width: 12 },
            { header: "Admin Stop", key: "adminStop", width: 12 },
            { header: "Admin Rate", key: "adminRate", width: 12 },
            { header: "Infusion Duration", key: "infusionDuration", width: 15 },
            { header: "Departure Time", key: "departureTime", width: 15 },
            { header: "Depart Vital Time", key: "departTime", width: 15 },
            { header: "Depart BP", key: "departBP", width: 12 },
            { header: "Depart HR", key: "departHR", width: 12 },
            { header: "Depart SpO2", key: "departSpO2", width: 12 },
            { header: "Depart Temp", key: "departTemp", width: 12 },
            { header: "Depart R", key: "departR", width: 10 },
            { header: "Depart Initials", key: "departInitials", width: 14 },
            { header: "Time in Office", key: "timeInOffice", width: 15 },
            { header: "Prep Medication", key: "prepMed", width: 20 },
            { header: "Prep Vial", key: "prepVial", width: 25 },
            { header: "Prep NDC", key: "prepNDC", width: 15 },
            { header: "Prep Lot", key: "prepLot", width: 15 },
            { header: "Prep Exp", key: "prepExp", width: 15 },
            { header: "Narrative User", key: "narrativeUser", width: 30 },
            { header: "Narrative Text", key: "narrativeText", width: 60 },
            { header: "Narrative Created", key: "narrativeCreated", width: 22 },
            { header: "Narrative Updated", key: "narrativeUpdated", width: 22 },
        ];
        sheet.getRow(1).font = { bold: true };
    }

    // Dedup by patientId + appointmentId
    const existingKeys = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        existingKeys.add(`${row.getCell(1).value}|${row.getCell(2).value}`);
    });

    let added = 0;
    for (const note of notes) {
        const key = `${note.patientId}|${note.appointmentId}`;
        if (existingKeys.has(key)) continue;
        sheet.addRow(note);
        added++;
    }

    await workbook.xlsx.writeFile(filepath);
    console.log(`TreatmentNotes sheet updated: ${added} new rows added.`);
}
