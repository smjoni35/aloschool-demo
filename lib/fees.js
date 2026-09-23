const crypto = require("crypto");
const db = require("./db");

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// ---------- Fee structure (per class, per session) ----------
// One structure per class+session so fees can change year to year without
// touching old records — e.g. raising মাসিক বেতন for 2027 leaves every
// 2026 charge exactly as it was billed.
function structureKey(classSlug, session) {
  return `feestructure:${classSlug}:${session}`;
}

async function getFeeStructure(classSlug, session) {
  return (
    (await db.get(structureKey(classSlug, session))) || {
      classSlug,
      session,
      admissionItems: [],
      sessionFee: 0,
      monthlyTuition: 0,
      transportMonthly: 0,
      coachingMonthly: 0,
      examFees: { quarterly: 0, halfYearly: 0, annual: 0 },
    }
  );
}

// Saves just the scalar amounts (সেশন ফি, মাসিক বেতন, গাড়ি ভাড়া, কোচিং
// বেতন, পরীক্ষার ফি) — admission items are managed separately, one at a
// time, below.
async function saveFeeAmounts(classSlug, session, data) {
  const structure = await getFeeStructure(classSlug, session);
  structure.sessionFee = Number(data.sessionFee) || 0;
  structure.monthlyTuition = Number(data.monthlyTuition) || 0;
  structure.transportMonthly = Number(data.transportMonthly) || 0;
  structure.coachingMonthly = Number(data.coachingMonthly) || 0;
  structure.examFees = {
    quarterly: Number(data.examFees?.quarterly) || 0,
    halfYearly: Number(data.examFees?.halfYearly) || 0,
    annual: Number(data.examFees?.annual) || 0,
  };
  await db.set(structureKey(classSlug, session), structure);
  return structure;
}

// Admission items (ভর্তি ফি, আইডি কার্ড, রশিদ বই, ডায়েরী ...) are added and
// removed one at a time, same UX as adding a subject to an exam elsewhere
// in this app — simpler to use on a phone than a multi-row form.
async function addAdmissionItem(classSlug, session, { name, amount }) {
  const structure = await getFeeStructure(classSlug, session);
  structure.admissionItems.push({ id: shortId(), name: (name || "").trim(), amount: Number(amount) || 0 });
  await db.set(structureKey(classSlug, session), structure);
  return structure;
}

async function removeAdmissionItem(classSlug, session, itemId) {
  const structure = await getFeeStructure(classSlug, session);
  structure.admissionItems = structure.admissionItems.filter((it) => it.id !== itemId);
  await db.set(structureKey(classSlug, session), structure);
  return structure;
}

// ---------- Per-student ledger ----------
// A single running list of charges (debits) and payments (credits) per
// student — no separate "invoice" objects. The balance is just the sum,
// same idea as a bank statement, which keeps partial payments, advances,
// and dues all falling out of the same simple math instead of needing
// special cases for each.
function ledgerKey(studentId) {
  return `feeledger:${studentId}`;
}

async function getLedger(studentId) {
  return (await db.get(ledgerKey(studentId))) || [];
}

async function addEntry(studentId, entry) {
  const ledger = await getLedger(studentId);
  const full = {
    id: shortId(),
    date: new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    ...entry,
  };
  ledger.push(full);
  await db.set(ledgerKey(studentId), ledger);
  return full;
}

async function deleteEntry(studentId, entryId) {
  const ledger = await getLedger(studentId);
  const next = ledger.filter((e) => e.id !== entryId);
  await db.set(ledgerKey(studentId), next);
  return next;
}

function computeBalance(ledger) {
  let charged = 0;
  let paid = 0;
  let discounted = 0;
  for (const e of ledger) {
    const amt = Number(e.amount) || 0;
    if (e.kind === "payment") paid += amt;
    else if (e.kind === "discount") discounted += amt;
    else charged += amt;
  }
  return { charged, paid, discounted, due: charged - paid - discounted };
}

