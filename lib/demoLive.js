// ডেমো সাইটের অতিরিক্ত ডেটা ও "লাইভ" পরিবর্তন — শুধু DEMO_MODE=true থাকলে server.js থেকে ডাকা হয়।
//  • enrich(): demoSeed শেষ হওয়ার পর ড্যাশবোর্ডের বিশ্লেষণ চার্টগুলো ভরাট রাখতে —
//    ৬ মাসের ফি আদায়, ব্যয়, শিক্ষকের বেতন এবং সব ক্লাসের গত ৭ দিনের উপস্থিতি যোগ করে।
//  • tick(): নির্দিষ্ট সময় পরপর একজন শিক্ষার্থীর নতুন ফি জমা যোগ করে, ফলে সংখ্যা বদলাতে থাকে।
// demoSeed.js নিজে অপরিবর্তিত থাকে।
const db = require("./db");
const fees = require("./fees");
const attendance = require("./attendance");
const expenses = require("./expenses");
const teacherSalary = require("./teacherSalary");
const activity = require("./activity");

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[rnd(0, arr.length - 1)];
const ym = (back) => {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() - back, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const dayStr = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

async function enrich() {
  const year = await attendance.getCurrentSession();
  const classes = (await db.get("classlist")) || [];

  // ৬ মাসের ফি আদায় — demoSeed শুধু শেষ ২ মাস বিল করে, তাই আগের ৪ মাস (২–৫) এখানে যোগ হয়
  for (const c of classes) {
    const structure = await fees.getFeeStructure(c.slug, year);
    const tuition = structure.monthlyTuition || 800;
    for (const st of (await db.get(`students:${c.slug}`)) || []) {
      for (let back = 5; back >= 2; back--) {
        const m = ym(back);
        await fees.addEntry(st.id, { kind: "charge", type: "monthly", label: `মাসিক বেতন (${m})`, amount: tuition, month: m, date: `${m}-01` });
        if (Math.random() < 0.85) {
          await fees.addPayment(st.id, { amount: tuition, method: pick(["নগদ", "বিকাশ"]), note: "", classSlug: c.slug, date: `${m}-${String(rnd(3, 22)).padStart(2, "0")}` });
        }
      }
    }
  }

  // সব ক্লাসের শিফট + গত ৭ দিনের উপস্থিতি (শেষ ক্লাসের আজকের উপস্থিতি ইচ্ছে করে বাকি রাখা হয়)
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    const shift = i % 2 === 0 ? "morning" : "day";
    const existingShifts = await attendance.getSessionShifts(year);
    if (!existingShifts[c.slug]) await attendance.setClassShift(year, c.slug, shift);
    const useShift = existingShifts[c.slug] || shift;
    const roster = (await db.get(`students:${c.slug}`)) || [];
    for (let back = 6; back >= 0; back--) {
      const date = dayStr(back);
      if (attendance.isWeeklyHoliday(date)) continue;
      if (back === 0 && i === classes.length - 1) continue;
      if (await attendance.getStudentAttendance(year, useShift, c.slug, date)) continue;
      const records = {};
      roster.forEach((st) => { const r = Math.random(); records[st.id] = r < 0.87 ? "present" : r < 0.96 ? "absent" : "leave"; });
      await attendance.saveStudentAttendance(year, useShift, c.slug, c.name, date, records, { type: "admin", id: "demo", name: "ডেমো অ্যাডমিন" });
    }
  }

  // অন্যান্য খরচ (৬ মাস)
  for (let back = 5; back >= 0; back--) {
    const m = ym(back);
    await expenses.addExpense({ category: "বিদ্যুৎ বিল", amount: rnd(1800, 3200), note: "মাসিক বিদ্যুৎ বিল", date: `${m}-08` });
    await expenses.addExpense({ category: "মেটেরিয়াল", amount: rnd(1500, 5000), note: "খাতা, মার্কার, চক", date: `${m}-14` });
  }

  // শিক্ষকের বেতন উত্তোলন (৬ মাস)
  const teachers = (await db.get("teachers")) || [];
  for (let t = 0; t < teachers.length; t++) {
    const sal = 3000 + t * 400;
    for (let back = 5; back >= 0; back--) {
      const m = ym(back);
      await teacherSalary.addEntry(teachers[t].id, { kind: "charge", type: "monthly", label: `মাসিক বেতন (${m})`, amount: sal, month: m, date: `${m}-01` });
      if (back > 0 || new Date().getDate() > 10) await teacherSalary.addWithdrawal(teachers[t].id, { amount: sal, date: `${m}-${back === 0 ? "05" : "27"}` });
    }
  }
  console.log("[demo] বিশ্লেষণের অতিরিক্ত ডেটা যোগ হয়েছে");
}

async function tick() {
  const classes = (await db.get("classlist")) || [];
  if (!classes.length) return;
  const c = pick(classes);
  const roster = (await db.get(`students:${c.slug}`)) || [];
  if (!roster.length) return;
  const st = pick(roster);
  const bal = fees.computeBalance(await fees.getLedger(st.id));
  if (!(bal.due > 0)) return;
  const amount = Math.min(bal.due, (await fees.getFeeStructure(c.slug, await attendance.getCurrentSession())).monthlyTuition || 500);
  await fees.addPayment(st.id, { amount, method: pick(["নগদ", "বিকাশ"]), note: "", classSlug: c.slug });
  await activity.logActivity("fee-payment", `${st.name} (${c.name}) ৳${amount} ফি জমা দিয়েছেন`, "/admin/fees");
}

module.exports = { enrich, tick };
