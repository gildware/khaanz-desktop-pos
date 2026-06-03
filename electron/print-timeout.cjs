/** Race a promise against a deadline — prevents IPC/UI hangs when print backends stall. */
function withTimeout(promise, ms, label = "Operation") {
  const timeoutMs = Math.max(1000, Number(ms) || 60_000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
