import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import { log, fileFingerprint } from "./logger.js";
import { loadLedger, saveLedger } from "./rowcount-ledger.js";

const STATUS_COLORS = {
    "Downloaded": "FF90EE90",
    "Already Downloaded": "FFD3D3D3",
    "Skipped (no image)": "FFFFD700",
    "Failed": "FFFF6B6B",
    "No Orders Found": "FFFFA500",
};

async function atomicWrite(workbook, filepath) {
    const tmpPath = `${filepath}.tmp-${process.pid}-${Date.now()}`;
    log.info(`atomicWrite: writing temp file ${tmpPath}`);
    await workbook.xlsx.writeFile(tmpPath);
    log.info(`atomicWrite: temp written — ${fileFingerprint(tmpPath)}`);
    fs.renameSync(tmpPath, filepath);
    log.info(`atomicWrite: renamed -> ${filepath} — ${fileFingerprint(filepath)}`);
}

async function safeReadOrCreate(workbook, filepath, sheetLabel) {
    log.info(`${sheetLabel}: file before read — ${fileFingerprint(filepath)}`);
    if (fs.existsSync(filepath)) {
        try {
            const t0 = Date.now();
            await workbook.xlsx.readFile(filepath);
            log.info(`${sheetLabel}: readFile OK in ${Date.now() - t0}ms`);
        } catch (err) {
            log.error(`${sheetLabel}: readFile FAILED — ${err.message}\n${err.stack}`);
            throw new Error(
                `orders.xlsx exists but failed to parse (${err.message}). Aborting write to avoid wiping existing data.`
            );
        }
    } else {
        log.warn(`${sheetLabel}: no existing file at ${filepath} — starting new workbook`);
    }
}

function checkAgainstLedger(sheetLabel, ledger, ledgerKey, rowCountFromRead) {
    const ledgerCount = ledger[ledgerKey] ?? null;
    log.info(
        `${sheetLabel}: rows from this read = ${rowCountFromRead}, ` +
        `rows per ledger = ${ledgerCount === null ? "no baseline yet" : ledgerCount}`
    );
    if (ledgerCount !== null && rowCountFromRead < ledgerCount) {
        log.error(
            `${sheetLabel}: MISMATCH — read shows ${rowCountFromRead} rows but ledger last recorded ${ledgerCount}. ` +
            `The read returned less data than was previously confirmed saved — likely a bad/partial read.`
        );
        throw new Error(
            `${sheetLabel}: read returned ${rowCountFromRead} rows but ${ledgerCount} were previously saved. Refusing to write.`
        );
    }
}

export async function createOrdersExcel(orders, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();

    if (fs.existsSync(path.resolve("downloads"))) {
        console.log(
            "downloads folder:",
            fs.readdirSync(path.resolve("downloads"))
        );
    }
    log.info(`createOrdersExcel: called with ${orders.length} candidate rows`);
    await safeReadOrCreate(workbook, filepath, "createOrdersExcel");

    let sheet = workbook.getWorksheet("Orders");

    if (!sheet) {
        log.warn(`createOrdersExcel: "Orders" worksheet not found — creating new one`);
        sheet = workbook.addWorksheet("Orders");
    } else {
        log.info(`createOrdersExcel: found existing "Orders" worksheet`);
    }

    // ALWAYS restore the column definitions after reading the workbook
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
        { header: "Weight (lbs)", key: "weightLbs", width: 15 },
        { header: "Weight (kgs)", key: "weightKgs", width: 15 },
        { header: "Height (in)", key: "heightIn", width: 15 },
        { header: "Height (cm)", key: "heightCm", width: 15 },
    ];

    sheet.getRow(1).font = { bold: true };

    const priorRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;

    const ledger = loadLedger();
    checkAgainstLedger("createOrdersExcel", ledger, "Orders", priorRowCount);

    const existingOrderIds = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const orderNum = row.getCell(2).value;
        if (orderNum) existingOrderIds.add(String(orderNum));
    });

    let added = 0, skippedDup = 0, skippedNoId = 0;
    for (const order of orders) {
        if (!order) continue;
        if (!order.orderId) { skippedNoId++; console.warn("Skipping order with missing orderId:", order); continue; }
        if (existingOrderIds.has(String(order.orderId))) { skippedDup++; continue; }
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
            weightLbs: order.weightLbs ?? "",
            weightKgs: order.weightKgs ?? "",
            heightIn: order.heightIn ?? "",
            heightCm: order.heightCm ?? "",
        });

        const color = STATUS_COLORS[order.downloadStatus];
        if (color) {
            row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
        }

        existingOrderIds.add(String(order.orderId)); // prevents duplicates within this same batch
        added++;
    }

    log.info(`createOrdersExcel: added=${added} skippedDuplicate=${skippedDup} skippedNoOrderId=${skippedNoId}`);

    const finalRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;
    if (finalRowCount < priorRowCount) {
        log.error(`createOrdersExcel: sheet would SHRINK within this call: ${priorRowCount} -> ${finalRowCount}. Aborting.`);
        throw new Error(`Refusing to save — Orders sheet would shrink from ${priorRowCount} to ${finalRowCount}.`);
    }

    await atomicWrite(workbook, filepath);

    ledger.Orders = finalRowCount;
    saveLedger(ledger);
    log.info(`createOrdersExcel: ledger updated — Orders=${finalRowCount}`);
    console.log(`Excel updated: ${added} new rows added (total ${finalRowCount}). File: ${filepath}`);
}

