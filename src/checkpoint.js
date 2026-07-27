import fs from "fs";

const CHECKPOINT_FILE = "./downloads/checkpoint.json";

export function loadCheckpoint() {
    if (fs.existsSync(CHECKPOINT_FILE)) {
        return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
    }
    return { completedPatients: [] };
}

export function markPatientDone(patientId, checkpoint) {
    if (!checkpoint.completedPatients.includes(patientId)) {
        checkpoint.completedPatients.push(patientId);
    }
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

export function isPatientDone(patientId, checkpoint) {
    return checkpoint.completedPatients.includes(String(patientId));
}
