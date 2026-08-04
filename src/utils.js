// utils.js
export function withTimeout(promise, ms, label = "operation") {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function retryOnce(fn, label = "operation") {
    try {
        return await fn();
    } catch (err) {
        console.warn(`${label} failed once (${err.message}) — retrying...`);
        return await fn();
    }
}