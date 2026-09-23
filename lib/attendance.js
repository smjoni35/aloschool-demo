// ---------- Attendance module (Student + Teacher) ----------
// Everything here is additive: new db keys only, nothing here reads or
// writes any key used by the existing exam/fees/routine/promotion features.
//
// Core idea: a Class does not have a fixed Shift forever — each Academic
// Session, the admin decides which Shift (Morning/Day) each Class runs in,
// and who the Class Teacher is for that Class+Shift. Every attendance
// record therefore stores its own {session, shift, classSlug, date} so
// that a later session's re-assignment never changes what already
// happened in an earlier one (see server.js comments for the same
// guarantee applied to student.session in admissions/promotion).

const db = require("./db");

// ---------- Weekly holiday (সাপ্তাহিক সরকারি ছুটি) ----------
// Bangladesh runs a Friday–Saturday weekend for govt offices/schools, not
// the Sunday–Saturday week most calendar logic assumes by default.
// JS Date#getDay(): 0=রবি, 1=সোম, 2=মঙ্গল, 3=বুধ, 4=বৃহস্পতি, 5=শুক্র, 6=শনি.
// Centralizing this here so every place that touches attendance — the
// dashboard's "today's attendance pending" nudges, the monthly percentage
// for both students and teachers, and the take/self-check-in screens —
// agrees on what counts as a working day, instead of each one silently
// treating a holiday as a day someone forgot to show up.
const WEEKLY_HOLIDAY_DAYS = [5, 6]; // শুক্রবার, শনিবার

function isWeeklyHoliday(dateStr) {
  if (!dateStr) return false;
  // Parse as a local calendar date (not via `new Date(dateStr)`, which
  // reads "YYYY-MM-DD" as UTC midnight and can land on the wrong weekday
  // depending on the server's timezone).
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return false;
  return WEEKLY_HOLIDAY_DAYS.includes(new Date(y, m - 1, d).getDay());
}

// ---------- Academic Sessions ----------
// A "session" is just a year-ish label (e.g. "2026") — the same free-text
// convention already used by student.session (admissions) and exam.session.
// This module adds a small registry + a "current session" pointer so the
// Attendance screens have something to default to, without inventing a
// heavier concept than the rest of the app already uses.

async function getAcademicSessions() {
  const list = (await db.get("academicSessions")) || [];
  return list.slice().sort();
}

async function ensureSessionExists(session) {
  const s = String(session || "").trim();
  if (!s) return;
  const list = (await db.get("academicSessions")) || [];
  if (!list.includes(s)) {
    list.push(s);
    list.sort();
    await db.set("academicSessions", list);
  }
}

async function getCurrentSession() {
  const current = await db.get("currentAcademicSession");
  if (current) return current;
  // Nothing configured yet — fall back to this calendar year so the
  // feature is usable immediately, matching how admission numbers etc.
  // already default to `new Date().getFullYear()` elsewhere in the app.
  return String(new Date().getFullYear());
}

async function addAcademicSession(session) {
  await ensureSessionExists(session);
}

async function setCurrentSession(session) {
  const s = String(session || "").trim();
  if (!s) return;
  await ensureSessionExists(s);
  await db.set("currentAcademicSession", s);
}

// ---------- Class -> Shift assignment (per session) ----------
// Deliberately separate from server.js's existing `classShifts` key (used
// by the Class Routine feature) — that one has no concept of session and
// is always "whatever shift this class currently runs in for the
// timetable"; changing its meaning would risk the Routine feature. This
// module keeps its own session-scoped copy instead.

function shiftsKey(session) {
  return `attendanceShifts:${session}`;
}

async function getSessionShifts(session) {
  return (await db.get(shiftsKey(session))) || {};
}

async function setClassShift(session, classSlug, shift) {
  if (!classSlug || (shift !== "morning" && shift !== "day")) return;
  const map = await getSessionShifts(session);
  map[classSlug] = shift;
  await db.set(shiftsKey(session), map);
  await ensureSessionExists(session);
}

