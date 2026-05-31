/** Shared thermal receipt HTML wrapper (main process print window). */

const THERMAL_PRINT_STYLE = `
  @page { size: 80mm auto; margin: 3mm; }
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
    padding: 8px;
    width: 72mm;
    max-width: 72mm;
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
<html>
<head>
<meta charset="utf-8"/>
<title>${safeTitle}</title>
<style>${THERMAL_PRINT_STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

module.exports = { THERMAL_PRINT_STYLE, wrapThermalPrintDocument };
