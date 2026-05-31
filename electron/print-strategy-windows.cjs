/** Methods that work with BillQuick Lite / Petpooja-style GDI drivers (no Sumatra, no RAW). */
const GDI_METHOD_ORDER = [
  "notepad-pt",
  "shell-printto",
  "dotnet-gdi",
  "cmd-print",
  "gdi",
  "pdf",
];

const RAW_METHOD_ORDER = ["port-raw", "text-raw", "escpos-raw", "out-printer"];

function isVirtualPort(port, driver) {
  const s = `${port} ${driver}`.toLowerCase();
  return /portprompt|pdf|onenote|fax|xps|file:|nul:|microsoft print to pdf|send to onenote/i.test(
    s,
  );
}

function isLikelyGdiReceiptDriver(driver, port) {
  const d = String(driver || "").toLowerCase();
  const p = String(port || "").toLowerCase();
  if (isVirtualPort(p, d)) return false;
  return /billquick|pos\s*80|pos\s*58|203dpi|thermal|receipt|generic\/text|generic text|xprinter|epson|star|bixolon|tm-|tsp|citizen|rongta|everycom|hoin|gprinter/i.test(
    d,
  );
}

function reorderAttempts(attempts, preferredMethod) {
  if (!preferredMethod) return attempts;
  const pref = String(preferredMethod).trim();
  const hit = attempts.find((a) => a.methodId === pref);
  if (!hit) return attempts;
  return [hit, ...attempts.filter((a) => a.methodId !== pref)];
}

module.exports = {
  GDI_METHOD_ORDER,
  RAW_METHOD_ORDER,
  reorderAttempts,
  isLikelyGdiReceiptDriver,
  isVirtualPort,
};
