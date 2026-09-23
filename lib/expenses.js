const crypto = require("crypto");
const db = require("./db");

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

const KEY = "expenses";

// Quick-select categories on the entry form — admin can still type a
// custom category; these are just the common ones (বিদ্যুৎ বিল, চিকিৎসা,
// মেটেরিয়াল ইত্যাদি) so most entries are one tap.
const CATEGORIES = ["বিদ্যুৎ বিল", "চিকিৎসা", "মেটেরিয়াল / সরঞ্জাম", "ভাড়া", "মেরামত", "অন্যান্য"];

async function listExpenses() {
  return (await db.get(KEY)) || [];
}

// Stored newest-first so the list page and any "recent expenses" view
// don't need to sort on every read.
async function addExpense({ category, amount, note, date }) {
  const list = await listExpenses();
  const entry = {
    id: shortId(),
    category: category || "অন্যান্য",
    amount: Number(amount) || 0,
    note: note || "",
    date: date || new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
  };
  list.unshift(entry);
  await db.set(KEY, list);
  return entry;
}

async function deleteExpense(id) {
  const list = await listExpenses();
  const next = list.filter((e) => e.id !== id);
  await db.set(KEY, next);
  return next;
}

async function monthlyTotal(yearMonth) {
  const list = await listExpenses();
  return list.filter((e) => (e.date || "").startsWith(yearMonth)).reduce((sum, e) => sum + e.amount, 0);
}

module.exports = { CATEGORIES, listExpenses, addExpense, deleteExpense, monthlyTotal };
