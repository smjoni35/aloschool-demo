const crypto = require("crypto");
const db = require("./db");

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// ---------- Per-teacher ledger ----------
// Same running-ledger idea as lib/fees.js's student ledger: one list of
// charges (monthly salary earned, bonuses) and payments (withdrawals a
// teacher actually took) per teacher. The balance is just the sum, so
// advances, part-payments, and taking salary more than once in the same
// month all fall out of the same simple math with no special cases —
// exactly the pattern needed here since teachers commonly take salary
// early, take only part of it, or withdraw twice in one month.
function ledgerKey(teacherId) {
  return `salaryledger:${teacherId}`;
}

async function getLedger(teacherId) {
  return (await db.get(ledgerKey(teacherId))) || [];
}

async function addEntry(teacherId, entry) {
  const ledger = await getLedger(teacherId);
  const full = {
    id: shortId(),
    date: new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    ...entry,
  };
  ledger.push(full);
  await db.set(ledgerKey(teacherId), ledger);
  return full;
}

async function deleteEntry(teacherId, entryId) {
  const ledger = await getLedger(teacherId);
  const next = ledger.filter((e) => e.id !== entryId);
  await db.set(ledgerKey(teacherId), next);
  return next;
}

// charged = মোট বেতন ধার্য (কত টাকা বেতন হিসেবে ধরা হয়েছে)
// paid    = মোট উত্তোলন (শিক্ষক এ পর্যন্ত যা তুলে নিয়েছেন)
// due     = charged - paid → ধনাত্মক হলে বকেয়া পাওনা আছে শিক্ষকের,
//           ঋণাত্মক হলে বুঝতে হবে অগ্রিম নেওয়া আছে (এখনো তত টাকার বেতন ধার্যই হয়নি)
function computeBalance(ledger) {
  let charged = 0;
  let paid = 0;
  for (const e of ledger) {
    const amt = Number(e.amount) || 0;
    if (e.kind === "payment") paid += amt;
    else charged += amt;
  }
  return { charged, paid, due: charged - paid };
}

// ---------- Monthly salary ----------
// Adds one "charge" entry per teacher (their configured monthly salary) for
// the given month — skipped for teachers with no amount set, and never
// double-billed for the same month (checked via the `month` field), so
// this is safe to click more than once, same guard as
// fees.generateMonthlyCharges.
//
// A teacher who also teaches at the coaching center has a separate
// `coachingMonthlySalary` amount (set alongside their regular
// monthlySalary on the same admin-salary screen). That gets billed here
// too, as its own "coaching-monthly" charge in the *same* ledger — so a
// coaching teacher's regular and coaching salary combine into one
// balance/history/withdrawal flow instead of needing a separate page.
// Each of the two charge types has its own independent
// already-billed-this-month guard, so a teacher with only one of the two
// amounts set (or who already had one billed but not the other) is
// handled correctly either way.
async function generateMonthlySalary(month) {
  const teachers = (await db.get("teachers")) || [];
  let teachersCharged = 0;
  let coachingCharged = 0;
  const teachersSkipped = [];

  for (const teacher of teachers) {
    const amount = Number(teacher.monthlySalary) || 0;
    const coachingAmount = Number(teacher.coachingMonthlySalary) || 0;

    if (!amount && !coachingAmount) {
      teachersSkipped.push(teacher.name);
      continue;
    }

    if (amount) {
      const ledger = await getLedger(teacher.id);
      const already = ledger.some((e) => e.type === "monthly" && e.month === month);
      if (!already) {
        await addEntry(teacher.id, {
          kind: "charge",
          type: "monthly",
          label: `মাসিক বেতন (${month})`,
          amount,
          month,
          date: `${month}-01`,
        });
        teachersCharged += 1;
      }
    }

    if (coachingAmount) {
      const ledger = await getLedger(teacher.id);
      const alreadyCoaching = ledger.some((e) => e.type === "coaching-monthly" && e.month === month);
      if (!alreadyCoaching) {
        await addEntry(teacher.id, {
          kind: "charge",
          type: "coaching-monthly",
          label: `কোচিং বেতন (${month})`,
          amount: coachingAmount,
          month,
          date: `${month}-01`,
        });
        coachingCharged += 1;
      }
    }
  }
  return { teachersCharged, coachingCharged, teachersSkipped };
}

// ---------- Withdrawals (ordinary, partial, or advance) ----------
// No restriction on count or amount per month — a teacher can withdraw
// twice in the same month, take only part of what's due, or take an
// advance before any salary has even been charged yet (the ledger simply
// goes negative-due in that case). `isAdvance` only changes the label
// shown in the history, not the math.
async function addWithdrawal(teacherId, { amount, note, date, isAdvance }) {
  return addEntry(teacherId, {
    kind: "payment",
    type: "withdrawal",
    label: isAdvance ? "অগ্রিম বেতন উত্তোলন" : "বেতন উত্তোলন",
    amount: Number(amount) || 0,
    note: note || "",
    ...(date ? { date } : {}),
  });
}

// ---------- One-off charges (বোনাস / অতিরিক্ত পাওনা) ----------
async function addOneOffCharge(teacherId, { label, amount, note, date }) {
  return addEntry(teacherId, {
    kind: "charge",
    type: "adhoc",
    label: label || "অতিরিক্ত পাওনা",
    amount: Number(amount) || 0,
    note: note || "",
    ...(date ? { date } : {}),
  });
}

// ---------- Across all teachers (for the report page) ----------
// Returns every teacher with a non-zero balance — due > 0 means the
// school owes them unpaid salary, due < 0 means they've taken an advance
// beyond what's been charged so far.
async function allBalances() {
  const teachers = (await db.get("teachers")) || [];
  const rows = [];
  for (const teacher of teachers) {
    const ledger = await getLedger(teacher.id);
    const balance = computeBalance(ledger);
    if (balance.due !== 0) rows.push({ teacher, balance });
  }
  return rows;
}

// ---------- This month's salary payouts (admin dashboard ব্যয় card) ----------
// Sums actual withdrawals (kind: "payment" — money that has really left
// the school, not just the charged/ধার্য amount) across every teacher's
// ledger, for entries dated this month. Same ledger-walk pattern as
// fees.schoolFeeSummary().
async function schoolSalaryPaidThisMonth(yearMonth) {
  const teachers = (await db.get("teachers")) || [];
  let total = 0;
  for (const teacher of teachers) {
    const ledger = await getLedger(teacher.id);
    for (const e of ledger) {
      if (e.kind === "payment" && (e.date || "").startsWith(yearMonth)) {
        total += Number(e.amount) || 0;
      }
    }
  }
  return total;
}

module.exports = {
  getLedger,
  addEntry,
  deleteEntry,
  computeBalance,
  generateMonthlySalary,
  addWithdrawal,
  addOneOffCharge,
  allBalances,
  schoolSalaryPaidThisMonth,
};
