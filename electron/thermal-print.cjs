/** Shared thermal receipt HTML wrapper (main process print window). */

const THERMAL_PRINT_STYLE = `
  @page { size: 80mm auto; margin: 0; }
  html {
    color-scheme: light only;
    background: #fff !important;
  }
  * {
    box-sizing: border-box;
    font-weight: 700 !important;
    color: #000 !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  html, body {
    font-family: Arial, Helvetica, "Liberation Sans", sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.45;
    margin: 0;
    padding: 0 2px;
    width: 80mm;
    max-width: 80mm;
    background: #fff !important;
    color: #000 !important;
  }
  pre {
    margin: 0;
    width: 100%;
    font-family: "Courier New", Courier, monospace;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.35;
    white-space: pre;
    overflow-wrap: normal;
    word-break: normal;
  }
  h1 {
    font-size: 16px;
    margin: 0 0 8px;
    text-align: center;
    font-weight: 700;
  }
  .pre {
    white-space: pre-wrap;
    font-size: 11px;
    margin: 4px 0;
    font-weight: 700;
  }
  .muted {
    font-size: 11px;
    margin: 3px 0;
    font-weight: 700;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
  }
  th, td {
    padding: 3px 0;
    text-align: left;
    vertical-align: top;
    font-size: 11px;
    font-weight: 700;
  }
  th {
    border-bottom: 2px solid #000;
    font-weight: 700;
  }
  .right { text-align: right; white-space: nowrap; }
  .sep {
    border-top: 2px solid #000;
    margin: 8px 0;
    padding-top: 6px;
    font-weight: 700;
  }
  .total { font-size: 14px; font-weight: 700; }
  tr.addon-line td { font-size: 10px; font-weight: 700; }
  tr.addon-line .iname { padding-left: 8px; }
`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Full HTML document for Electron print (styles in head). */
function wrapThermalPrintDocument(bodyHtml, title) {
  const safeTitle = escapeHtml(title || "Receipt");
  const body = String(bodyHtml || "").replace(/<style>[\s\S]*?<\/style>/gi, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="light only"/>
<title>${safeTitle}</title>
<style>${THERMAL_PRINT_STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

/** Sample receipt for Connect printer → Test print. */
function buildTestPrintPlainText() {
  const w = 48;
  const line = "-".repeat(w);
  const center = (s) => {
    const t = String(s).trim();
    if (t.length >= w) return t.slice(0, w);
    const pad = Math.floor((w - t.length) / 2);
    return `${" ".repeat(pad)}${t}`;
  };
  return [
    center("Khaanz POS"),
    center("TEST PRINT"),
    line,
    "If you can read this,",
    "your printer is connected.",
    new Date().toLocaleString("en-IN"),
    line,
    center("Thank you"),
    "",
  ].join("\n");
}

module.exports = {
  THERMAL_PRINT_STYLE,
  wrapThermalPrintDocument,
  buildTestPrintPlainText,
};
