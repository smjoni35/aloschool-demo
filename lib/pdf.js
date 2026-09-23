const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const FONT_REGULAR = path.join(__dirname, "..", "fonts", "HindSiliguri-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "..", "fonts", "HindSiliguri-Bold.ttf");

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBnDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
}
function bnOrdinal(n) {
  if (n === 1) return "১ম";
  if (n === 2) return "২য়";
  if (n === 3) return "৩য়";
  if (n === 4) return "৪র্থ";
  return `${toBnDigits(n)}তম`;
}

// Full Bengali ordinal WORDS (not the "১ম" short form) — used for period
// labels on the class routine (screen + PDF), so "1ম" reads as "প্রথম"
// instead of a clipped abbreviation. Covers well beyond any realistic
// period count; anything past the list falls back to "Nতম" (still a full
// readable word, just not an irregular one).
const BN_PERIOD_ORDINAL_WORDS = [
  "প্রথম", "দ্বিতীয়", "তৃতীয়", "চতুর্থ", "পঞ্চম",
  "ষষ্ঠ", "সপ্তম", "অষ্টম", "নবম", "দশম",
  "একাদশ", "দ্বাদশ", "ত্রয়োদশ", "চতুর্দশ", "পঞ্চদশ",
  "ষোড়শ", "সপ্তদশ", "অষ্টাদশ", "ঊনবিংশ", "বিংশ",
];
function periodOrdinal(n) {
  return BN_PERIOD_ORDINAL_WORDS[n - 1] || `${toBnDigits(n)}তম`;
}

function getGrade(percentage) {
  if (percentage >= 80) return { grade: "A+", gp: 5.0 };
  if (percentage >= 70) return { grade: "A", gp: 4.0 };
  if (percentage >= 60) return { grade: "A-", gp: 3.5 };
  if (percentage >= 50) return { grade: "B", gp: 3.0 };
  if (percentage >= 40) return { grade: "C", gp: 2.0 };
  if (percentage >= 33) return { grade: "D", gp: 1.0 };
  return { grade: "F", gp: 0.0 };
}

// Auto-writes a short teacher-style remark based on the student's own
// result — no manual typing needed. Kept separate from getGrade so the
// wording can be tuned without touching the grading scale.
function generateRemark({ overall, allEntered, failCount, position }) {
  if (!allEntered) return ""; // full picture isn't in yet — the incomplete-marks warning already covers this
  if (failCount > 0) {
    return "একাধিক বিষয়ে কৃতকার্য হতে পারেনি — নিয়মিত পড়াশোনা ও অতিরিক্ত যত্ন প্রয়োজন।";
  }
  const byGrade = {
    "A+": "অসাধারণ ফলাফল! এই ধারাবাহিকতা বজায় রাখো।",
    "A": "ভালো ফলাফল করেছে — আরেকটু চেষ্টায় আরও এগিয়ে যাওয়া সম্ভব।",
    "A-": "সন্তোষজনক ফলাফল — নিয়মিত পড়াশোনা চালিয়ে গেলে আরও ভালো করবে।",
    "B": "মোটামুটি ফলাফল — পড়াশোনায় আরেকটু বেশি সময় দেওয়া প্রয়োজন।",
    "C": "ফলাফল উন্নতির প্রয়োজন — নিয়মিত অনুশীলন ও বাড়তি মনোযোগ দরকার।",
    "D": "ফলাফল উদ্বেগজনক — বিশেষ যত্ন ও নিয়মিত তদারকি প্রয়োজন।",
  };
  let remark = byGrade[overall.grade] || "";
  if (position === 1) remark = "শ্রেণিতে প্রথম হওয়ার জন্য অভিনন্দন! " + remark;
  else if (position && position <= 3) remark = "শ্রেণির মেধাতালিকায় জায়গা করে নেওয়ার জন্য অভিনন্দন! " + remark;
  return remark;
}

/**
 * Draws one student's progress card onto the CURRENT page of an already-open
 * PDFDocument. Does not create the document, pipe it, or call doc.end() —
 * that's the caller's job, so this can be reused both for a single-student
 * PDF (one page) and a combined PDF with one page per student.
 * student: { name, roll, section }
 * exam: { className, examName, session, schoolName, subjects: [{name, fullMarks}] }
 * marks: { subjectName: obtainedMarks }
 */
