/** Pick the best available OS printer queue — any connected physical printer. */

function isVirtualPrinterName(name) {
  const n = String(name || "").toLowerCase();
  return /pdf|fax|xps|onenote|send to|microsoft print to|save as pdf|adobe/i.test(n);
}

function isLikelyReceiptPrinterName(name) {
  const n = String(name || "").toLowerCase();
  return /billquick|pos\s*80|pos\s*58|pos-?80|pos-?58|203dpi|thermal|receipt|tm-|tsp|star\s|epson\s*tm|xprinter|bixolon|generic\/text|generic.text|escpos|rp80|rp58|everycom|hoin|gprinter|rongta|citizen/i.test(
    n,
  );
}

/** Prefer saved → default → receipt-like → any physical → first in list. */
function pickBestPrinter(printers, preferredName) {
  const list = Array.isArray(printers) ? printers : [];
  if (!list.length) return "";

  const preferred = String(preferredName || "").trim();
  if (preferred && list.some((p) => p.name === preferred)) return preferred;

  const defPhysical = list.find((p) => p.isDefault && !isVirtualPrinterName(p.name));
  if (defPhysical?.name) return defPhysical.name;

  const defAny = list.find((p) => p.isDefault);
  if (defAny?.name) return defAny.name;

  const receipt = list.find(
    (p) => !isVirtualPrinterName(p.name) && isLikelyReceiptPrinterName(p.name),
  );
  if (receipt?.name) return receipt.name;

  const physical = list.find((p) => !isVirtualPrinterName(p.name));
  if (physical?.name) return physical.name;

  return list[0]?.name?.trim() || "";
}

module.exports = {
  isVirtualPrinterName,
  isLikelyReceiptPrinterName,
  pickBestPrinter,
};
