const defaults = Object.freeze({ deadlineMs: 15000, maxAttempts: 3, perAttemptTimeoutMs: 5000, backoffMs: [1000, 2000], minimumAttemptBudgetMs: 1000, responseValidationBudgetMs: 500, maximumRetryAfterMs: 2000 });

function abortError(reason = "Aborted") { const error = reason instanceof Error ? reason : new Error(String(reason)); error.name = "AbortError"; return error; }

export async function abortableDelay(ms, signal, timers = globalThis) {
  if (signal?.aborted) throw abortError(signal.reason);
  await new Promise((resolve, reject) => { const timer = timers.setTimeout(done, ms); function done() { cleanup(); resolve(); } function aborted() { cleanup(); reject(abortError(signal.reason)); } function cleanup() { timers.clearTimeout(timer); signal?.removeEventListener("abort", aborted); } signal?.addEventListener("abort", aborted, { once: true }); });
}

export async function runProviderWithRetry(operation, options = {}) {
  const policy = { ...defaults, ...(options.policy ?? {}) }, signal = options.signal, now = options.now ?? Date.now, delay = options.delay ?? abortableDelay, started = now(); let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError(signal.reason);
    const remaining = policy.deadlineMs - (now() - started); if (remaining < policy.minimumAttemptBudgetMs + policy.responseValidationBudgetMs) break;
    const controller = new AbortController(), timeoutMs = Math.min(policy.perAttemptTimeoutMs, remaining - policy.responseValidationBudgetMs), timer = setTimeout(() => controller.abort(abortError("Provider attempt timed out")), timeoutMs), onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { const value = await operation({ attempt, signal: controller.signal }); return { value, attemptCount: attempt, elapsedMs: Math.max(0, now() - started) }; }
    catch (error) { lastError = controller.signal.aborted && !signal?.aborted ? Object.assign(abortError("Provider attempt timed out"), { code: "provider_timeout", retryable: true }) : error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    if (signal?.aborted) throw abortError(signal.reason); if (!lastError?.retryable || attempt >= policy.maxAttempts) break;
    const retryAfter = Number.isFinite(lastError.retryAfterMs) && lastError.retryAfterMs <= policy.maximumRetryAfterMs ? Math.max(0, lastError.retryAfterMs) : null, wait = retryAfter ?? policy.backoffMs[attempt - 1] ?? 0;
    if (policy.deadlineMs - (now() - started) - wait < policy.minimumAttemptBudgetMs + policy.responseValidationBudgetMs) break; await delay(wait, signal);
  }
  if (lastError) throw lastError; const error = new Error("Provider deadline exhausted"); error.code = "provider_timeout"; error.retryable = false; throw error;
}

export const interpreterRetryPolicy = defaults;