// ---------- Receipt numbering ----------
// Same per-calendar-year counter pattern as ভর্তি আবেদন numbers
// (generateAdmissionNo in server.js) — restarts at 0001 every new year.
async function nextReceiptNo() {
  const year = new Date().getFullYear();
  const counterKey = `feeReceipt:counter:${year}`;
  const counter = ((await db.get(counterKey)) || 0) + 1;
  await db.set(counterKey, counter);
  return `RCPT-${year}-${String(counter).padStart(4, "0")}`;
}

// ---------- Admission-time one-off charges ----------
// Bills every configured admission item (ভর্তি ফি, আইডি কার্ড, রশিদ বই,
// ডায়েরী ...) plus the session fee, all at once, dated the student's
// admission date. Guarded so re-approving or re-running never double-bills.
async function chargeAdmissionItems(studentId, classSlug, session, admissionDate) {
  const existing = await getLedger(studentId);
  const alreadyCharged = existing.some((e) => e.type === "admission" || e.type === "session");
  if (alreadyCharged) return { added: 0 };

  const structure = await getFeeStructure(classSlug, session);
  const date = admissionDate || new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const item of structure.admissionItems) {
    if (!item.name || !item.amount) continue;
    await addEntry(studentId, {
      kind: "charge",
      type: "admission",
      label: item.name,
      amount: Number(item.amount) || 0,
      date,
      session,
    });
    added += 1;
  }
  if (structure.sessionFee) {
    await addEntry(studentId, {
      kind: "charge",
      type: "session",
      label: `সেশন ফি (${session})`,
      amount: structure.sessionFee,
      date,
      session,
    });
    added += 1;
  }
  return { added };
}

// A student admitted in advance for a *future* session hasn't actually
// joined this class yet (see lib/promotion.js / lib/attendance.js for the
// same concept) — they must not be billed monthly tuition, transport, or
// exam fees for a session/month before their own session has started.
// Kept as a small local copy (same pattern as promotion.js's own slugify
// duplicate) so this module has no dependency on the others.
function isHeldForFutureSession(student, session) {
  const s = parseInt(student && student.session, 10);
  const p = parseInt(session, 10);
  if (Number.isNaN(s) || Number.isNaN(p)) return false;
  return s > p;
}

// ---------- Standing (recurring) discount ----------
// Config lives directly on the student record (discountType, discountValue,
// discountNote, discountUntilSession) — same "settings live on the student"
// pattern already used for transportEnabled. Applied automatically every
// month tuition is charged (see generateMonthlyCharges below) so nobody has
// to remember to re-apply a sibling/staff/scholarship discount by hand.
// discountUntilSession empty/unset = applies indefinitely (e.g. sibling or
// staff-child discount); set to a session (e.g. "2026") for a discount that
// should stop applying after that session (e.g. a one-session scholarship).
function isStandingDiscountActive(student, session) {
  if (!student || !student.discountType || !(Number(student.discountValue) > 0)) return false;
  if (!student.discountUntilSession) return true;
  const until = parseInt(student.discountUntilSession, 10);
  const cur = parseInt(session, 10);
  if (Number.isNaN(until) || Number.isNaN(cur)) return true;
  return until >= cur;
}

// Never lets the discount exceed the charge it's discounting (a mistyped
// flat amount or a >100% typo can't flip a charge into a net credit).
function computeStandingDiscountAmount(student, session, chargeAmount) {
  if (!isStandingDiscountActive(student, session)) return 0;
  const base = Number(chargeAmount) || 0;
  const amount =
    student.discountType === "percent"
      ? Math.round((base * Number(student.discountValue)) / 100)
      : Number(student.discountValue) || 0;
  return Math.max(0, Math.min(amount, base));
}

// ---------- Ad-hoc (one-time) discount / waiver ----------
async function addDiscount(studentId, { label, amount, note, date }) {
  return addEntry(studentId, {
    kind: "discount",
    type: "adhocDiscount",
    label: (label || "").trim() || "ছাড় / মওকুফ",
    amount: Number(amount) || 0,
    note: note || "",
    ...(date ? { date } : {}),
  });
}