async function removeClassShift(session, classSlug) {
  const map = await getSessionShifts(session);
  delete map[classSlug];
  await db.set(shiftsKey(session), map);
}

// ---------- Class Teacher assignment (per session) ----------
// One row per (session, shift, classSlug) — at most one Class Teacher per
// Class+Shift. A teacher may appear in at most one "morning" row and at
// most one "day" row within the same session (enforced in server.js
// before calling assignClassTeacher, so the error message can be shown
// alongside the form the admin was just filling in).

function classTeachersKey(session) {
  return `classTeachers:${session}`;
}

async function getClassTeachers(session) {
  return (await db.get(classTeachersKey(session))) || [];
}

async function assignClassTeacher(session, { shift, classSlug, className, teacherAccountId, teacherName }) {
  const list = await getClassTeachers(session);
  const filtered = list.filter((a) => !(a.shift === shift && a.classSlug === classSlug));
  filtered.push({
    id: `${shift}:${classSlug}`,
    shift,
    classSlug,
    className,
    teacherAccountId,
    teacherName,
    assignedAt: Date.now(),
  });
  await db.set(classTeachersKey(session), filtered);
  await ensureSessionExists(session);
}

async function removeClassTeacher(session, shift, classSlug) {
  const list = await getClassTeachers(session);
  const filtered = list.filter((a) => !(a.shift === shift && a.classSlug === classSlug));
  await db.set(classTeachersKey(session), filtered);
}

// A teacher who already owns a *different* class in this same shift for
// this session — used to block a 2nd class in the same shift before it's
// ever saved. `excludeClassSlug` lets re-saving the *same* class+shift
// (e.g. just changing something else) pass through.
function teacherAlreadyHasShift(list, teacherAccountId, shift, excludeClassSlug) {
  return list.find((a) => a.teacherAccountId === teacherAccountId && a.shift === shift && a.classSlug !== excludeClassSlug) || null;
}

function findClassTeacherFor(list, shift, classSlug) {
  return list.find((a) => a.shift === shift && a.classSlug === classSlug) || null;
}

// Every class+shift this teacher is the Class Teacher for, this session —
// 0, 1 (just morning or just day), or 2 (one of each).
async function findTeacherAssignments(session, teacherAccountId) {
  const list = await getClassTeachers(session);
  return list.filter((a) => a.teacherAccountId === teacherAccountId);
}

// ---------- Student roster helpers ----------
// A student admitted in advance for a *future* session hasn't attended a
// single day of the class they'll join — mirrors lib/promotion.js's
// isHeldForFutureSession so such a student never shows up on an
// attendance sheet for a session that hasn't started for them yet.
function isStudentHeldForFutureSession(student, session) {
  const s = parseInt(student && student.session, 10);
  const p = parseInt(session, 10);
  if (Number.isNaN(s) || Number.isNaN(p)) return false;
  return s > p;
}

function activeRosterFor(students, session) {
  return (students || []).filter((s) => !isStudentHeldForFutureSession(s, session));
}

// ---------- Student attendance ----------
function studentAttendanceKey(session, shift, classSlug, date) {
  return `attendance:student:${session}:${shift}:${classSlug}:${date}`;
}
function studentAttendanceIndexKey(session, shift, classSlug) {
  return `attendanceIndex:student:${session}:${shift}:${classSlug}`;
}

async function getStudentAttendance(session, shift, classSlug, date) {
  return await db.get(studentAttendanceKey(session, shift, classSlug, date));
}

