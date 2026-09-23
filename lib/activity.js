const crypto = require("crypto");
const db = require("./db");
const telegram = require("./telegram");

const KEY = "activityLog";
// Only the last few entries are ever shown (dashboard card), so the list
// is capped well above that to leave a little scrollback room without
// growing without bound.
const MAX_ENTRIES = 50;
// Entries older than this are dropped automatically — nobody needs to
// remember to clean this list up by hand for it to stay tidy over time.
const AUTO_DELETE_DAYS = 30;

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// icon + color per activity type, kept here (not in the view) so every
// call site that logs a "fee" event, say, automatically gets the same
// look without repeating the styling at each call site.
const STYLE = {
  admission_submitted: { icon: "📝", bg: "#dbeafe", color: "#2563eb" },
  admission_approved: { icon: "🧑", bg: "#dcfce7", color: "#16a34a" },
  fee_payment: { icon: "💳", bg: "#ede9fe", color: "#7c3aed" },
  attendance: { icon: "✅", bg: "#d1fae5", color: "#059669" },
  expense: { icon: "🧾", bg: "#fee2e2", color: "#dc2626" },
  loan: { icon: "🏦", bg: "#fef3c7", color: "#92400e" },
  "loan-payment": { icon: "🏦", bg: "#d1fae5", color: "#059669" },
};

// Bangla label per type, used as the Telegram message's bold headline.
// Falls back to a generic "নোটিফিকেশন" for any type not listed here.
const TYPE_LABEL = {
  admission_submitted: "নতুন ভর্তির আবেদন",
  admission_approved: "ভর্তি সম্পন্ন",
  fee_payment: "ফি জমা",
  fee_discount: "ফি ছাড়/মওকুফ",
  attendance: "উপস্থিতি",
  expense: "খরচ",
  loan: "ঋণ",
  "loan-payment": "ঋণ পরিশোধ",
};

function timeAgoBn(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "এইমাত্র";
  if (min < 60) return `${min} মিনিট আগে`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ঘণ্টা আগে`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "গতকাল";
  if (day < 7) return `${day} দিন আগে`;
  return new Date(ms).toISOString().slice(0, 10);
}

// Reads the log and drops anything past AUTO_DELETE_DAYS, saving back
// only when something was actually removed — every other read/write
// function below goes through this so old entries never need a separate
// cleanup job.
async function getList() {
  const list = (await db.get(KEY)) || [];
  const cutoff = Date.now() - AUTO_DELETE_DAYS * 24 * 60 * 60 * 1000;
  const kept = list.filter((item) => item.at >= cutoff);
  if (kept.length !== list.length) await db.set(KEY, kept);
  return kept;
}

// type must be one of the keys in STYLE above; message is the full Bangla
// line shown in the feed (e.g. "রাফিদা আক্তার ভর্তি হয়েছে — ৭ম শ্রেণি").
// link (optional) is the URL the dashboard's "সাম্প্রতিক কার্যক্রম" row
// points to when clicked — e.g. the student's fee page for a fee_payment
// entry. Entries logged before this existed simply have no link, and the
// dashboard renders those as plain (non-clickable) rows.
async function logActivity(type, message, link) {
  const list = await getList();
  list.unshift({ id: shortId(), type, message, link: link || null, at: Date.now(), read: false });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  await db.set(KEY, list);

  // Every activity logged anywhere in the app funnels through here, so
  // this is the single place that needs to know about Telegram — no
  // call site elsewhere has to remember to notify the director.
  const label = TYPE_LABEL[type] || "নোটিফিকেশন";
  telegram.notify(`🔔 <b>${label}</b>\n${message}`);
}

async function getRecentActivities(limit = 8) {
  const list = await getList();
  return list.slice(0, limit).map((item) => ({
    ...item,
    timeAgo: timeAgoBn(item.at),
    style: STYLE[item.type] || { icon: "🔔", bg: "#f1f5f9", color: "#475569" },
  }));
}

// Unread count for the notification bell badge — entries logged before
// read-tracking existed have no `read` field at all, so treat undefined
// the same as false rather than crashing/miscounting old data.
async function getUnreadCount() {
  const list = await getList();
  return list.filter((item) => item.read !== true).length;
}

// Called when the admin opens the notifications list — everything shown
// there is considered acknowledged.
async function markAllRead() {
  const list = await getList();
  for (const item of list) item.read = true;
  await db.set(KEY, list);
}

// Manual removal, one at a time, from the নোটিফিকেশন page — for anything
// someone wants gone before the 30-day auto-delete would have dropped it.
async function deleteActivity(id) {
  const list = await getList();
  const next = list.filter((item) => item.id !== id);
  await db.set(KEY, next);
  return next;
}

// "সব মুছুন" button on the নোটিফিকেশন page.
async function clearAllActivities() {
  await db.set(KEY, []);
}

module.exports = {
  logActivity,
  getRecentActivities,
  getUnreadCount,
  markAllRead,
  deleteActivity,
  clearAllActivities,
};