// ---------- Monthly tuition + transport ----------
// Bills every student in every class that has a fee structure configured
// for the given session, one charge per student per month — skipped for
// students who hadn't been admitted yet that month, and never billed
// twice for the same month (checked via the `month` field on existing
// charges), so this is safe to run more than once.
async function generateMonthlyCharges(session, month) {
  const classes = (await db.get("classlist")) || [];
  let studentsCharged = 0;
  const classesSkipped = [];

  for (const cls of classes) {
    const structure = await getFeeStructure(cls.slug, session);
    if (!structure.monthlyTuition && !structure.transportMonthly && !structure.coachingMonthly) {
      classesSkipped.push(cls.name);
      continue;
    }
    const allStudents = (await db.get(`students:${cls.slug}`)) || [];
    const students = allStudents.filter((s) => !isHeldForFutureSession(s, session));
    for (const student of students) {
      // Don't bill a month before the student actually joined.
      if (student.admissionDate && student.admissionDate.slice(0, 7) > month) continue;

      const ledger = await getLedger(student.id);
      const hasMonthly = ledger.some((e) => e.type === "monthly" && e.month === month);
      if (!hasMonthly && structure.monthlyTuition) {
        await addEntry(student.id, {
          kind: "charge",
          type: "monthly",
          label: `মাসিক বেতন (${month})`,
          amount: structure.monthlyTuition,
          month,
          date: `${month}-01`,
        });
        studentsCharged += 1;

        const discAmount = computeStandingDiscountAmount(student, session, structure.monthlyTuition);
        if (discAmount > 0) {
          await addEntry(student.id, {
            kind: "discount",
            type: "standingDiscount",
            label: `ছাড় — ${student.discountNote || (student.discountType === "percent" ? student.discountValue + "%" : "নির্ধারিত ছাড়")} (${month})`,
            amount: discAmount,
            month,
            date: `${month}-01`,
          });
        }
      }

      const hasTransport = ledger.some((e) => e.type === "transport" && e.month === month);
      // A student's own transportFee (set on their profile, e.g. for a
      // longer commute) overrides the class's flat transportMonthly rate —
      // same "per-student override, falls back to the class default"
      // pattern as computeStandingDiscountAmount above.
      const transportAmount = Number(student.transportFee) > 0 ? Number(student.transportFee) : structure.transportMonthly;
      if (!hasTransport && transportAmount && student.transportEnabled) {
        await addEntry(student.id, {
          kind: "charge",
          type: "transport",
          label: `গাড়ি ভাড়া (${month})`,
          amount: transportAmount,
          month,
          date: `${month}-01`,
        });
      }

      const hasCoaching = ledger.some((e) => e.type === "coaching" && e.month === month);
      // Same per-student override pattern as transport above — a
      // student's own coachingFee (set on their profile) overrides the
      // class's flat coachingMonthly rate, for students taking extra
      // coaching/অতিরিক্ত ক্লাস beyond regular school hours.
      const coachingAmount = Number(student.coachingFee) > 0 ? Number(student.coachingFee) : structure.coachingMonthly;
      if (!hasCoaching && coachingAmount && student.coachingEnabled) {
        await addEntry(student.id, {
          kind: "charge",
          type: "coaching",
          label: `কোচিং বেতন (${month})`,
          amount: coachingAmount,
          month,
          date: `${month}-01`,
        });
      }
    }
  }
  return { studentsCharged, classesSkipped };
}

// ---------- Auto-run guard for monthly charge generation ----------
// generateMonthlyCharges above only ever ran when an admin visited
// /admin/fees and clicked "মাসিক বেতন জেনারেট করুন" by hand — so on a free
// Render instance that sleeps between visits, a new month could arrive
// with nobody remembering to click it. Result: every student's ledger
// stays charge-free all month, so schoolFeeSummary's totalDue and
// thisMonthPaid are stuck at ৳0, while the dashboard's separate
// "মোট ফি (মাসিক প্রত্যাশিত)" estimate (structure × active roster, not
// ledger-based) keeps showing a nonzero number — the mismatch seen on
// the dashboard. This runs the generation once per session+month,
// automatically, the first time anyone loads the dashboard after the
// month turns over, using a small marker in the db so it never re-runs
// (and never double-charges) for a month it's already handled.
async function ensureMonthlyChargesAutoRun(session, month) {
  const flagKey = "feeAutoGen:lastRun";
  const marker = `${session}:${month}`;
  const last = await db.get(flagKey);
  if (last === marker) return null;
  const result = await generateMonthlyCharges(session, month);
  await db.set(flagKey, marker);
  return result;
}