export async function updateDocumentsExcel(documents, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();

    log.info(`updateDocumentsExcel: called with ${documents.length} candidate rows`);
    await safeReadOrCreate(workbook, filepath, "updateDocumentsExcel");

    let sheet = workbook.getWorksheet("Documents");

    const columns = [
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

    if (!sheet) {
        log.warn(`updateDocumentsExcel: "Documents" worksheet not found — creating new one`);
        sheet = workbook.addWorksheet("Documents");
        sheet.columns = columns;
        sheet.getRow(1).font = { bold: true };
    } else {
        log.info(`updateDocumentsExcel: found existing "Documents" worksheet`);

        // DON'T replace the columns.
        // Just restore the keys.
        sheet.columns.forEach((col, index) => {
            col.key = columns[index].key;
            col.width = columns[index].width;
        });

    }

    const priorRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;

    const ledger = loadLedger();
    checkAgainstLedger("updateDocumentsExcel", ledger, "Documents", priorRowCount);

    const existingKeys = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const key = `${row.getCell(1).value}|${row.getCell(2).value}|${row.getCell(5).value}`;
        existingKeys.add(key);
    });

    let added = 0, skippedDup = 0;
    for (const doc of documents) {
        const key = `${doc.patientId}|${doc.receivedDate}|${doc.description}`;
        if (existingKeys.has(key)) { skippedDup++; continue; }
        const row = sheet.addRow({
            patientId: doc.patientId,
            receivedDate: doc.receivedDate,
            category: doc.category,
            from: doc.from,
            description: doc.description,
            enteredBy: doc.enteredBy,
            enteredDate: doc.enteredDate,
            filename: doc.filename,
            downloadStatus: doc.downloadStatus,
        });
        const color = STATUS_COLORS[doc.downloadStatus];
        if (color) {
            row.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
        }

        existingKeys.add(key);
        added++;
    }

    log.info(`updateDocumentsExcel: added=${added} skippedDuplicate=${skippedDup}`);

    const finalRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;
    if (finalRowCount < priorRowCount) {
        log.error(`updateDocumentsExcel: sheet would SHRINK within this call: ${priorRowCount} -> ${finalRowCount}. Aborting.`);
        throw new Error(`Refusing to save — Documents sheet would shrink from ${priorRowCount} to ${finalRowCount}.`);
    }

    await atomicWrite(workbook, filepath);

    ledger.Documents = finalRowCount;
    saveLedger(ledger);
    log.info(`updateDocumentsExcel: ledger updated — Documents=${finalRowCount}`);
    console.log(`Documents sheet updated: ${added} new rows added (total ${finalRowCount}).`);
}