function drawProgressCardPage(doc, { student, exam, marks, remarks, position, totalStudents, subjectHighest = {}, logoDataUrl, qrDataUrl }) {
  const pageWidth = doc.page.width - 80;

  // School logo, top-left of the card. Positioned with explicit x/y so it
  // doesn't disturb the centered header text's own flow (doc.x/doc.y).
  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      const logoBuf = Buffer.from(base64, "base64");
      doc.image(logoBuf, 40, 36, { width: 58, height: 58 });
    } catch (e) {
      // Bad/corrupt logo data shouldn't break PDF generation.
    }
  }

  // Verification QR code, top-right — mirrors the logo's size/position on
  // the opposite side so the header stays visually balanced. Scanning it
  // opens this student's Public Result Page. Same explicit x/y treatment
  // as the logo, so it never disturbs the centered header text.
  if (qrDataUrl) {
    try {
      const base64 = String(qrDataUrl).split(",").pop();
      const qrBuf = Buffer.from(base64, "base64");
      const qrSize = 58;
      const qrX = doc.page.width - 40 - qrSize;
      doc.image(qrBuf, qrX, 36, { width: qrSize, height: qrSize });
    } catch (e) {
      // Bad/corrupt QR data shouldn't break PDF generation.
    }
  }

  let totalObtained = 0;
  let totalFull = 0;
  let gpSum = 0;
  let failCount = 0;
  let gradedCount = 0;
  const rows = exam.subjects.map((s) => {
    const raw = marks[s.name];
    const entered = raw !== undefined && raw !== null && raw !== "";
    const full = parseFloat(s.fullMarks) || 100;

    const highest = subjectHighest[s.name];

    if (!entered) {
      // Marks not given yet for this subject — don't treat as zero.
      return { name: s.name, obtained: null, full, grade: "—", gp: null, entered: false, highest };
    }

    const obtained = parseFloat(raw) || 0;
    const pct = full ? (obtained / full) * 100 : 0;
    const { grade, gp } = getGrade(pct);
    if (grade === "F") failCount++;
    totalObtained += obtained;
    totalFull += full;
    gpSum += gp;
    gradedCount++;
    return { name: s.name, obtained, full, grade, gp, entered: true, highest };
  });

  const avgGP = gradedCount ? gpSum / gradedCount : 0;
  const overallPct = totalFull ? (totalObtained / totalFull) * 100 : 0;
  const allEntered = gradedCount === exam.subjects.length;
  const overall = !allEntered
    ? { grade: "—", gp: 0 }
    : failCount > 0
    ? { grade: "F", gp: 0 }
    : getGrade(overallPct);

  doc.font("bn-bold").fontSize(20).text(exam.schoolName || "School Name", { align: "center" });
  doc.moveDown(0.15);
  doc.font("bn-bold").fontSize(14).text("প্রগ্রেস রিপোর্ট কার্ড", { align: "center" });
  doc.moveDown(0.2);
  doc
    .font("bn")
    .fontSize(10)
    .fillColor("#333")
    .text(`${exam.examName || ""}   ${exam.session ? "— সেশন: " + exam.session : ""}`, {
      align: "center",
    });
  doc.fillColor("#000");
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#999").stroke();
  doc.moveDown(0.4);

  const infoY = doc.y;
  doc.font("bn").fontSize(11);
  doc.text(`শিক্ষার্থীর নাম: `, 40, infoY, { continued: true }).font("bn-bold").text(student.name || "");
  doc.font("bn").text(`ক্লাস: `, 40, doc.y + 2, { continued: true }).font("bn-bold").text(exam.className || "");
  doc.font("bn").text(`রোল: `, 40, doc.y + 2, { continued: true }).font("bn-bold").text(student.roll || "");
  if (student.section) {
    doc.font("bn").text(`শিফট: `, 40, doc.y + 2, { continued: true }).font("bn-bold").text(student.section);
  }

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#999").stroke();
  doc.moveDown(0.4);

  const colX = { name: 40, full: 190, obtained: 250, highest: 310, grade: 410, gp: 480 };
  const colW = { full: 60, obtained: 60, highest: 100, grade: 70, gp: 75 };

  // Up to 15 subjects, keep the row height/font exactly as designed. Only
  // beyond that does the row height (and, if needed, the font size) shrink
  // gradually so more subjects still fit on one page.
  const subjectCount = rows.length;
  const SHRINK_AFTER = 15;
  const rowH =
    subjectCount <= SHRINK_AFTER
      ? 24
      : Math.max(16, 24 - (subjectCount - SHRINK_AFTER) * 1.6);
  const tableFontSize =
    subjectCount <= SHRINK_AFTER
      ? 11
      : Math.max(8, 11 - Math.floor((subjectCount - SHRINK_AFTER) / 2));

  let y = doc.y;

  // Draws `text` inside a cell whose row spans [rowTop, rowTop + rowH],
  // vertically centering it (equal space above and below) instead of the
  // old fixed "+6" offset, which left uneven padding depending on the
  // font's actual rendered height.
  function drawCell(text, x, rowTop, opts = {}) {
    const h = doc.heightOfString(text, opts);
    const cy = rowTop + (rowH - h) / 2;
    doc.text(text, x, cy, opts);
  }

  doc.font("bn-bold").fontSize(tableFontSize);
  doc.rect(40, y, pageWidth, rowH).fillAndStroke("#f0f0f0", "#999");
  doc.fillColor("#000");
  drawCell("বিষয়", colX.name + 6, y);
  drawCell("পূর্ণমান", colX.full, y, { width: colW.full, align: "center" });
  drawCell("প্রাপ্ত", colX.obtained, y, { width: colW.obtained, align: "center" });
  drawCell("সর্বোচ্চ নম্বর", colX.highest, y, { width: colW.highest, align: "center" });
  drawCell("গ্রেড", colX.grade, y, { width: colW.grade, align: "center" });
  drawCell("GP", colX.gp, y, { width: colW.gp, align: "center" });
  y += rowH;

  doc.font("bn").fontSize(tableFontSize);
  rows.forEach((s, idx) => {
    const bg = idx % 2 === 0 ? "#ffffff" : "#fafafa";
    doc.rect(40, y, pageWidth, rowH).fillAndStroke(bg, "#ddd");
    doc.fillColor("#000");
    drawCell(s.name, colX.name + 6, y, { width: 150 });
    drawCell(String(s.full), colX.full, y, { width: colW.full, align: "center" });
    drawCell(s.entered ? String(s.obtained) : "—", colX.obtained, y, { width: colW.obtained, align: "center" });
    drawCell(
      s.highest !== undefined && s.highest !== null ? String(s.highest) : "—",
      colX.highest,
      y,
      { width: colW.highest, align: "center" }
    );
    drawCell(s.grade, colX.grade, y, { width: colW.grade, align: "center" });
    drawCell(s.entered ? s.gp.toFixed(2) : "—", colX.gp, y, { width: colW.gp, align: "center" });
    y += rowH;
  });

  doc.font("bn-bold").fontSize(tableFontSize);
  doc.rect(40, y, pageWidth, rowH).fillAndStroke("#eef4ff", "#999");
  doc.fillColor("#000");
  drawCell("মোট", colX.name + 6, y);
  drawCell(String(totalFull), colX.full, y, { width: colW.full, align: "center" });
  drawCell(String(totalObtained), colX.obtained, y, { width: colW.obtained, align: "center" });
  drawCell(overall.grade, colX.grade, y, { width: colW.grade, align: "center" });
  drawCell(avgGP.toFixed(2), colX.gp, y, { width: colW.gp, align: "center" });
  y += rowH + 12;
  doc.y = y;

  doc.font("bn").fontSize(12);
  doc
    .text(`মোট প্রাপ্ত নম্বর: `, 40, doc.y, { continued: true })
    .font("bn-bold")
    .text(`${totalObtained} / ${totalFull}${allEntered ? "" : " (আংশিক)"}`);
  doc
    .font("bn")
    .text(`শতকরা হার: `, 40, doc.y + 3, { continued: true })
    .font("bn-bold")
    .text(`${overallPct.toFixed(2)}%`);
  doc
    .font("bn")
    .text(`সার্বিক ফলাফল: `, 40, doc.y + 3, { continued: true })
    .font("bn-bold")
    .text(allEntered ? `${overall.grade} (GPA ${avgGP.toFixed(2)})` : "অসম্পূর্ণ — সব বিষয়ে নম্বর দেওয়া হয়নি");

  if (position) {
    doc
      .font("bn")
      .text(`শ্রেণিতে অবস্থান: `, 40, doc.y + 3, { continued: true })
      .font("bn-bold")
      .text(`${bnOrdinal(position)}${totalStudents ? ` (মোট ${totalStudents} জনের মধ্যে)` : ""}`);
  }

  if (!allEntered) {
    doc.moveDown(0.25);
    doc
      .font("bn")
      .fontSize(10)
      .fillColor("#b91c1c")
      .text("⚠ কিছু বিষয়ে এখনো নম্বর দেওয়া হয়নি (উপরে \"—\" চিহ্নিত) — চূড়ান্ত ফলাফলের জন্য সব বিষয়ের নম্বর দিন।", {
        width: pageWidth,
      });
    doc.fillColor("#000");
  }

  const finalRemark = remarks || generateRemark({ overall, allEntered, failCount, position });
  if (finalRemark) {
    doc.moveDown(0.6);
    doc.font("bn-bold").fontSize(11).text("মন্তব্য:");
    doc.font("bn").fontSize(11).text(finalRemark, { width: pageWidth });
  }

  doc.moveDown(1.5);
  const sigY = doc.y;
  doc.font("bn").fontSize(10);
  doc.text("_______________________", 40, sigY);
  doc.text("ক্লাস শিক্ষকের স্বাক্ষর", 40, sigY + 15);
  doc.text("_______________________", doc.page.width - 240, sigY);
  doc.text("প্রধান শিক্ষকের স্বাক্ষর", doc.page.width - 240, sigY + 15);

  if (qrDataUrl) {
    doc
      .font("bn")
      .fontSize(8)
      .fillColor("#666")
      .text("এই ফলাফল অনলাইনে যাচাই করতে উপরের QR কোড স্ক্যান করুন।", 40, sigY + 40, {
        width: pageWidth,
        align: "center",
      });
    doc.fillColor("#000");
  }

  return { totalObtained, totalFull, overallPct, overall, avgGP, rows };
}