// ---------- Exam fee ----------
// Matches an exam's name against the three exam types a fee amount can be
// set for — same substring-matching idea as findAnnualExamsBySession in
// lib/promotion.js. "অর্ধ" is checked before the plain "বার্ষিক" check
// since "অর্ধ বার্ষিক পরীক্ষা" also contains the word "বার্ষিক".
function examFeeType(examName) {
  const name = examName || "";
  if (name.includes("অর্ধ")) return "halfYearly";
  if (name.includes("বার্ষিক")) return "annual";
  if (name.includes("ত্রি") || name.includes("ত্রৈ") || name.includes("কোয়ার্টার")) return "quarterly";
  return null;
}

// `examEntries` is the group of examlist rows sharing one examName+session
// (one row per class). Bills every student in every one of those classes
// the amount configured for that exam type in that class's fee structure —
// skips a class silently if no amount is set, and never double-bills a
// student for the same exam key.
async function generateExamCharges(examEntries) {
  let studentsCharged = 0;
  const classesSkipped = [];

  for (const entry of examEntries) {
    const exam = await db.get(`exam:${entry.key}`);
    if (!exam) continue;
    const feeType = examFeeType(exam.examName);
    if (!feeType) {
      classesSkipped.push(`${exam.className} (পরীক্ষার নাম থেকে ধরণ বোঝা যায়নি)`);
      continue;
    }
    const structure = await getFeeStructure(exam.classSlug, exam.session);
    const amount = structure.examFees[feeType];
    if (!amount) {
      classesSkipped.push(`${exam.className} (এই ধরণের পরীক্ষার ফি নির্ধারণ করা নেই)`);
      continue;
    }
    const allStudents = (await db.get(`students:${exam.classSlug}`)) || [];
    // Same future-session holdback as generateMonthlyCharges — a student
    // admitted in advance for next session hasn't sat this exam.
    const students = allStudents.filter((s) => !isHeldForFutureSession(s, exam.session));
    for (const student of students) {
      const ledger = await getLedger(student.id);
      const already = ledger.some((e) => e.type === "exam" && e.examKey === exam.key);
      if (already) continue;
      await addEntry(student.id, {
        kind: "charge",
        type: "exam",
        label: `পরীক্ষার ফি — ${exam.examName}`,
        amount,
        examKey: exam.key,
      });
      studentsCharged += 1;
    }
  }
  return { studentsCharged, classesSkipped };
}

// ---------- Ad-hoc charges & payments ----------
async function addOneOffCharge(studentId, { label, amount, note, date }) {
  return addEntry(studentId, {
    kind: "charge",
    type: "adhoc",
    label: label || "অন্যান্য",
    amount: Number(amount) || 0,
    note: note || "",
    ...(date ? { date } : {}),
  });
}

// ---------- Receipt verification (public QR lookup) ----------
// A receipt's number alone doesn't say which student/ledger it lives in
// (ledgers are stored per student, not indexed by receipt number), so a
// small reverse-lookup record is kept alongside the payment entry itself
// — same "index record next to the real data" idea as feeReceipt:counter
// above. This is what the public /verify/receipt/:receiptNo page and the
// QR code printed on the receipt PDF both read from.
function receiptIndexKey(receiptNo) {
  return `feeReceiptIndex:${receiptNo}`;
}

