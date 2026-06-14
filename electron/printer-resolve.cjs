/** Pick the best available OS printer queue — any connected physical printer. */

/** Loose match for Electron display name vs CUPS queue name (spaces, _, punctuation). */
function normalizePrinterKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\[\]()]/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function printerNamesLooselyMatch(a, b) {
  const ka = normalizePrinterKey(a);
  const kb = normalizePrinterKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 8 && kb.length >= 8) {
    return ka.includes(kb) || kb.includes(ka);
  }
  return false;
}

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

/** Chromium/Electron queue status — 0 idle, 1 processing; 2+ often stopped/error. */
function isUnhealthyElectronPrinter(printer) {
  const st = printer?.status;
  return typeof st === "number" && st >= 2;
}

function scorePhysicalPrinter(printer) {
  let score = 0;
  if (printer?.isDefault) score += 100;
  if (!isUnhealthyElectronPrinter(printer)) score += 40;
  if (isLikelyReceiptPrinterName(printer?.name)) score += 20;
  return score;
}

/** Prefer saved → physical default → receipt-like → any physical → virtual default → first. */
function pickBestPrinter(printers, preferredName) {
  const list = Array.isArray(printers) ? printers : [];
  if (!list.length) return "";

  const preferred = String(preferredName || "").trim();
  if (preferred) {
    const hit = list.find((p) => p.name === preferred);
    if (hit && !isVirtualPrinterName(hit.name) && !isUnhealthyElectronPrinter(hit)) {
      return hit.name;
    }
  }

  const defPhysical = list.find((p) => p.isDefault && !isVirtualPrinterName(p.name));
  if (defPhysical?.name) return defPhysical.name;

  const physical = list.filter((p) => !isVirtualPrinterName(p.name));
  if (physical.length) {
    const ranked = [...physical].sort(
      (a, b) => scorePhysicalPrinter(b) - scorePhysicalPrinter(a),
    );
    if (ranked[0]?.name) return ranked[0].name;
  }

  const defAny = list.find((p) => p.isDefault);
  if (defAny?.name) return defAny.name;

  return list[0]?.name?.trim() || "";
}

module.exports = {
  normalizePrinterKey,
  printerNamesLooselyMatch,
  isVirtualPrinterName,
  isLikelyReceiptPrinterName,
  isUnhealthyElectronPrinter,
  pickBestPrinter,
};