async function saveStudentAttendance(session, shift, classSlug, className, date, records, markedBy) {
  const key = studentAttendanceKey(session, shift, classSlug, date);
  const existing = await db.get(key);
  const record = {
    session,
    shift,
    classSlug,
    className,
    date,
    records, // { [studentId]: "present" | "absent" | "leave" }
    markedBy, // { type: "admin" | "teacher", id, name }
    markedAt: existing ? existing.markedAt : Date.now(),
    updatedAt: Date.now(),
  };
  await db.set(key, record);
  if (!existing) {
    const idxKey = studentAttendanceIndexKey(session, shift, classSlug);
    const idx = (await db.get(idxKey)) || [];
    if (!idx.includes(date)) {
      idx.push(date);
      idx.sort();
      await db.set(idxKey, idx);
    }
  }
  return record;
}

async function listStudentAttendanceDates(session, shift, classSlug) {
  return (await db.get(studentAttendanceIndexKey(session, shift, classSlug))) || [];
}

// Small-scale by design (same tradeoff as server.js's teacher-panel stats
// comment): one db.get per marked day. Fine for a school-sized monthly
// range (at most ~26 working days).
async function computeStudentMonthlyReport(session, shift, classSlug, students, yearMonth) {
  const allDates = await listStudentAttendanceDates(session, shift, classSlug);
  // শুক্র/শনিবার সাপ্তাহিক ছুটি — even if a date got marked on one of these
  // (e.g. an old habit before this exclusion existed), it should never
  // count toward a student's total/percentage.
  const dates = allDates.filter((d) => d.startsWith(yearMonth) && !isWeeklyHoliday(d));
  const perStudent = {};
  students.forEach((s) => {
    perStudent[s.id] = { student: s, present: 0, absent: 0, leave: 0, total: 0 };
  });
  for (const date of dates) {
    const rec = await getStudentAttendance(session, shift, classSlug, date);
    if (!rec) continue;
    for (const s of students) {
      const status = rec.records[s.id];
      if (!status) continue;
      if (!perStudent[s.id]) perStudent[s.id] = { student: s, present: 0, absent: 0, leave: 0, total: 0 };
      perStudent[s.id][status] += 1;
      perStudent[s.id].total += 1;
    }
  }
  const rows = Object.values(perStudent).map((r) => ({
    ...r,
    percentage: r.total > 0 ? Math.round((r.present / r.total) * 1000) / 10 : null,
  }));
  return { dates, rows };
}

// ---------- Teacher (self) attendance ----------
function teacherAttendanceKey(session, date) {
  return `attendance:teacher:${session}:${date}`;
}
function teacherAttendanceIndexKey(session) {
  return `attendanceIndex:teacher:${session}`;
}

async function getTeacherAttendanceForDate(session, date) {
  return (await db.get(teacherAttendanceKey(session, date))) || {};
}

async function ensureTeacherIndexDate(session, date) {
  const idxKey = teacherAttendanceIndexKey(session);
  const idx = (await db.get(idxKey)) || [];
  if (!idx.includes(date)) {
    idx.push(date);
    idx.sort();
    await db.set(idxKey, idx);
  }
}

// Self check-in — only ever sets status "present" with a real check-in
// time. Returns { already:true, entry } if this teacher already checked
// in today (so the route can show "already checked in" instead of
// overwriting the original time).
async function teacherCheckIn(session, date, teacherAccountId, teacherName) {
  const map = await getTeacherAttendanceForDate(session, date);
  if (map[teacherAccountId] && map[teacherAccountId].status === "present" && map[teacherAccountId].checkInAt) {
    return { already: true, entry: map[teacherAccountId] };
  }
  map[teacherAccountId] = { status: "present", checkInAt: Date.now(), checkOutAt: null, markedBy: "self", teacherName };
  await db.set(teacherAttendanceKey(session, date), map);
  await ensureTeacherIndexDate(session, date);
  return { already: false, entry: map[teacherAccountId] };
}

