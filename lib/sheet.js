const XLSX = require("xlsx");

// Builds an .xlsx file buffer with a single sheet: a header row followed by
// whatever data rows are given (array of arrays, same column order as
// headers). Used both for the blank templates admins/teachers download and
// for pre-filled exports (e.g. current marks) they can edit and re-upload.
function buildWorkbookBuffer(headers, rows, sheetName = "Sheet1") {
  const data = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = headers.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// Parses an uploaded spreadsheet buffer (.xlsx, .xls, or .csv — XLSX.read
// auto-detects the format from the file content) into an array of row
// objects keyed by the first row's header text. Blank rows are dropped.
//
// cellDates + dateNF: if a column (e.g. জন্ম তারিখ) was typed into Excel as
// an actual date rather than plain text, Excel stores it as a date-formatted
// number, not the text "YYYY-MM-DD". Without this, sheet_to_json renders it
// using the cell's own display format (often locale-dependent, e.g.
// "1/10/2015"), which then fails to populate <input type="date"> fields
// (they require exactly "YYYY-MM-DD") and looks like the date "isn't
// coming through" after import. Forcing dateNF here makes every date-typed
// cell come out as "YYYY-MM-DD" regardless of how it displays in Excel.
function parseWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false, dateNF: "yyyy-mm-dd" });
  return rows
    .map((row) => {
      const clean = {};
      Object.keys(row).forEach((k) => {
        const v = row[k];
        clean[String(k).trim()] = typeof v === "string" ? v.trim() : v;
      });
      return clean;
    })
    .filter((row) => Object.values(row).some((v) => String(v ?? "").trim() !== ""));
}

// Reads a value out of a parsed row by trying several possible header
// names (Bengali or English, exact template header or a shorter alias) —
// so an import still works if a column got renamed, or an old export is
// re-uploaded after the template wording changed.
function pickField(row, candidates) {
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase();
    if (candidates.some((c) => c.toLowerCase() === norm)) {
      return row[key];
    }
  }
  return "";
}

module.exports = { buildWorkbookBuffer, parseWorkbookBuffer, pickField };