/**
 * Stream a single student's progress card PDF to `res` (or any writable stream).
 * Thin wrapper around drawProgressCardPage that owns the PDFDocument's
 * lifecycle (create, pipe, end) for the single-student case.
 */
function streamProgressCard(stream, opts) {
  // Defensive: if the destination stream (e.g. an already-ended HTTP response)
  // errors later (write-after-end etc.), swallow it instead of letting it
  // crash the whole Node process via an unhandled 'error' event.
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  const result = drawProgressCardPage(doc, opts);
  doc.end();
  return result;
}

/**
 * Stream ONE combined PDF containing every student's progress card, one
 * page per student, in the given order — used for "print all at once".
 * cardOptsFor(student) must return the same options object that
 * drawProgressCardPage/streamProgressCard take (minus student, which is
 * passed separately).
 */
function streamAllProgressCards(stream, { students, cardOptsFor }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  students.forEach((student, idx) => {
    if (idx > 0) doc.addPage();
    drawProgressCardPage(doc, { student, ...cardOptsFor(student) });
  });

  doc.end();
}

/**
 * Stream a filled-in Online Admission Application as a PDF — school header
 * (logo + name) up top, the applicant's photo if provided, then every
 * submitted field as a label/value row, and signature lines at the bottom
 * so the printed page can double as a physical form.
 */