// Self check-out — only valid once a check-in exists for today. Returns
// { error: "not-checked-in" } if there's nothing to check out of yet,
// or { already:true, entry } if this teacher already checked out today
// (so the route never overwrites the original checkout time).
async function teacherCheckOut(session, date, teacherAccountId, teacherName) {
  const map = await getTeacherAttendanceForDate(session, date);
  const entry = map[teacherAccountId];
  if (!entry || entry.status !== "present" || !entry.checkInAt) {
    return { error: "not-checked-in" };
  }
  if (entry.checkOutAt) {
    return { already: true, entry };
  }
  map[teacherAccountId] = { ...entry, checkOutAt: Date.now(), teacherName: teacherName || entry.teacherName };
  await db.set(teacherAttendanceKey(session, date), map);
  await ensureTeacherIndexDate(session, date);
  return { already: false, entry: map[teacherAccountId] };
}

// Admin override/manual entry — e.g. marking a teacher "leave" or
// "absent", or correcting a missed check-in/check-out.
async function setTeacherAttendanceStatus(session, date, teacherAccountId, teacherName, status) {
  if (status !== "present" && status !== "absent" && status !== "leave") return;
  const map = await getTeacherAttendanceForDate(session, date);
  const prevCheckIn = map[teacherAccountId] && map[teacherAccountId].checkInAt;
  const prevCheckOut = map[teacherAccountId] && map[teacherAccountId].checkOutAt;
  map[teacherAccountId] = {
    status,
    checkInAt: status === "present" ? prevCheckIn || null : null,
    checkOutAt: status === "present" ? prevCheckOut || null : null,
    markedBy: "admin",
    teacherName,
  };
  await db.set(teacherAttendanceKey(session, date), map);
  await ensureTeacherIndexDate(session, date);
}

async function listTeacherAttendanceDates(session) {
  return (await db.get(teacherAttendanceIndexKey(session))) || [];
}

async function computeTeacherMonthlyReport(session, teacherAccounts, yearMonth) {
  const allDates = await listTeacherAttendanceDates(session);
  // Same শুক্র/শনিবার exclusion as the student report — same function,
  // same formula, so it needs the same fix on both sides.
  const dates = allDates.filter((d) => d.startsWith(yearMonth) && !isWeeklyHoliday(d));
  const perTeacher = {};
  teacherAccounts.forEach((t) => {
    perTeacher[t.id] = { teacher: t, present: 0, absent: 0, leave: 0, total: 0 };
  });
  for (const date of dates) {
    const map = await getTeacherAttendanceForDate(session, date);
    for (const t of teacherAccounts) {
      const entry = map[t.id];
      if (!entry) continue;
      if (!perTeacher[t.id]) perTeacher[t.id] = { teacher: t, present: 0, absent: 0, leave: 0, total: 0 };
      perTeacher[t.id][entry.status] += 1;
      perTeacher[t.id].total += 1;
    }
  }
  const rows = Object.values(perTeacher).map((r) => ({
    ...r,
    percentage: r.total > 0 ? Math.round((r.present / r.total) * 1000) / 10 : null,
  }));
  return { dates, rows };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function currentYearMonth() {
  return new Date().toISOString().slice(0, 7);
}

module.exports = {
  isWeeklyHoliday,
  getAcademicSessions,
  addAcademicSession,
  ensureSessionExists,
  getCurrentSession,
  setCurrentSession,
  getSessionShifts,
  setClassShift,
  removeClassShift,
  getClassTeachers,
  assignClassTeacher,
  removeClassTeacher,
  teacherAlreadyHasShift,
  findClassTeacherFor,
  findTeacherAssignments,
  isStudentHeldForFutureSession,
  activeRosterFor,
  getStudentAttendance,
  saveStudentAttendance,
  listStudentAttendanceDates,
  computeStudentMonthlyReport,
  getTeacherAttendanceForDate,
  teacherCheckIn,
  teacherCheckOut,
  setTeacherAttendanceStatus,
  listTeacherAttendanceDates,
  computeTeacherMonthlyReport,
  todayStr,
  currentYearMonth,
};