async function findReceiptIndex(receiptNo) {
  const no = (receiptNo || "").trim();
  if (!no) return null;
  const direct = await db.get(receiptIndexKey(no));
  if (direct) return direct;

  // Fallback for receipts issued before this index existed — brute-force
  // scan every student's ledger for a payment entry with this receipt
  // number (fine for a small school's roster size). Backfills the index
  // once found so the next lookup for the same receipt is instant again.
  const classes = (await db.get("classlist")) || [];
  for (const cls of classes) {
    const students = (await db.get(`students:${cls.slug}`)) || [];
    for (const student of students) {
      const ledger = await getLedger(student.id);
      const entry = ledger.find((e) => e.kind === "payment" && e.receiptNo === no);
      if (entry) {
        const found = { studentId: student.id, classSlug: cls.slug, entryId: entry.id };
        await db.set(receiptIndexKey(no), found);
        return found;
      }
    }
  }
  return null;
}

async function addPayment(studentId, { amount, method, note, date, classSlug }) {
  const receiptNo = await nextReceiptNo();
  const entry = await addEntry(studentId, {
    kind: "payment",
    type: "payment",
    label: "পেমেন্ট",
    amount: Number(amount) || 0,
    method: method || "",
    note: note || "",
    receiptNo,
    ...(date ? { date } : {}),
  });
  if (classSlug) {
    await db.set(receiptIndexKey(receiptNo), { studentId, classSlug, entryId: entry.id });
  }
  return entry;
}

// ---------- Dues across a whole class (for the report page) ----------
async function classDues(classSlug) {
  const students = (await db.get(`students:${classSlug}`)) || [];
  const rows = [];
  for (const student of students) {
    const ledger = await getLedger(student.id);
    const balance = computeBalance(ledger);
    if (balance.due > 0) rows.push({ student, balance });
  }
  return rows;
}

// ---------- School-wide fee summary (admin dashboard card) ----------
// Walks every student's ledger once and accumulates everything the
// dashboard's ফি সারাংশ widget needs — same per-student computeBalance()
// math the বকেয়া রিপোর্ট page already uses, just totalled across every
// class instead of filtered to one, plus this month's payments picked out
// by entry date.
async function schoolFeeSummary(classSlugs, yearMonth) {
  let totalCharged = 0;
  let totalPaid = 0;
  let totalDue = 0;
  let studentsWithDue = 0;
  let thisMonthPaid = 0;

  const rosters = await Promise.all(classSlugs.map((slug) => db.get(`students:${slug}`)));
  const allStudents = rosters.flatMap((roster) => roster || []);
  const ledgers = await Promise.all(allStudents.map((student) => getLedger(student.id)));

  for (const ledger of ledgers) {
    const balance = computeBalance(ledger);
    totalCharged += balance.charged;
    totalPaid += balance.paid;
    if (balance.due > 0) {
      totalDue += balance.due;
      studentsWithDue += 1;
    }
    for (const e of ledger) {
      if (e.kind === "payment" && (e.date || "").startsWith(yearMonth)) {
        thisMonthPaid += Number(e.amount) || 0;
      }
    }
  }
  return { totalCharged, totalPaid, totalDue, studentsWithDue, thisMonthPaid };
}

// ---------- Monthly fee-collection trend (admin dashboard chart) ----------
// Walks every student's ledger once (same payment entries schoolFeeSummary
// reads) and buckets "payment" amounts by their entry date's YYYY-MM, for
// the last `months` calendar months ending at the current one. Used to draw
// a simple bar chart of collections over time on the dashboard.
async function monthlyCollectionTrend(classSlugs, months = 6) {
  const rosters = await Promise.all(classSlugs.map((slug) => db.get(`students:${slug}`)));
  const allStudents = rosters.flatMap((roster) => roster || []);
  const ledgers = await Promise.all(allStudents.map((student) => getLedger(student.id)));

  const totalsByMonth = {};
  for (const ledger of ledgers) {
    for (const e of ledger) {
      if (e.kind !== "payment") continue;
      const ym = (e.date || "").slice(0, 7); // "YYYY-MM"
      if (!ym) continue;
      totalsByMonth[ym] = (totalsByMonth[ym] || 0) + (Number(e.amount) || 0);
    }
  }

  const BN_MONTH_SHORT = ["জানু", "ফেব্রু", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্ট", "অক্টো", "নভে", "ডিসে"];
  const now = new Date();
  const result = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    result.push({ yearMonth: ym, label: BN_MONTH_SHORT[d.getMonth()], amount: totalsByMonth[ym] || 0 });
  }
  return result;
}

