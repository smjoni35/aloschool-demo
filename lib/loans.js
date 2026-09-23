const crypto = require("crypto");
const db = require("./db");

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

const KEY = "loans";

// পরিচালক বিভিন্ন উৎস থেকে ঋণ নিতে পারেন — ব্যাংক, ব্যক্তি, প্রতিষ্ঠান।
// উৎস ফ্রি-টেক্সট রাখা হলো যাতে যেকোনো নাম লেখা যায়।
const REPAYMENT_TYPES = ["এককালীন", "মাসিক কিস্তি"];

async function listLoans() {
  return (await db.get(KEY)) || [];
}

async function getLoan(id) {
  const list = await listLoans();
  return list.find((l) => l.id === id) || null;
}

// প্রতিটি ঋণ তার নিজের payments লগ বহন করে — কিস্তি/আংশিক পরিশোধ যোগ হলে
// এখানেই জমা হয়, যাতে বাকি ব্যালেন্স সবসময় পেমেন্ট থেকেই হিসাব করা যায়
// (আলাদা করে "paid so far" ফিল্ড রেখে দুই জায়গায় সিঙ্ক করার ঝুঁকি নেই)।
async function addLoan({ lender, amount, date, interestRate, repaymentType, note }) {
  const list = await listLoans();
  const entry = {
    id: shortId(),
    lender: lender || "অজ্ঞাত উৎস",
    amount: Number(amount) || 0,
    date: date || new Date().toISOString().slice(0, 10),
    interestRate: interestRate ? Number(interestRate) : null,
    repaymentType: repaymentType || "এককালীন",
    note: note || "",
    payments: [],
    createdAt: Date.now(),
  };
  list.unshift(entry);
  await db.set(KEY, list);
  return entry;
}

async function deleteLoan(id) {
  const list = await listLoans();
  const next = list.filter((l) => l.id !== id);
  await db.set(KEY, next);
  return next;
}

async function addPayment(loanId, { amount, date, note }) {
  const list = await listLoans();
  const loan = list.find((l) => l.id === loanId);
  if (!loan) return null;
  const payment = {
    id: shortId(),
    amount: Number(amount) || 0,
    date: date || new Date().toISOString().slice(0, 10),
    note: note || "",
    createdAt: Date.now(),
  };
  loan.payments.unshift(payment);
  await db.set(KEY, list);
  return payment;
}

async function deletePayment(loanId, paymentId) {
  const list = await listLoans();
  const loan = list.find((l) => l.id === loanId);
  if (!loan) return null;
  loan.payments = loan.payments.filter((p) => p.id !== paymentId);
  await db.set(KEY, list);
  return loan;
}

// ঋণের সারাংশ — মোট পরিশোধিত, বাকি, ও অবস্থা (চলমান/পরিশোধিত) সবসময়
// payments থেকে হিসাব করে দেওয়া হয়, স্টোর করা হয় না।
function withSummary(loan) {
  const totalPaid = loan.payments.reduce((sum, p) => sum + p.amount, 0);
  const remaining = Math.max(loan.amount - totalPaid, 0);
  return {
    ...loan,
    totalPaid,
    remaining,
    status: remaining <= 0 ? "পরিশোধিত" : "চলমান",
  };
}

async function listLoansWithSummary() {
  const list = await listLoans();
  return list.map(withSummary);
}

async function getLoanWithSummary(id) {
  const loan = await getLoan(id);
  return loan ? withSummary(loan) : null;
}

// ড্যাশবোর্ডের "এই মাসের ব্যয়" কার্ডে যোগ করার জন্য — এই মাসে ঋণ বাবদ
// আসলে কত টাকা পরিশোধ করা হয়েছে (নতুন ঋণ নেওয়ার অঙ্ক নয়)।
async function monthlyRepaymentTotal(yearMonth) {
  const list = await listLoans();
  let total = 0;
  for (const loan of list) {
    for (const p of loan.payments) {
      if ((p.date || "").startsWith(yearMonth)) total += p.amount;
    }
  }
  return total;
}

// সব ঋণ মিলিয়ে মোট বকেয়া দায় — ব্যালেন্স-শিট আইটেম, মাসিক আয়-ব্যয়ের
// হিসাবের বাইরে আলাদাভাবে দেখানো হয়।
async function totalOutstanding() {
  const list = await listLoansWithSummary();
  return list.reduce((sum, l) => sum + l.remaining, 0);
}

module.exports = {
  REPAYMENT_TYPES,
  listLoans,
  getLoan,
  addLoan,
  deleteLoan,
  addPayment,
  deletePayment,
  listLoansWithSummary,
  getLoanWithSummary,
  monthlyRepaymentTotal,
  totalOutstanding,
};