export async function updateTreatmentNotesExcel(notes, outputDir = "./downloads") {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filepath = path.join(outputDir, "orders.xlsx");
    const workbook = new ExcelJS.Workbook();

    log.info(`updateTreatmentNotesExcel: called with ${notes.length} candidate rows`);
    await safeReadOrCreate(workbook, filepath, "updateTreatmentNotesExcel");

    const treatmentColumns = [
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
        { header: "Allergies", key: "allergies", width: 30 },
        { header: "Medication", key: "medication", width: 18 },
        { header: "Medication Type", key: "medicationType", width: 18 },
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
        { header: "Prep Qty", key: "prepQty", width: 12 },
        { header: "Prep Vial", key: "prepVial", width: 25 },
        { header: "Prep NDC", key: "prepNDC", width: 15 },
        { header: "Prep Lot", key: "prepLot", width: 15 },
        { header: "Prep Exp", key: "prepExp", width: 15 },
        { header: "Prep Diluent Qty", key: "prepDiluentQty", width: 14 },
        { header: "Prep Diluent", key: "prepDiluent", width: 28 },
        { header: "Prep Diluent NDC", key: "prepDiluentNDC", width: 16 },
        { header: "Prep Diluent Lot", key: "prepDiluentLot", width: 16 },
        { header: "Prep Diluent Exp", key: "prepDiluentExp", width: 16 },
        { header: "Prep Mixed In Qty", key: "prepMixedInQty", width: 14 },
        { header: "Prep Mixed In Fluid", key: "prepMixedInFluid", width: 28 },
        { header: "Prep Mixed In NDC", key: "prepMixedInNDC", width: 16 },
        { header: "Prep Mixed In Lot", key: "prepMixedInLot", width: 16 },
        { header: "Prep Mixed In Exp", key: "prepMixedInExp", width: 16 },
        { header: "Narrative User", key: "narrativeUser", width: 30 },
        { header: "Narrative Text", key: "narrativeText", width: 60 },
        { header: "Narrative Created", key: "narrativeCreated", width: 22 },
        { header: "Narrative Updated", key: "narrativeUpdated", width: 22 },
    ];

    let sheet = workbook.getWorksheet("TreatmentNotes");

    if (!sheet) {
        log.warn(`updateTreatmentNotesExcel: "TreatmentNotes" worksheet not found — creating new one`);
        sheet = workbook.addWorksheet("TreatmentNotes");
        sheet.columns = treatmentColumns;
        sheet.getRow(1).font = { bold: true };
    } else {
        log.info(`updateTreatmentNotesExcel: found existing "TreatmentNotes" worksheet`);

        // Restore keys after reopening workbook
        sheet.columns.forEach((col, index) => {
            if (treatmentColumns[index]) {
                col.key = treatmentColumns[index].key;
                col.width = treatmentColumns[index].width;
            }
        });
    }

    const priorRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;

    const ledger = loadLedger();
    checkAgainstLedger("updateTreatmentNotesExcel", ledger, "TreatmentNotes", priorRowCount);

    const existingKeys = new Set();
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        existingKeys.add(`${row.getCell(1).value}|${row.getCell(2).value}`);
    });

    function ensureColumns(sheet, headers) {
        const headerRow = sheet.getRow(1);
        const colMap = new Map();

        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            colMap.set(String(cell.value), colNumber);
        });

        let nextCol = headerRow.cellCount + 1;

        for (const header of headers) {
            if (!colMap.has(header)) {
                sheet.getColumn(nextCol).width = 24;
                const cell = headerRow.getCell(nextCol);
                cell.value = header;
                cell.font = { bold: true };
                colMap.set(header, nextCol);
                nextCol++;
            }
        }
        return colMap;
    }

    let added = 0, skippedDup = 0;
    for (const note of notes) {
        const key = `${note.patientId}|${note.appointmentId}`;
        if (existingKeys.has(key)) { skippedDup++; continue; }

        const { assessment = {}, ...fixedFields } = note;
        const row = sheet.addRow(fixedFields);

        const colMap = ensureColumns(sheet, Object.keys(assessment));
        for (const [header, value] of Object.entries(assessment)) {
            row.getCell(colMap.get(header)).value = value;
        }

        existingKeys.add(key);
        added++;
    }

    log.info(`updateTreatmentNotesExcel: added=${added} skippedDuplicate=${skippedDup}`);

    const finalRowCount = sheet.rowCount > 1 ? sheet.rowCount - 1 : 0;
    if (finalRowCount < priorRowCount) {
        log.error(`updateTreatmentNotesExcel: sheet would SHRINK within this call: ${priorRowCount} -> ${finalRowCount}. Aborting.`);
        throw new Error(`Refusing to save — TreatmentNotes sheet would shrink from ${priorRowCount} to ${finalRowCount}.`);
    }

    await atomicWrite(workbook, filepath);

    ledger.TreatmentNotes = finalRowCount;
    saveLedger(ledger);
    log.info(`updateTreatmentNotesExcel: ledger updated — TreatmentNotes=${finalRowCount}`);
    console.log(`TreatmentNotes sheet updated: ${added} new rows added (total ${finalRowCount}).`);
}