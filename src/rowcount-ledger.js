import fs from "fs";

const LEDGER_PATH = "./rowcount-ledger.json";

export function loadLedger() {
    if (!fs.existsSync(LEDGER_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
    } catch {
        return {};
    }
}

export function saveLedger(ledger) {
    const tmp = `${LEDGER_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, LEDGER_PATH);
}