function streamAdmissionForm(stream, { application, schoolName, logoDataUrl }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  const pageWidth = doc.page.width - 80;

  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), 40, 36, { width: 58, height: 58 });
    } catch (e) {}
  }
  if (application.photoDataUrl) {
    try {
      const base64 = String(application.photoDataUrl).split(",").pop();
      const size = 78;
      doc.image(Buffer.from(base64, "base64"), doc.page.width - 40 - size, 36, { width: size, height: size });
    } catch (e) {}
  }

  doc.font("bn-bold").fontSize(20).text(schoolName || "School Name", { align: "center" });
  doc.moveDown(0.15);
  doc.font("bn-bold").fontSize(14).text("ভর্তি আবেদন ফরম", { align: "center" });
  doc.moveDown(0.2);
  doc
    .font("bn")
    .fontSize(10)
    .fillColor("#444")
    .text(
      `আবেদন নম্বর: ${application.admissionNo || application.id}   |   জমার তারিখ: ${new Date(application.submittedAt || Date.now()).toLocaleDateString("bn-BD")}`,
      { align: "center" }
    );
  doc.fillColor("#000");
  doc.moveDown(1.2);

  const rows = [
    ["শ্রেণি", application.className],
    ["শিক্ষার্থীর নাম", application.name],
    ["জন্ম তারিখ", application.dob],
    ["লিঙ্গ", application.gender],
    ["পিতার নাম", application.fatherName],
    ["মাতার নাম", application.motherName],
    ["পিতার মোবাইল নম্বর", application.fatherPhone],
    ["মাতার মোবাইল নম্বর", application.motherPhone],
    ["রক্তের গ্রুপ", application.bloodGroup],
    ["বর্তমান ঠিকানা", application.presentAddress],
    ["পূর্ববর্তী বিদ্যালয়", application.previousSchool],
    ["ছেড়ে আসার কারণ", application.reasonForLeaving],
  ].filter(([, v]) => v);

  const labelWidth = 170;
  rows.forEach(([label, value]) => {
    const y = doc.y;
    doc.font("bn-bold").fontSize(11).text(label, 40, y, { width: labelWidth });
    doc.font("bn").fontSize(11).text(value, 40 + labelWidth, y, { width: pageWidth - labelWidth });
    doc.moveDown(0.5);
    doc
      .moveTo(40, doc.y)
      .lineTo(40 + pageWidth, doc.y)
      .strokeColor("#eee")
      .stroke();
    doc.moveDown(0.5);
  });

  doc.moveDown(2);
  const sigY = doc.y;
  doc.font("bn").fontSize(11).text("_______________________", 40, sigY);
  doc.text("অভিভাবকের স্বাক্ষর", 40, sigY + 18);
  doc.text("_______________________", 40 + pageWidth - 220, sigY);
  doc.text("যাচাইকারীর স্বাক্ষর (বিদ্যালয়)", 40 + pageWidth - 220, sigY + 18);

  doc.end();
}

