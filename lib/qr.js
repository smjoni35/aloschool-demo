const QRCode = require("qrcode");

/**
 * Generates a QR code (PNG, as a data URL) that points to a student's
 * Public Result Page. Rendered small (~58pt) on the printed card, so a
 * tighter quiet zone and a higher source resolution keep it crisp and
 * reliably scannable even after printing.
 */
async function qrDataUrlFor(url) {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

module.exports = { qrDataUrlFor };
