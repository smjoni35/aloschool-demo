const db = require("./db");

// One row per calendar date. Written at most once a day (whenever the
// দ্যাশবোর্ড is opened) — the dashboard's trend arrows compare "today"
// against the snapshot closest to 30 days ago. If there isn't enough
// history yet, getSnapshotNear() returns null and the caller simply
// shows no trend for that card, rather than guessing.
const KEY = "metricSnapshots";
const MAX_SNAPSHOTS = 400; // ~13 months of daily rows, plenty for month-over-month

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function recordTodaySnapshot(metrics) {
  const list = (await db.get(KEY)) || [];
  const today = todayStr();
  if (list.length && list[list.length - 1].date === today) return; // already recorded today
  list.push({ date: today, ...metrics });
  if (list.length > MAX_SNAPSHOTS) list.splice(0, list.length - MAX_SNAPSHOTS);
  await db.set(KEY, list);
}

// Closest snapshot to `daysAgo` days before today, accepted only if
// within 5 days of that target — otherwise it isn't really a meaningful
// "N days ago" comparison, so the caller gets null instead of a
// misleading one.
async function getSnapshotNear(daysAgo) {
  const list = (await db.get(KEY)) || [];
  if (list.length === 0) return null;
  const target = new Date();
  target.setDate(target.getDate() - daysAgo);
  let best = null;
  let bestDiffMs = Infinity;
  for (const snap of list) {
    const diffMs = Math.abs(new Date(snap.date).getTime() - target.getTime());
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs;
      best = snap;
    }
  }
  if (bestDiffMs > 5 * 24 * 60 * 60 * 1000) return null;
  return best;
}

module.exports = { recordTodaySnapshot, getSnapshotNear };