// ---------- Transfer Certificate (TC) ----------
// One-page official leaving certificate. Mirrors the admission form's
// label/value row layout for visual consistency across the app's document
// set. student: the full student record (name, registration, dob, etc.);
// extra: { leavingDate, lastExamResult, conductRemark, dueNote } — the
// handful of fields that only make sense at leaving time and so aren't
// part of the stored student record itself.
function streamTransferCertificate(stream, { student, className, schoolName, logoDataUrl, headTeacher, tcNo, issueDate, extra = {} }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  const pageWidth = doc.page.width - 80;

  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), 40, 36, { width: 58, height: 58 });
    } catch (e) {}
  }

  doc.font("bn-bold").fontSize(20).text(schoolName || "School Name", { align: "center" });
  doc.moveDown(0.15);
  doc.font("bn-bold").fontSize(15).text("ছাড়পত্র / প্রত্যয়ন পত্র", { align: "center" });
  doc.font("bn").fontSize(10).fillColor("#666").text("(Transfer Certificate)", { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(0.2);
  doc
    .font("bn")
    .fontSize(10)
    .fillColor("#444")
    .text(`টিসি নম্বর: ${tcNo}   |   ইস্যুর তারিখ: ${issueDate}`, { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(1.2);

  const rows = [
    ["ভর্তি/রেজিস্ট্রেশন নম্বর", student.registration],
    ["শিক্ষার্থীর নাম", student.name],
    ["পিতার নাম", student.fatherName],
    ["মাতার নাম", student.motherName],
    ["জন্ম তারিখ", student.dob],
    ["সর্বশেষ শ্রেণি", className],
    ["ভর্তির তারিখ", student.admissionDate],
    ["বিদ্যালয় ত্যাগের তারিখ", extra.leavingDate],
    ["সর্বশেষ পরীক্ষার ফলাফল", extra.lastExamResult],
    ["আচরণ/চরিত্র", extra.conductRemark || "সন্তোষজনক"],
    ["আর্থিক বকেয়া", extra.dueNote],
  ].filter(([, v]) => v);

  const labelWidth = 190;
  rows.forEach(([label, value]) => {
    const y = doc.y;
    doc.font("bn-bold").fontSize(11).text(label, 40, y, { width: labelWidth });
    doc.font("bn").fontSize(11).text(String(value), 40 + labelWidth, y, { width: pageWidth - labelWidth });
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).strokeColor("#eee").stroke();
    doc.moveDown(0.5);
  });

  doc.moveDown(2);
  const sigY = doc.y;
  doc.font("bn").fontSize(11).text("_______________________", 40, sigY);
  doc.text("অভিভাবকের স্বাক্ষর", 40, sigY + 18);
  doc.text("_______________________", 40 + pageWidth - 220, sigY);
  doc.font("bn-bold").text(headTeacher.name || "প্রধান শিক্ষক", 40 + pageWidth - 220, sigY + 18);
  doc.font("bn").fontSize(9).fillColor("#666").text(headTeacher.designation || "প্রধান শিক্ষক", 40 + pageWidth - 220, sigY + 33);
  doc.fillColor("#000");

  doc.end();
}

// ---------- Character Certificate (চরিত্র সনদ) ----------
// Short prose-style certificate rather than a label/value table — this is
// the conventional format for a character certificate (a certifying
// statement, not a data sheet).
function streamCharacterCertificate(stream, { student, className, schoolName, logoDataUrl, headTeacher, certNo, issueDate, extra = {} }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  const pageWidth = doc.page.width - 80;

  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), 40, 36, { width: 58, height: 58 });
    } catch (e) {}
  }

  doc.font("bn-bold").fontSize(20).text(schoolName || "School Name", { align: "center" });
  doc.moveDown(0.15);
  doc.font("bn-bold").fontSize(15).text("চরিত্র সনদ", { align: "center" });
  doc.font("bn").fontSize(10).fillColor("#666").text("(Certificate of Character)", { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(0.2);
  doc
    .font("bn")
    .fontSize(10)
    .fillColor("#444")
    .text(`সনদ নম্বর: ${certNo}   |   ইস্যুর তারিখ: ${issueDate}`, { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(1.5);

  const parents = [student.fatherName && `পিতা: ${student.fatherName}`, student.motherName && `মাতা: ${student.motherName}`]
    .filter(Boolean)
    .join(", ");
  const period = extra.leavingDate
    ? `${student.admissionDate || "—"} তারিখ থেকে ${extra.leavingDate} তারিখ পর্যন্ত`
    : `${student.admissionDate || "—"} তারিখ থেকে অদ্যাবধি`;
  const conduct = extra.conductRemark || "সন্তোষজনক";

  const bodyText =
    `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${student.name}${parents ? ` (${parents})` : ""}, ` +
    `জন্ম তারিখ ${student.dob || "—"}, এই প্রতিষ্ঠানের ${className} শ্রেণিতে ${period} অধ্যয়ন করেছে। ` +
    `বিদ্যালয়ে অবস্থানকালীন তার আচরণ ও চরিত্র ${conduct} ছিল। ` +
    `আমি তার ভবিষ্যৎ জীবনের সর্বাঙ্গীণ সাফল্য ও মঙ্গল কামনা করছি।`;

  doc.font("bn").fontSize(12).lineGap(6).text(bodyText, 40, doc.y, { width: pageWidth, align: "justify" });

  doc.moveDown(4);
  const sigY = doc.y;
  doc.font("bn").fontSize(11).text("_______________________", 40 + pageWidth - 220, sigY);
  doc.font("bn-bold").text(headTeacher.name || "প্রধান শিক্ষক", 40 + pageWidth - 220, sigY + 18);
  doc.font("bn").fontSize(9).fillColor("#666").text(headTeacher.designation || "প্রধান শিক্ষক", 40 + pageWidth - 220, sigY + 33);
  doc.fillColor("#000");

  doc.end();
}

// Small A5-ish payment receipt — one payment entry, printed as proof of
// what was collected. Kept intentionally simple (no itemized charge
// breakdown) since the full charge/payment history already lives on the
// student's fee ledger page on-screen; this is just the paper slip.
function streamFeeReceipt(stream, { schoolName, logoDataUrl, student, className, payment, appliedTo, balanceAfter, qrDataUrl }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A5", margin: 30, layout: "portrait" });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  const pageWidth = doc.page.width - 60;

  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), 30, 26, { width: 44, height: 44 });
    } catch (e) {}
  }

  // Verification QR, top-right corner — links to the public
  // /verify/receipt/:receiptNo page so a scanned or forwarded receipt can
  // be confirmed genuine without calling the office. Small caption under
  // it so it's obvious what scanning it does, not just decoration.
  if (qrDataUrl) {
    try {
      const qrSize = 46;
      const qrX = doc.page.width - 30 - qrSize;
      const base64 = String(qrDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), qrX, 24, { width: qrSize, height: qrSize });
      doc
        .font("bn")
        .fontSize(6.5)
        .fillColor("#888")
        .text("যাচাই করুন", qrX - 12, 24 + qrSize + 2, { width: qrSize + 24, align: "center" });
      doc.fillColor("#000");
    } catch (e) {}
  }

  doc.font("bn-bold").fontSize(16).text(schoolName || "School Name", 30, 30, { width: pageWidth, align: "center" });
  doc.moveDown(0.2);
  doc.font("bn-bold").fontSize(13).text("টাকা প্রাপ্তির রশিদ", { align: "center" });
  doc.moveDown(0.6);

  doc
    .moveTo(30, doc.y)
    .lineTo(30 + pageWidth, doc.y)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.5);

  const labelWidth = 130;
  const rows = [
    ["রশিদ নম্বর", payment.receiptNo || "-"],
    ["তারিখ", new Date(payment.date || payment.createdAt || Date.now()).toLocaleDateString("bn-BD")],
    ["শিক্ষার্থীর নাম", student.name],
    ["শ্রেণি", className],
    ["রোল/রেজি.", student.roll || student.registration || "-"],
  ];
  rows.forEach(([label, value]) => {
    const y = doc.y;
    doc.font("bn-bold").fontSize(11).text(label, 30, y, { width: labelWidth });
    doc.font("bn").fontSize(11).text(String(value ?? ""), 30 + labelWidth, y, { width: pageWidth - labelWidth });
    doc.moveDown(0.5);
  });

  doc.moveDown(0.4);
  doc
    .moveTo(30, doc.y)
    .lineTo(30 + pageWidth, doc.y)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.6);

  // Itemized breakdown — this one payment often covers more than one charge
  // at once (মাসিক বেতন + গাড়ি ভাড়া together, say), so list what it actually
  // settled instead of only the lump total, matching what was collected.
  if (Array.isArray(appliedTo) && appliedTo.length > 0) {
    doc.font("bn-bold").fontSize(11).text("বিবরণ", 30);
    doc.moveDown(0.3);
    appliedTo.forEach((item) => {
      const y = doc.y;
      doc.font("bn").fontSize(11).text(item.label, 30, y, { width: pageWidth - 90 });
      doc.font("bn").fontSize(11).text(`৳ ${toBnDigits(item.amount)}`, 30 + pageWidth - 90, y, { width: 90, align: "right" });
      doc.moveDown(0.4);
    });
    doc.moveDown(0.2);
    doc
      .moveTo(30, doc.y)
      .lineTo(30 + pageWidth, doc.y)
      .strokeColor("#eee")
      .stroke();
    doc.moveDown(0.5);
  }

  doc.font("bn-bold").fontSize(13).text(`মোট জমাকৃত টাকা: ৳ ${toBnDigits(payment.amount)}`, 30);
  doc.moveDown(0.2);
  if (payment.method) {
    doc.font("bn").fontSize(11).fillColor("#444").text(`মাধ্যম: ${payment.method}`, 30);
    doc.fillColor("#000");
    doc.moveDown(0.2);
  }
  if (payment.note) {
    doc.font("bn").fontSize(11).fillColor("#444").text(`নোট: ${payment.note}`, 30);
    doc.fillColor("#000");
    doc.moveDown(0.2);
  }
  doc.moveDown(0.2);
  const dueLabel = balanceAfter > 0 ? `বকেয়া আছে: ৳ ${toBnDigits(balanceAfter)}` : "কোনো বকেয়া নেই";
  doc.font("bn-bold").fontSize(11).fillColor(balanceAfter > 0 ? "#b91c1c" : "#15803d").text(dueLabel, 30);
  doc.fillColor("#000");

  doc.moveDown(2.5);
  const sigY = doc.y;
  doc.font("bn").fontSize(10).text("_______________________", 30, sigY);
  doc.text("গ্রহণকারীর স্বাক্ষর", 30, sigY + 16);

  doc.end();
}

