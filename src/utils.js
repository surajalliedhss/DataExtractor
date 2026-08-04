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

// NEW: runs `fn` on a brand-new Playwright page created from `context`, and
// always closes that page afterward — success, failure, or timeout.
//
// Why this exists: withTimeout() only stops *awaiting* a slow operation, it
// can't cancel the underlying Playwright action (page.goto, dialog clicks,
// etc.). That orphaned work keeps running against whatever `page` object it
// was given. If every attempt shares one page (across retries AND across
// patients), an orphan from a timed-out step can fire a real navigation
// later and collide with — and abort — a completely unrelated patient's
// page.goto(). Giving every attempt its own page means an orphan can only
// ever collide with itself; closing the page kills it outright instead of
// letting it roam.
export async function withFreshPage(context, fn) {
    const page = await context.newPage();
    try {
        return await fn(page);
    } finally {
        // Bound the close itself — a wedged page can hang close() too, and
        // we'd rather move on than get stuck cleaning up a zombie.
        await Promise.race([
            page.close({ runBeforeUnload: false }).catch(() => { }),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    }
}