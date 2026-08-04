import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}_pid${process.pid}`;
const LOG_FILE = path.join(LOG_DIR, `scraper_${sessionId}.log`);

function write(level, msg) {
    const line = `[${new Date().toISOString()}] [PID ${process.pid}] [${level}] ${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + "\n");
    } catch { /* never let logging crash the run */ }
}

export const log = {
    info: (msg) => write("INFO", msg),
    warn: (msg) => write("WARN", msg),
    error: (msg) => write("ERROR", msg),
};

export function fileFingerprint(filepath) {
    if (!fs.existsSync(filepath)) return "MISSING";
    const s = fs.statSync(filepath);
    return `size=${s.size}B mtime=${new Date(s.mtimeMs).toISOString()}`;
}