/**
 * Draws one class's weekly routine onto the CURRENT page of an already-open
 * portrait PDFDocument. Periods run across the top as columns and weekdays
 * run down the left as rows.
 * routine: { offDays: [key], schedule: { dayKey: [{ subject, teacher }] } }
 * periodTimes: [string] (may be empty strings)
 * weekdays: [{ key, label }]
 */
function drawRoutinePage(doc, { schoolName, className, shift, routine, periodTimes, weekdays, periodCount, logoDataUrl }) {
  const pageWidth = doc.page.width - 80;

  if (logoDataUrl) {
    try {
      const base64 = String(logoDataUrl).split(",").pop();
      doc.image(Buffer.from(base64, "base64"), 40, 30, { width: 50, height: 50 });
    } catch (e) {}
  }

  doc.font("bn-bold").fontSize(17).text(schoolName || "School Name", 40, 34, { width: pageWidth, align: "center" });
  doc.moveDown(0.1);
  doc.font("bn-bold").fontSize(13).text("সাপ্তাহিক ক্লাস রুটিন", { align: "center" });
  doc.moveDown(0.1);
  doc
    .font("bn-bold")
    .fontSize(12)
    .fillColor("#000")
    .text(`${className}   —   ${shift === "morning" ? "মর্নিং শিফট" : "ডে শিফট"}`, { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(0.6);

  const workDays = weekdays.filter((d) => !(routine.offDays || []).includes(d.key));
  const dayColW = 82;
  const periodColW = (pageWidth - dayColW) / Math.max(periodCount, 1);
  const headerH = 34; // two lines: period ordinal + its time
  const baseRowH = 34;

  // Measure every cell up front so a subject/teacher name that wraps to two
  // lines (common once columns get narrower on a portrait page) never gets
  // squeezed into a row sized for one line — that used to push the subject
  // text upward past the row's own top edge and overlap the row above it.
  function cellContentHeight(subject, teacher) {
    let h = 0;
    if (subject) {
      doc.font("bn-bold").fontSize(10);
      h += doc.heightOfString(subject, { width: periodColW - 6, align: "center" });
    }
    if (teacher) {
      if (subject) h += 2;
      doc.font("bn").fontSize(9);
      h += doc.heightOfString(teacher, { width: periodColW - 6, align: "center" });
    }
    return h;
  }
  let maxCellH = 0;
  workDays.forEach((day) => {
    for (let i = 0; i < periodCount; i++) {
      const p = (routine.schedule[day.key] || [])[i] || {};
      if (!p.subject) continue;
      maxCellH = Math.max(maxCellH, cellContentHeight(p.subject, p.teacher));
    }
  });

  let y = doc.y;

  // Stretch rows to use the full page instead of capping row height low and
  // leaving a big blank gap above/below the table — a portrait page with
  // only 5-6 weekday rows has plenty of vertical room, so let rows grow to
  // fill it (a high ceiling only guards against one or two working days
  // producing absurdly tall rows).
  const availableHeight = doc.page.height - 40 - y; // 40 = bottom page margin
  const maxRowH = 140;
  let rowH = Math.max(baseRowH, maxCellH + 10);
  if (workDays.length > 0) {
    const roomyRowH = (availableHeight - headerH) / workDays.length;
    rowH = Math.max(rowH, Math.min(maxRowH, roomyRowH));
  }
  const tableHeight = headerH + rowH * workDays.length;
  const leftover = availableHeight - tableHeight;
  if (leftover > 0) y += leftover / 2;
  const tableTop = y;

  function drawCell(text, x, rowTop, h, opts = {}) {
    if (!text) return;
    const th = doc.heightOfString(text, opts);
    doc.text(text, x, rowTop + (h - th) / 2, opts);
  }

  // Header row: corner cell + one column per period
  doc.rect(40, y, pageWidth, headerH).fillAndStroke("#f0f0f0", "#999");
  doc.fillColor("#000").font("bn-bold").fontSize(11);
  drawCell("বার", 40, y, headerH, { width: dayColW, align: "center" });
  for (let i = 0; i < periodCount; i++) {
    doc.font("bn-bold").fontSize(10);
    const pLabel = periodOrdinal(i + 1) + (periodTimes[i] ? `\n${periodTimes[i]}` : "");
    drawCell(pLabel, 40 + dayColW + i * periodColW, y, headerH, { width: periodColW, align: "center" });
  }
  y += headerH;

  // Day rows
  workDays.forEach((day, di) => {
    const bg = di % 2 === 0 ? "#ffffff" : "#fafafa";
    doc.rect(40, y, pageWidth, rowH).fillAndStroke(bg, "#ddd");
    doc.fillColor("#000");

    doc.font("bn-bold").fontSize(10);
    drawCell(day.label, 40, y, rowH, { width: dayColW, align: "center" });

    for (let i = 0; i < periodCount; i++) {
      const p = (routine.schedule[day.key] || [])[i] || {};
      const x = 40 + dayColW + i * periodColW;
      if (p.subject) {
        doc.font("bn-bold").fontSize(10);
        const subjOpts = { width: periodColW - 6, align: "center" };
        const subjH = doc.heightOfString(p.subject, subjOpts);
        let teacherH = 0;
        if (p.teacher) {
          doc.font("bn").fontSize(9);
          teacherH = doc.heightOfString(p.teacher, { width: periodColW - 6, align: "center" });
        }
        const gap = p.teacher ? 2 : 0;
        const totalH = subjH + gap + teacherH;
        // Center the subject+teacher block as one unit within the row, and
        // never let it start above the row's own top edge — whatever
        // doesn't fit stays clipped inside this row instead of bleeding
        // into the row above.
        const startY = Math.max(y + 2, y + (rowH - totalH) / 2);
        doc.font("bn-bold").fontSize(10);
        doc.text(p.subject, x + 3, startY, subjOpts);
        if (p.teacher) {
          doc.font("bn").fontSize(9).fillColor("#333");
          doc.text(p.teacher, x + 3, startY + subjH + gap, { width: periodColW - 6, align: "center" });
          doc.fillColor("#000");
        }
      } else {
        doc.font("bn").fontSize(10).fillColor("#999");
        drawCell("—", x, y, rowH, { width: periodColW, align: "center" });
        doc.fillColor("#000");
      }
    }
    y += rowH;
  });

  // Outer border around the whole table
  doc
    .rect(40, tableTop, pageWidth, headerH + rowH * workDays.length)
    .strokeColor("#999")
    .stroke();
  doc.strokeColor("#000");
}

/**
 * Streams a multi-class routine PDF (one portrait page per class) to
 * `stream`. `pages` is an array of { className, shift, routine, periodTimes }.
 */
function streamRoutinePDF(stream, { schoolName, logoDataUrl, weekdays, periodCount, pages }) {
  stream.on("error", () => {});

  const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: 40 });
  doc.pipe(stream);
  doc.registerFont("bn", FONT_REGULAR);
  doc.registerFont("bn-bold", FONT_BOLD);

  pages.forEach((page, idx) => {
    if (idx > 0) doc.addPage({ size: "A4", layout: "portrait", margin: 40 });
    drawRoutinePage(doc, { schoolName, logoDataUrl, weekdays, periodCount, ...page });
  });

  doc.end();
}

function fontsAvailable() {
  try {
    const okReg = fs.existsSync(FONT_REGULAR) && fs.statSync(FONT_REGULAR).size > 50 * 1024;
    const okBold = fs.existsSync(FONT_BOLD) && fs.statSync(FONT_BOLD).size > 50 * 1024;
    return okReg && okBold;
  } catch {
    return false;
  }
}

module.exports = { streamProgressCard, streamAllProgressCards, streamAdmissionForm, streamRoutinePDF, streamFeeReceipt, streamTransferCertificate, streamCharacterCertificate, getGrade, fontsAvailable, periodOrdinal };