// ---------- Payment allocation (for itemized receipts) ----------
// Payments aren't linked to specific charges — same running-ledger/bank-
// statement model as computeBalance above — so a single "জমা" can quietly
// cover this month's মাসিক বেতন *and* গাড়ি ভাড়া at once. A receipt still
// needs to show that split. This walks the ledger chronologically and
// applies each payment/discount to the oldest still-open charge first
// (the usual "oldest debt settled first" convention), then reports which
// open charges the target payment's money actually landed on — so the
// receipt can print "মাসিক বেতন (মাস) — ৳X" and "গাড়ি ভাড়া (মাস) — ৳Y"
// as separate lines instead of one opaque lump sum.
async function getPaymentAllocation(studentId, entryId) {
  const ledger = await getLedger(studentId);
  const sorted = ledger
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.createdAt - b.createdAt);

  const open = []; // FIFO queue of { label, remaining }
  const appliedTo = [];
  let balanceBefore = 0;
  let balanceAfter = 0;
  let found = false;

  for (const e of sorted) {
    const amt = Number(e.amount) || 0;
    if (e.kind === "charge") {
      open.push({ label: e.label, remaining: amt });
      balanceAfter += amt;
      continue;
    }
    // payment or discount — settles the oldest open charge(s) first
    const isTarget = e.id === entryId;
    if (isTarget) balanceBefore = balanceAfter;
    let toApply = amt;
    while (toApply > 0 && open.length > 0) {
      const item = open[0];
      const take = Math.min(item.remaining, toApply);
      item.remaining -= take;
      toApply -= take;
      if (isTarget && take > 0) appliedTo.push({ label: item.label, amount: take });
      if (item.remaining <= 0) open.shift();
    }
    if (isTarget && e.kind === "payment" && toApply > 0) {
      // Paid more than was due — the extra sits as an advance/credit.
      appliedTo.push({ label: "অগ্রিম (ভবিষ্যতের জন্য জমা)", amount: toApply });
    }
    balanceAfter -= amt;
    if (isTarget) found = true;
  }

  // Merge repeated labels (e.g. a charge settled in two chunks by the same
  // payment) so the receipt shows one line per item, not duplicates.
  const merged = [];
  const index = {};
  for (const a of appliedTo) {
    if (index[a.label] === undefined) {
      index[a.label] = merged.length;
      merged.push({ label: a.label, amount: a.amount });
    } else {
      merged[index[a.label]].amount += a.amount;
    }
  }

  return { found, appliedTo: merged, balanceBefore, balanceAfter };
}

// Wipes every student's fee ledger completely (every charge and payment,
// every class) — meant for clearing out test/demo entries before real
// billing starts, not for routine use. Irreversible: there is no undo
// once this runs. Returns how many student ledgers were actually reset
// (skips students that had no ledger key at all, so the count reflects
// what really changed).
async function resetAllLedgers(classSlugs) {
  const rosters = await Promise.all(classSlugs.map((slug) => db.get(`students:${slug}`)));
  const allStudents = rosters.flatMap((roster) => roster || []);
  let count = 0;
  for (const student of allStudents) {
    const existing = await db.get(ledgerKey(student.id));
    if (existing && existing.length > 0) count += 1;
    await db.set(ledgerKey(student.id), []);
  }
  return count;
}

module.exports = {
  getFeeStructure,
  saveFeeAmounts,
  addAdmissionItem,
  removeAdmissionItem,
  getLedger,
  addEntry,
  deleteEntry,
  computeBalance,
  chargeAdmissionItems,
  generateMonthlyCharges,
  ensureMonthlyChargesAutoRun,
  generateExamCharges,
  examFeeType,
  addOneOffCharge,
  addPayment,
  findReceiptIndex,
  addDiscount,
  isStandingDiscountActive,
  computeStandingDiscountAmount,
  classDues,
  schoolFeeSummary,
  monthlyCollectionTrend,
  getPaymentAllocation,
  resetAllLedgers,
};
