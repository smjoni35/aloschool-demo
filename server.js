const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const multer = require("multer");

const db = require("./lib/db");
const auth = require("./lib/auth");
const { streamProgressCard, streamAllProgressCards, streamAdmissionForm, streamRoutinePDF, streamFeeReceipt, streamTransferCertificate, streamCharacterCertificate, getGrade, fontsAvailable, periodOrdinal } = require("./lib/pdf");
const { computeResultsRows } = require("./lib/results");
const { qrDataUrlFor } = require("./lib/qr");
const { buildWorkbookBuffer, parseWorkbookBuffer, pickField } = require("./lib/sheet");
const { buildPromotionPlan, applyPromotionPlan } = require("./lib/promotion");
const fees = require("./lib/fees");
const teacherSalary = require("./lib/teacherSalary");
const attendance = require("./lib/attendance");
const activity = require("./lib/activity");
const bnDate = require("./lib/bnDate");
const snapshot = require("./lib/snapshot");
const expenses = require("./lib/expenses");
const loans = require("./lib/loans");
const r2 = require("./lib/r2");
const demoSeed = require("./lib/demoSeed");
const demoLive = require("./lib/demoLive");

// ---------- Demo mode ----------
// When DEMO_MODE=true (set in the environment), the whole database is
// wiped and refilled with realistic sample data on startup, then again on
// a timer, so a client browsing the demo always sees every feature already
// populated instead of an empty app. See lib/demoSeed.js.
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DEMO_RESET_HOURS = parseFloat(process.env.DEMO_RESET_HOURS || "6");

const app = express();

// ---------- Vercel-এ ডেমো ডেটা (serverless-এ setInterval চলে না) ----------
// Vercel-এ সার্ভার সারাক্ষণ চালু থাকে না, তাই টাইমারের বদলে রিকোয়েস্ট আসার সময়
// দেখা হয়: ডেটা না থাকলে বা DEMO_RESET_HOURS পার হলে সিড হয়, আর প্রতি
// DEMO_TICK_MINUTES মিনিটে একটা নতুন ফি জমা পড়ে। Upstash ছাড়া এটা ঠিকমতো চলবে না।
if (DEMO_MODE && process.env.VERCEL) {
  const RESET_MS = (parseFloat(process.env.DEMO_RESET_HOURS || "24") || 24) * 3600 * 1000;
  const TICK_MS = (parseFloat(process.env.DEMO_TICK_MINUTES || "2") || 2) * 60 * 1000;
  let seeding = null;
  let okUntil = 0;
  let lastTick = 0;
  const ensureDemo = async () => {
    const at = await db.get("demoSeededAt");
    if (!at || Date.now() - at > RESET_MS) {
      console.log("[demo] Vercel: ডেমো ডেটা সিড হচ্ছে...");
      await demoSeed.resetAndSeed();
      await demoLive.enrich();
    }
    okUntil = Date.now() + 60 * 1000;
  };
  app.use(async (req, res, next) => {
    try {
      if (Date.now() >= okUntil) {
        if (!seeding) {
          seeding = ensureDemo()
            .catch((e) => console.error("[demo] সিডিং ব্যর্থ:", e))
            .finally(() => { seeding = null; });
        }
        await seeding;
      }
      if (Date.now() - lastTick > TICK_MS) {
        lastTick = Date.now();
        await demoLive.tick().catch((e) => console.error("[demo] টিক ব্যর্থ:", e.message));
      }
    } catch (e) {
      console.error("[demo]", e);
    }
    next();
  });
}

// ---------- Security headers (helmet) ----------
// helmet is loaded defensively: if the package isn't installed yet the app
// still starts (with a warning) instead of crashing. CSP is turned off on
// purpose — the pages use inline <style>/<script>/onclick, which a default
// Content-Security-Policy would block. All the other helmet protections
// (clickjacking, MIME sniffing, HSTS, referrer policy, ...) stay on.
app.disable("x-powered-by");
try {
  const helmet = require("helmet");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    })
  );
} catch (e) {
  console.warn("[security] helmet ইনস্টল করা নেই — `npm install` চালান। এখন হেডার সুরক্ষা ছাড়াই চলছে।");
}

// ---------- Async route safety ----------
// Express 4 does not catch errors thrown inside `async` route handlers, so a
// single failed database call would leave that request hanging forever.
// This wraps every route handler so any error is passed to the error
// handler at the bottom of this file, which replies with a proper message.
function wrapHandler(fn) {
  if (Array.isArray(fn)) return fn.map(wrapHandler);
  if (typeof fn !== "function" || fn.length === 4) return fn;
  return function (req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}
["get", "post", "put", "patch", "delete"].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = function (...args) {
    // app.get("setting-name") with a single argument reads an app setting.
    if (method === "get" && args.length === 1) return original(...args);
    return original(...args.map(wrapHandler));
  };
});
// Render (and most hosts) put the app behind a reverse proxy, so without
// this, req.ip would be the proxy's own address for every visitor — which
// would make the login rate-limiting below block/unblock everyone
// together instead of per real visitor.
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory upload handling for bulk import files (students, marks) — files
// are parsed immediately and never written to disk. 10MB is far more than a
// spreadsheet of a few hundred students/marks should ever need.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Photos (student/teacher/applicant) go through this — a much tighter size
// limit is fine since it's a single portrait photo, not a spreadsheet.
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------- Photo upload → R2 (falls back to base64 if R2 isn't configured) ----------
// One handler shared by student/teacher/admission photo pickers: resizes +
// uploads to R2 and returns { url }. If R2 env vars aren't set, returns
// { url: null } so the browser falls back to embedding the photo as base64
// like before (see the client-side script in each view).
async function handlePhotoUpload(req, res, defaultFolder) {
  try {
    if (!req.file) return res.status(400).json({ error: "কোনো ছবি পাওয়া যায়নি" });
    if (!r2.configured) return res.json({ url: null });
    // Only a small fixed set of sub-folders are allowed — the ?folder query
    // value is never passed through to R2 unchecked.
    const allowedFolders = new Set(["students", "teachers", "gallery"]);
    const folder = allowedFolders.has(req.query.folder) ? req.query.folder : defaultFolder;
    const url = await r2.uploadPhoto(req.file.buffer, folder);
    if (!url) return res.status(500).json({ error: "ছবি আপলোড ব্যর্থ হয়েছে" });
    res.json({ url });
  } catch (err) {
    console.error("photo upload error:", err);
    res.status(500).json({ error: "ছবি আপলোড ব্যর্থ হয়েছে" });
  }
}

// Public — the online admission form has no login (see PUBLIC_PATH_PREFIXES in lib/auth.js).
app.post("/admission/upload-photo", uploadPhoto.single("photo"), (req, res) => handlePhotoUpload(req, res, "admissions"));

// ---------- Auth (simple single-admin-password protection) ----------
app.use(auth.requireAuth);

// Staff-only — student profile photo and public-website teacher photo.
app.post("/api/upload-photo", uploadPhoto.single("photo"), (req, res) => handlePhotoUpload(req, res, "students"));

// Make school settings (name, logo) and public website contact info
// available to every view automatically, so templates can show branding
// and the floating call/WhatsApp widget without every single res.render()
// call needing to fetch and pass them.
app.use(async (req, res, next) => {
  // Full-word Bengali period ordinals (প্রথম, দ্বিতীয়, ...) for the class
  // routine views, so "1ম" never has to be spelled out per-template.
  res.locals.periodOrdinal = periodOrdinal;
  // Lets the sidebar highlight the current page without every route
  // needing to pass it — just req.path, no extra DB read.
  res.locals.currentPath = req.path;
  // _public-footer's copyright line needs this on every public page,
  // not just the ones whose route builds the full home-page data set.
  res.locals.currentYear = new Date().getFullYear();
  res.locals.demoMode = DEMO_MODE;
  if (DEMO_MODE) {
    res.locals.demoAdminPassword = process.env.ADMIN_PASSWORD || "admin123";
    res.locals.demoTeacherPassword = process.env.DEMO_TEACHER_PASSWORD || "teacher123";
  }
  try {
    res.locals.settings = await getSettings();
  } catch (e) {
    res.locals.settings = {};
  }
  try {
    const website = await getWebsite();
    res.locals.website = website;
    res.locals.whatsappNumber = toWhatsAppDigits(website.contactPhone);
  } catch (e) {
    res.locals.website = {};
    res.locals.whatsappNumber = "";
  }
  next();
});

// ---------- PWA: manifest + icons ----------
// Publicly accessible (added to PUBLIC_PATHS in lib/auth.js) since a
// browser may request these before the visitor has logged in at all.
app.get("/manifest.webmanifest", async (req, res) => {
  const settings = await getSettings();
  const name = settings.schoolName || "স্কুল ম্যানেজমেন্ট সিস্টেম";
  res.set("Content-Type", "application/manifest+json");
  res.json({
    name,
    short_name: name.length > 14 ? name.slice(0, 14) : name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2563eb",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  });
});

// Serves the school's own logo (uploaded at /admin/website settings) as the
// app icon when one has been set; otherwise falls back to a generic default
// icon bundled with the app. The logo is stored as a data URL, so we decode
// it straight out of settings rather than needing a separate image file.
function serveIcon(fallbackFile) {
  return async (req, res) => {
    const settings = await getSettings();
    const dataUrl = settings.logoDataUrl;
    const match = dataUrl && /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl);
    if (match) {
      res.set("Content-Type", match[1]);
      res.set("Cache-Control", "no-cache");
      return res.send(Buffer.from(match[2], "base64"));
    }
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(__dirname, "public", "icons", fallbackFile));
  };
}
app.get("/icon-192.png", serveIcon("default-192.png"));
app.get("/icon-512.png", serveIcon("default-512.png"));

app.get("/login", async (req, res) => {
  if (await auth.isAdmin(req)) return res.redirect("/panel");
  if (await auth.currentTeacher(req)) return res.redirect("/teacher/panel");
  const settings = await getSettings();
  res.render("login", { error: null, settings });
});

app.post("/login", async (req, res) => {
  const settings = await getSettings();
  const limit = auth.checkRateLimit(req, "admin");
  if (limit.blocked) {
    return res.render("login", {
      error: `অনেকবার ভুল পাসওয়ার্ড দেওয়া হয়েছে — অনুগ্রহ করে ${auth.minutesRemaining(limit.remainingMs)} মিনিট পর আবার চেষ্টা করুন।`,
      settings,
    });
  }
  const token = await auth.login(req.body.password || "");
  if (!token) {
    auth.recordFailedAttempt(req, "admin");
    return res.render("login", { error: "পাসওয়ার্ড ভুল হয়েছে।", settings });
  }
  auth.clearRateLimit(req, "admin");
  auth.setSessionCookie(res, token);
  res.redirect("/panel");
});

app.get("/logout", async (req, res) => {
  const cookies = auth.parseCookies(req);
  await auth.logout(cookies[auth.SESSION_COOKIE]);
  auth.clearSessionCookie(res);
  res.redirect("/login");
});

// ---------- Teacher accounts (managed by admin) ----------
async function getTeacherAccounts() {
  return (await db.get("teacheraccounts")) || [];
}

// Login accounts are only ever created for someone on the public
// "শিক্ষকবৃন্দ" list (managed at /admin/website) — every account stores
// which entry it belongs to (sourceTeacherId). This checks that link is
// still valid right now, so removing someone from that list immediately
// cuts off their Teacher Panel access too, without needing to separately
// delete their login account.
async function isTeacherStillListed(account) {
  if (!account || !account.sourceTeacherId) return false;
  const websiteTeachers = (await db.get("teachers")) || [];
  return websiteTeachers.some((t) => t.id === account.sourceTeacherId);
}

// ---------- Teacher Panel (separate login, restricted access) ----------
app.get("/teacher/login", async (req, res) => {
  if (await auth.currentTeacher(req)) return res.redirect("/teacher/panel");
  const accounts = await getTeacherAccounts();
  const settings = await getSettings();
  res.render("teacher-login", { error: null, accounts, settings });
});

app.post("/teacher/login", async (req, res) => {
  const accountId = (req.body.accountId || "").trim();
  const password = req.body.password || "";
  const accounts = await getTeacherAccounts();
  const settings = await getSettings();

  const limit = auth.checkRateLimit(req, "teacher");
  if (limit.blocked) {
    return res.render("teacher-login", {
      error: `অনেকবার ভুল তথ্য দেওয়া হয়েছে — অনুগ্রহ করে ${auth.minutesRemaining(limit.remainingMs)} মিনিট পর আবার চেষ্টা করুন।`,
      accounts,
      settings,
    });
  }

  const account = accounts.find((a) => a.id === accountId);
  if (!account || !auth.verifyPassword(password, account.salt, account.hash)) {
    auth.recordFailedAttempt(req, "teacher");
    return res.render("teacher-login", { error: "নাম বা পাসওয়ার্ড ভুল হয়েছে।", accounts, settings });
  }
  if (!(await isTeacherStillListed(account))) {
    return res.render("teacher-login", {
      error: "আপনি এখন আর স্কুলের অনুমোদিত শিক্ষক তালিকায় নেই — এডমিনের সাথে যোগাযোগ করুন।",
      accounts,
      settings,
    });
  }
  auth.clearRateLimit(req, "teacher");
  const token = await auth.createTeacherSession(account);
  auth.setSessionCookie(res, token);
  res.redirect("/teacher/panel");
});

app.get("/teacher/logout", async (req, res) => {
  const cookies = auth.parseCookies(req);
  await auth.logout(cookies[auth.SESSION_COOKIE]);
  auth.clearSessionCookie(res);
  res.redirect("/teacher/login");
});

// Every /teacher/* route below (except login/logout above) requires an
// active teacher session AND that the teacher is still on the public
// শিক্ষকবৃন্দ list right now — req.teacher is then always available.
async function requireTeacher(req, res, next) {
  const teacher = await auth.currentTeacher(req);
  if (!teacher) return res.redirect("/teacher/login");

  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === teacher.id);
  if (!account || !(await isTeacherStillListed(account))) {
    const cookies = auth.parseCookies(req);
    await auth.logout(cookies[auth.SESSION_COOKIE]);
    auth.clearSessionCookie(res);
    const settings = await getSettings();
    return res.render("teacher-login", {
      error: "আপনি এখন আর স্কুলের অনুমোদিত শিক্ষক তালিকায় নেই — এডমিনের সাথে যোগাযোগ করুন।",
      accounts,
      settings,
    });
  }

  req.teacher = teacher;
  next();
}

app.get("/teacher/panel", requireTeacher, async (req, res) => {
  // Enrich the bare {id, name} session with the fuller profile from the
  // public শিক্ষকবৃন্দ list (designation, photo) plus a couple of quick
  // stats, so the panel doesn't look empty right after login.
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.teacher.id);
  const websiteTeachers = (await db.get("teachers")) || [];
  const sourceTeacher = account ? websiteTeachers.find((t) => t.id === account.sourceTeacherId) : null;
  const settings = await getSettings();

  // Small-scale by design: reads every exam once per panel load to count
  // this teacher's contributions. Fine for a school's exam volume; revisit
  // if the exam list ever grows large enough for this to feel slow.
  const examlist = (await db.get("examlist")) || [];
  let examsCreated = 0;
  let subjectsEntered = 0;
  for (const e of examlist) {
    const exam = await db.get(`exam:${e.key}`);
    if (!exam) continue;
    if (exam.createdByTeacherId === req.teacher.id) examsCreated++;
    subjectsEntered += (exam.subjects || []).filter((s) => s.teacherId === req.teacher.id).length;
  }

  res.render("teacher-dashboard", {
    teacher: req.teacher,
    designation: (sourceTeacher && sourceTeacher.designation) || "",
    photoDataUrl: (sourceTeacher && sourceTeacher.photoDataUrl) || "",
    examsCreated,
    subjectsEntered,
    settings,
  });
});

// Teacher's own extended profile (phone, address, education, NID, etc.) —
// only the teacher themself can view/edit this via their own panel. Admin
// can see it (read-only) at /admin/teacher-accounts/:id/profile but cannot
// change it here; corrections must come from the teacher's own login.
app.get("/teacher/profile", requireTeacher, async (req, res) => {
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.teacher.id);
  const settings = await getSettings();
  res.render("teacher-profile", {
    teacher: req.teacher,
    profile: (account && account.profile) || {},
    saved: req.query.saved === "1",
    settings,
  });
});

app.post("/teacher/profile", requireTeacher, async (req, res) => {
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.teacher.id);
  if (account) {
    const field = (name) => (req.body[name] || "").trim();
    account.profile = {
      fullName: field("fullName"),
      phone: field("phone"),
      email: field("email"),
      address: field("address"),
      dob: field("dob"),
      bloodGroup: field("bloodGroup"),
      education: field("education"),
      joiningDate: field("joiningDate"),
      nid: field("nid"),
      birthCertNo: field("birthCertNo"),
      emergencyName: field("emergencyName"),
      emergencyPhone: field("emergencyPhone"),
    };
    await db.set("teacheraccounts", accounts);
  }
  res.redirect("/teacher/profile?saved=1");
});

// Teacher's own salary — read-only view of the same ledger the admin sees
// at /admin/salary/:teacherId (lib/teacherSalary.js). The login account
// (req.teacher.id) is linked to the website "teachers" list entry via
// account.sourceTeacherId — that's the id the salary ledger is actually
// keyed by. Combines regular monthly salary, coaching salary, one-off
// charges (bonuses), and withdrawals (regular or advance) into one
// balance and history, same as the admin page — no edit/delete actions
// here since this is teacher-facing.
app.get("/teacher/salary", requireTeacher, async (req, res) => {
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.teacher.id);
  const websiteTeachers = (await db.get("teachers")) || [];
  const sourceTeacher = account ? websiteTeachers.find((t) => t.id === account.sourceTeacherId) : null;

  if (!sourceTeacher) {
    return res.render("teacher-salary-self", {
      teacher: { name: req.teacher.name, designation: "", monthlySalary: 0, coachingMonthlySalary: 0 },
      balance: { charged: 0, paid: 0, due: 0 },
      ledger: [],
    });
  }

  const chronological = (await teacherSalary.getLedger(sourceTeacher.id))
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.createdAt - b.createdAt);
  const balance = teacherSalary.computeBalance(chronological);
  res.render("teacher-salary-self", {
    teacher: sourceTeacher,
    balance,
    ledger: chronological.slice().reverse(),
  });
});

// Exam list — same "grouped by name+session" view the admin panel uses,
// but pointed at the /teacher/* routes and without destructive actions.
app.get("/teacher/exams", requireTeacher, async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const examlist = (await db.get("examlist")) || [];
  const settings = await getSettings();

  const groups = [];
  const groupIndex = new Map();
  examlist.forEach((e) => {
    const gKey = `${e.examName}||${e.session || ""}`;
    if (!groupIndex.has(gKey)) {
      groupIndex.set(gKey, groups.length);
      groups.push({ examName: e.examName, session: e.session, entries: [] });
    }
    groups[groupIndex.get(gKey)].entries.push(e);
  });
  // Within each exam group, list classes in grade order (not creation
  // order) — same rule as everywhere else classes are listed.
  groups.forEach((g) => g.entries.sort((a, b) => classRank(a.className) - classRank(b.className)));

  res.render("teacher-exams", { classes, examGroups: groups.reverse(), settings, teacher: req.teacher });
});

app.post("/teacher/exams/create", requireTeacher, async (req, res) => {
  const { examName, session } = req.body;
  let classSlugs = req.body.classSlug || [];
  if (!Array.isArray(classSlugs)) classSlugs = [classSlugs];
  classSlugs = classSlugs.filter(Boolean);
  if (classSlugs.length === 0 || !(examName || "").trim()) return res.redirect("/teacher/exams");

  const classes = (await db.get("classlist")) || [];
  const settings = await getSettings();
  const examlist = (await db.get("examlist")) || [];

  let firstKey = null;
  for (const classSlug of classSlugs) {
    const cls = classes.find((c) => c.slug === classSlug);
    if (!cls) continue;
    const key = `${slugify(cls.name)}-${slugify(examName)}-${slugify(session)}-${shortId()}`;
    const exam = {
      key,
      classSlug,
      className: cls.name,
      examName,
      session,
      schoolName: settings.schoolName || "",
      subjects: [],
      marksByStudent: {},
      createdAt: Date.now(),
      createdByTeacherId: req.teacher.id,
      createdByTeacherName: req.teacher.name,
    };
    await db.set(`exam:${key}`, exam);
    examlist.push({ key, className: cls.name, examName, session });
    if (!firstKey) firstKey = key;
  }
  await db.set("examlist", examlist);

  if (classSlugs.length === 1 && firstKey) return res.redirect(`/teacher/exams/${firstKey}`);
  res.redirect("/teacher/exams");
});

app.get("/teacher/exams/:key", requireTeacher, async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  res.render("teacher-exam-detail", { exam, studentCount: students.length, teacher: req.teacher });
});

// Any teacher may add a new subject — it starts unclaimed (no owner) until
// someone actually enters marks for it (see the marks POST route below),
// at which point that teacher becomes its permanent owner.
app.post("/teacher/exams/:key/subjects/add", requireTeacher, async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const name = (req.body.subjectName || "").trim();
  const fullMarks = clampFullMarks(req.body.fullMarks);
  if (name && !exam.subjects.find((s) => s.name === name)) {
    exam.subjects.push({ name, fullMarks, teacherId: null, teacherName: null });
    await db.set(`exam:${req.params.key}`, exam);
  }
  res.redirect(`/teacher/exams/${req.params.key}`);
});

app.get("/teacher/exams/:key/marks/:subjectIndex", requireTeacher, async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const canEdit = !subject.teacherId || subject.teacherId === req.teacher.id;
  res.render("teacher-marks-entry", {
    exam,
    subject,
    subjectIndex: idx,
    students,
    canEdit,
    teacher: req.teacher,
    importResult: null,
  });
});

// ---- Permission rule (per the Teacher Panel workflow) ----
// A subject's marks can only ever be edited by the teacher who first
// entered them. Everyone else with teacher access can still view the
// exam and results, just not change this subject's numbers.
app.post("/teacher/exams/:key/marks/:subjectIndex", requireTeacher, async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");

  if (subject.teacherId && subject.teacherId !== req.teacher.id) {
    return res
      .status(403)
      .send(
        `দুঃখিত, এই বিষয়ের (${subject.name}) নম্বর শুধুমাত্র ${subject.teacherName || "যিনি প্রথমে এন্ট্রি করেছেন"} এডিট করতে পারবেন। আপনি শুধু দেখতে পারবেন।`
      );
  }
  // First save on this subject — claims permanent edit ownership for this teacher.
  if (!subject.teacherId) {
    subject.teacherId = req.teacher.id;
    subject.teacherName = req.teacher.name;
  }

  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const marksInput = req.body.marks || {};
  const invalidEntries = [];
  for (const studentId of Object.keys(marksInput)) {
    const result = parseMarkInput(marksInput[studentId], subject.fullMarks);
    if (result.error) {
      const student = students.find((s) => s.id === studentId);
      invalidEntries.push({ roll: (student && student.roll) || "?", reason: result.error });
      continue; // leave this student's previously saved mark untouched
    }
    if (!exam.marksByStudent[studentId]) exam.marksByStudent[studentId] = {};
    if (result.clear) {
      delete exam.marksByStudent[studentId][subject.name];
    } else {
      exam.marksByStudent[studentId][subject.name] = result.value;
    }
  }
  await db.set(`exam:${req.params.key}`, exam);

  if (invalidEntries.length > 0) {
    return res.render("teacher-marks-entry", {
      exam,
      subject,
      subjectIndex: idx,
      students,
      canEdit: true,
      teacher: req.teacher,
      importResult: null,
      manualError: invalidEntries,
    });
  }
  res.redirect(`/teacher/exams/${req.params.key}`);
});

// ---------- Bulk marks import (Teacher Panel) — same ownership rule as the
// manual entry form above: a teacher may only import into a subject that's
// unclaimed or already theirs. ----------
app.get("/teacher/exams/:key/marks/:subjectIndex/template", requireTeacher, async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const headers = ["রোল", "নাম", marksColumnHeader(subject)];
  const rows = buildMarksTemplateRows(exam, subject, students);
  const buffer = buildWorkbookBuffer(headers, rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDispositionHeader(`নম্বর-টেমপ্লেট-${subject.name}`, "xlsx"));
  res.send(buffer);
});

app.post("/teacher/exams/:key/marks/:subjectIndex/import", requireTeacher, upload.single("file"), async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const canEdit = !subject.teacherId || subject.teacherId === req.teacher.id;

  const renderWith = (importResult) =>
    res.render("teacher-marks-entry", { exam, subject, subjectIndex: idx, students, canEdit, teacher: req.teacher, importResult });

  if (!canEdit) {
    return res.status(403).send(
      `দুঃখিত, এই বিষয়ের (${subject.name}) নম্বর শুধুমাত্র ${subject.teacherName || "যিনি প্রথমে এন্ট্রি করেছেন"} এডিট করতে পারবেন। আপনি শুধু দেখতে পারবেন।`
    );
  }
  if (!req.file) {
    return renderWith({ updated: 0, skipped: [], error: "কোনো ফাইল পাওয়া যায়নি।" });
  }

  let rows;
  try {
    rows = parseWorkbookBuffer(req.file.buffer);
  } catch (err) {
    console.error("Marks import parse error:", err);
    return renderWith({ updated: 0, skipped: [], error: "ফাইলটি পড়া যায়নি। .xlsx বা .csv ফাইল দিন।" });
  }

  if (!subject.teacherId) {
    subject.teacherId = req.teacher.id;
    subject.teacherName = req.teacher.name;
  }
  const { updated, skipped } = applyMarksImport(exam, subject, students, rows);
  await db.set(`exam:${req.params.key}`, exam);

  renderWith({ updated, skipped, error: null });
});

// ---------- Admin: manage teacher login accounts ----------
// Login accounts can only be created for someone already on the public
// "শিক্ষকবৃন্দ" list (managed at /admin/website) — the admin picks from a
// dropdown of that list, never types a free-text name, so a login account
// can never exist for someone who isn't one of the school's listed
// teachers. Removing someone from that list (see isTeacherStillListed
// above) cuts off their access immediately, without a separate step here.
app.get("/admin/teacher-accounts", async (req, res) => {
  const accounts = await getTeacherAccounts();
  const websiteTeachers = (await db.get("teachers")) || [];
  const listedIds = new Set(websiteTeachers.map((t) => t.id));
  const usedIds = new Set(accounts.map((a) => a.sourceTeacherId).filter(Boolean));
  const availableTeachers = websiteTeachers.filter((t) => !usedIds.has(t.id));
  res.render("admin-teacher-accounts", {
    accounts,
    listedIds,
    availableTeachers,
    hasNoWebsiteTeachers: websiteTeachers.length === 0,
    error: null,
  });
});

app.post("/admin/teacher-accounts/add", async (req, res) => {
  const accounts = await getTeacherAccounts();
  const websiteTeachers = (await db.get("teachers")) || [];
  const usedIds = new Set(accounts.map((a) => a.sourceTeacherId).filter(Boolean));
  const availableTeachers = websiteTeachers.filter((t) => !usedIds.has(t.id));

  const sourceTeacherId = (req.body.sourceTeacherId || "").trim();
  const password = req.body.password || "";
  const sourceTeacher = websiteTeachers.find((t) => t.id === sourceTeacherId);

  const renderWith = (error) =>
    res.render("admin-teacher-accounts", {
      accounts,
      listedIds: new Set(websiteTeachers.map((t) => t.id)),
      availableTeachers,
      hasNoWebsiteTeachers: websiteTeachers.length === 0,
      error,
    });

  if (!sourceTeacher) {
    return renderWith("ওয়েবসাইটের শিক্ষক তালিকা থেকে একজন শিক্ষক বেছে নিন — তালিকার বাইরে কারও জন্য অ্যাকাউন্ট তৈরি করা যাবে না।");
  }
  if (!password) {
    return renderWith("পাসওয়ার্ড দিন।");
  }
  if (accounts.some((a) => a.sourceTeacherId === sourceTeacherId)) {
    return renderWith("এই শিক্ষকের জন্য আগে থেকেই একটা লগইন অ্যাকাউন্ট আছে।");
  }

  const { salt, hash } = auth.hashPassword(password);
  accounts.push({
    id: shortId(),
    name: sourceTeacher.name, // taken from the website list, not typed by hand
    sourceTeacherId,
    salt,
    hash,
    createdAt: Date.now(),
  });
  await db.set("teacheraccounts", accounts);
  res.redirect("/admin/teacher-accounts");
});

app.post("/admin/teacher-accounts/:id/reset-password", async (req, res) => {
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.params.id);
  const password = req.body.password || "";
  if (account && password) {
    const { salt, hash } = auth.hashPassword(password);
    account.salt = salt;
    account.hash = hash;
    await db.set("teacheraccounts", accounts);
  }
  res.redirect("/admin/teacher-accounts");
});

app.post("/admin/teacher-accounts/:id/delete", async (req, res) => {
  const accounts = (await getTeacherAccounts()).filter((a) => a.id !== req.params.id);
  await db.set("teacheraccounts", accounts);
  res.redirect("/admin/teacher-accounts");
});

// Read-only view for admin — shows the extended personal info a teacher has
// entered themselves from their own panel. Admin can see this but cannot
// edit it here; only the teacher (logged into /teacher/profile) can correct
// their own details.
app.get("/admin/teacher-accounts/:id/profile", async (req, res) => {
  const accounts = await getTeacherAccounts();
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.redirect("/admin/teacher-accounts");
  const websiteTeachers = (await db.get("teachers")) || [];
  const sourceTeacher = websiteTeachers.find((t) => t.id === account.sourceTeacherId) || null;
  res.render("admin-teacher-profile", {
    account,
    sourceTeacher,
    profile: account.profile || {},
  });
});

// Auto-generates a registration/admission number built from three parts:
// <session><classCode><serial>, e.g. "20260001" — session 2026, classCode
// "00" (প্রাক-প্রাথমিক), serial "01" (1st currently-admitted student in that
// class for that session). The serial is derived from the students who
// currently exist in that class for that year (not a counter that only
// goes up) — so if every student in a class is deleted, the next one
// admitted starts again at 01 instead of continuing where the deleted ones
// left off.
function serialFromRegistration(registration, prefix) {
  if (!registration || !registration.startsWith(prefix)) return 0;
  const n = parseInt(registration.slice(prefix.length), 10);
  return Number.isFinite(n) ? n : 0;
}

async function generateRegistrationNumber(classSlug, classCode) {
  const year = new Date().getFullYear();
  const prefix = `${year}${classCode}`;
  const students = (await db.get(`students:${classSlug}`)) || [];
  let maxSerial = 0;
  for (const s of students) {
    const n = serialFromRegistration(s.registration, prefix);
    if (n > maxSerial) maxSerial = n;
  }
  return `${prefix}${String(maxSerial + 1).padStart(2, "0")}`;
}

// Every class gets a permanent 2-digit code the first time it's needed for
// a registration number — normally set right away when the class is
// created (in the order classes are added: প্রাক-প্রাথমিক=00, ১ম=01, ২য়=02...),
// but this backfills it for classes that existed before this scheme (or
// were somehow saved without one) so numbering never breaks.
async function ensureClassCode(classes, cls) {
  if (cls.code) return cls.code;
  const idx = classes.findIndex((c) => c.slug === cls.slug);
  const code = String(idx >= 0 ? idx : classes.length).padStart(2, "0");
  cls.code = code;
  await db.set("classlist", classes);
  return code;
}

// Canonical school-grade order for *display* only (প্রাক-প্রাথমিক → প্রথম →
// দ্বিতীয় → ... → দ্বাদশ). This is independent of the order classes were
// created in and independent of their fixed registration `code` (see
// ensureClassCode) — it never touches the stored classlist, it only sorts a
// copy right before rendering, so classCode / registration numbers are
// unaffected. A class name is matched by keyword (not exact string) so
// "১ম শ্রেণি", "প্রথম", "প্রথম শ্রেণি" etc. all match the same grade.
const CLASS_RANK_GROUPS = [
  ["প্লে"],
  ["নার্সারি"],
  ["শিশু"],
  ["প্রাক-প্রাথমিক", "প্রাক প্রাথমিক", "প্রাকপ্রাথমিক"],
  ["প্রথম", "১ম"],
  ["দ্বিতীয়", "২য়"],
  ["তৃতীয়", "৩য়"],
  ["চতুর্থ", "৪র্থ"],
  ["পঞ্চম", "৫ম"],
  ["ষষ্ঠ", "৬ষ্ঠ"],
  ["সপ্তম", "৭ম"],
  ["অষ্টম", "৮ম"],
  ["নবম", "৯ম"],
  ["দশম", "১০ম"],
  ["একাদশ"],
  ["দ্বাদশ"],
];

function classRank(name) {
  // Bengali conjunct letters like "য়" can be typed/stored as either a
  // single precomposed codepoint or as a base letter + nukta sequence —
  // both look identical on screen but are different bytes, so a plain
  // .includes() can silently fail to match (this broke "দ্বিতীয়" and
  // "তৃতীয়" specifically, since both contain "য়"). Normalizing to NFC
  // collapses both forms to the same representation before comparing.
  const n = String(name || "").normalize("NFC");
  for (let i = 0; i < CLASS_RANK_GROUPS.length; i++) {
    if (CLASS_RANK_GROUPS[i].some((kw) => n.includes(kw.normalize("NFC")))) return i;
  }
  return CLASS_RANK_GROUPS.length; // unrecognized names sort last
}

// Returns a NEW array sorted into grade order for display. Classes whose
// name doesn't match any known grade keyword keep their original relative
// order and are placed after all recognized ones.
function sortClassesForDisplay(classes) {
  return classes
    .map((c, i) => ({ c, i, rank: classRank(c.name) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// A short, human-typable number shown to the applicant right after they
// submit (and printed on their form) so staff can pull up that exact
// application later by searching for this number on /admissions, instead
// of scrolling through every pending application. Counted separately per
// calendar year (key includes the year) so the number naturally restarts
// at 0001 every new year, instead of climbing forever and drifting out of
// sync with the year shown in the prefix. Note: this counter does NOT
// know a submission was "just a test" — every submission (including test
// ones) permanently uses up the next number for that year. Use
// /admin/admissions/reset-counter (⚙️ সেটিংস পেজ) to zero it out for the
// current year before going live, if test applications were made first.
async function generateAdmissionNo() {
  const year = new Date().getFullYear();
  const counterKey = `admissions:counter:${year}`;
  const counter = ((await db.get(counterKey)) || 0) + 1;
  await db.set(counterKey, counter);
  return `${year}-${String(counter).padStart(4, "0")}`;
}

// Same per-year counter pattern as generateAdmissionNo, reused for TC and
// character-certificate serials (kind = "tc" | "character") — each kind
// gets its own independent sequence so issuing a TC doesn't burn a number
// out of the character-certificate range or vice versa.
async function generateDocumentNo(kind) {
  const year = new Date().getFullYear();
  const counterKey = `doc-counter:${kind}:${year}`;
  const counter = ((await db.get(counterKey)) || 0) + 1;
  await db.set(counterKey, counter);
  return `${kind === "tc" ? "TC" : "CC"}-${year}-${String(counter).padStart(4, "0")}`;
}

// ---------- Global settings (school name etc.) ----------
// Set once from the Admin page and reused everywhere an exam/progress-card
// needs a school name, so it never has to be retyped (and therefore never
// mistyped) each time a new exam is created.
async function getSettings() {
  return (await db.get("settings")) || { schoolName: "" };
}

// ---------- Public school website content (about, admission, contact) ----------
async function getWebsite() {
  return (
    (await db.get("website")) || {
      tagline: "",
      about: "",
      admission: "",
      contactAddress: "",
      contactPhone: "",
      contactEmail: "",
      mapEmbedUrl: "",
      foundedYear: "",
      facebookUrl: "",
      youtubeUrl: "",
      admissionBannerEnabled: false,
      admissionBannerText: "",
    }
  );
}

// The director's / headmaster's name, designation and photo come straight from
// the website "teachers" list: whoever's designation (পদবি) says "পরিচালক" or
// "প্রধান শিক্ষক" is picked up automatically. Deputy-type posts (সহকারী, উপ-,
// সহ-, যুগ্ম, অতিরিক্ত) are skipped so "সহকারী প্রধান শিক্ষক" never counts as
// the head. If two people match, the first one in the list wins.
const MESSAGE_ROLE_WORDS = {
  director: ["পরিচালক"],
  head: ["প্রধান শিক্ষক", "প্রধান শিক্ষিকা"],
};
const NOT_THE_TOP_POST = ["সহকারী", "সহ-", "সহ ", "সহঃ", "উপ-", "উপ ", "যুগ্ম", "অতিরিক্ত"];
function findRoleTeacher(teachers, role) {
  const words = MESSAGE_ROLE_WORDS[role] || [];
  return (
    (teachers || []).find((t) => {
      const d = String(t.designation || "").normalize("NFC").replace(/\s+/g, " ").trim();
      if (!d) return false;
      if (NOT_THE_TOP_POST.some((w) => d.includes(w))) return false;
      return words.some((w) => d.includes(w));
    }) || null
  );
}

// Cards for the public home page, director first. A card only appears when its
// message (বাণী) has been written. Name/designation/photo: from the matching
// teacher-list entry if there is one, otherwise whatever was typed by hand.
function buildMessageCards(website, teachers) {
  const defs = [
    { key: "director", id: "director-message", title: "পরিচালকের বাণী", fallbackAlt: "পরিচালক" },
    { key: "head", id: "head-message", title: "প্রধান শিক্ষকের বাণী", fallbackAlt: "প্রধান শিক্ষক" },
  ];
  return defs
    .map((d) => {
      const person = findRoleTeacher(teachers, d.key);
      return {
        id: d.id,
        title: d.title,
        fallbackAlt: d.fallbackAlt,
        msg: website[`${d.key}Message`] || "",
        name: (person && person.name) || website[`${d.key}Name`] || "",
        desig: (person && person.designation) || website[`${d.key}Designation`] || "",
        photo: (person && person.photoDataUrl) || website[`${d.key}PhotoDataUrl`] || "",
      };
    })
    .filter((c) => c.msg);
}

// Public ফি-এর তথ্য table for the home page, taken straight from the per-class
// fee structure of the current session (Admin → ফি), so it never needs typing
// twice. Only classes with at least one amount set are listed, and a column is
// dropped entirely when nobody has a value for it. Never throws — a failure
// here must not take the whole home page down.
async function buildPublicFeeInfo() {
  try {
    const classes = sortClassesForDisplay((await db.get("classlist")) || []);
    const session = await attendance.getCurrentSession();
    const structures = await Promise.all(classes.map((c) => fees.getFeeStructure(c.slug, session)));
    const taka = (n) => (n ? "৳ " + bnDate.toBnDigits(n.toLocaleString("en-US")) : "—");
    const rows = classes
      .map((c, i) => {
        const st = structures[i] || {};
        const admission = (st.admissionItems || []).reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
        const sessionFee = Number(st.sessionFee) || 0;
        const monthly = Number(st.monthlyTuition) || 0;
        return { name: c.name, admission, sessionFee, monthly };
      })
      .filter((r) => r.admission || r.sessionFee || r.monthly);
    if (!rows.length) return null;
    return {
      sessionText: bnDate.toBnDigits(session),
      showAdmission: rows.some((r) => r.admission),
      showSession: rows.some((r) => r.sessionFee),
      showMonthly: rows.some((r) => r.monthly),
      rows: rows.map((r) => ({
        name: r.name,
        admission: taka(r.admission),
        sessionFee: taka(r.sessionFee),
        monthly: taka(r.monthly),
      })),
    };
  } catch (e) {
    console.error("public fee info error:", e);
    return null;
  }
}

// A notice counts as "new" for the 🆕 badge on the public website for 7
// days after it was added (by createdAt, not the admin-entered "date"
// field, which may be blank or refer to a future/past event date).
const NOTICE_NEW_MS = 7 * 24 * 60 * 60 * 1000;
function markRecentNotices(notices) {
  const now = Date.now();
  return notices.map((n) => ({ ...n, isNew: !!n.createdAt && now - n.createdAt < NOTICE_NEW_MS }));
}

// Converts a Bangladeshi mobile number (e.g. "01xxxxxxxxx" or "+8801xxxxxxxxx")
// into the digits-only, country-code-prefixed form wa.me needs. Same contact
// number the admin already enters — no separate WhatsApp number to manage.
function toWhatsAppDigits(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("880")) return digits;
  if (digits.startsWith("0")) return "880" + digits.slice(1);
  return digits;
}

// Grand total of students across every class — used for the "মোট শিক্ষার্থী"
// stat on the public website. Summed across all classes rather than shown
// per-class, since the homepage stat is meant to be a single headline number.
async function getTotalStudentCount() {
  const classes = (await db.get("classlist")) || [];
  const rosters = await Promise.all(
    classes.map((cls) => db.get(`students:${cls.slug}`))
  );
  return rosters.reduce((total, roster) => total + (roster || []).length, 0);
}

// Count of admission applications waiting for staff review — shown as a
// badge on the dashboard so new applications don't get missed.
async function getPendingAdmissionCount() {
  return ((await db.get("admissions:pending")) || []).length;
}

// The lookup "code" a student's QR should carry — same roll/registration
// number findStudentByCode() already accepts, preferring roll since that's
// the primary field most guardians know.
function codeForStudent(student) {
  return String((student && (student.roll || student.registration)) || "").trim();
}

// Absolute URL to a student's Public Result Page, built from the request
// so it works whatever host/domain the app is actually deployed under.
function publicResultUrl(req, examKey, code) {
  return `${req.protocol}://${req.get("host")}/result?exam=${encodeURIComponent(examKey)}&code=${encodeURIComponent(code)}`;
}

// Absolute URL to a receipt's Public Verification Page — printed as a QR
// on the receipt PDF so anyone (guardian, auditor) can confirm a physical
// or forwarded receipt is genuine without contacting the office.
function publicReceiptVerifyUrl(req, receiptNo) {
  return `${req.protocol}://${req.get("host")}/verify/receipt/${encodeURIComponent(receiptNo)}`;
}

// Generates the verification QR for one student, or null if there's no
// code to look them up by or QR generation fails — callers just skip
// drawing the QR in that case rather than breaking PDF generation.
async function qrForStudent(req, examKey, student) {
  const code = codeForStudent(student);
  if (!code) return null;
  try {
    return await qrDataUrlFor(publicResultUrl(req, examKey, code));
  } catch (e) {
    console.error("QR generation error:", e);
    return null;
  }
}

// Content-Disposition headers must be ASCII/Latin1 — a raw Bengali filename
// throws "Invalid character in header content" (or produces a malformed
// response the browser rejects). Give an ASCII-safe fallback name plus the
// real UTF-8 name via the filename* extension (RFC 5987/6266).
function contentDispositionHeader(rawName, ext, disposition = "attachment") {
  const asciiSafe = String(rawName || "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  const fallback = (asciiSafe || "progress-card") + "." + ext;
  const utf8Name = encodeURIComponent(String(rawName || "progress-card").replace(/\s+/g, "_")) + "." + ext;
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${utf8Name}`;
}

// ---------- Bulk import helpers (students & marks, shared by admin/teacher routes) ----------

// Bengali digits (০-৯) normalized to English (0-9) — same helper used by the
// public result lookup (findStudentByCode) below, duplicated in spirit here
// so a roll typed/pasted in either script still matches.
const BN_TO_EN_DIGITS_IMPORT = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
function normalizeDigitsForImport(s) {
  return String(s || "").replace(/[০-৯]/g, (d) => BN_TO_EN_DIGITS_IMPORT[d]);
}

// Header row + one example row for the "add many students at once" template.
// Only নাম is required — every other column can be left blank per row.
const STUDENT_IMPORT_HEADERS = [
  "নাম",
  "রোল",
  "রেজিস্ট্রেশন নম্বর (ঐচ্ছিক)",
  "শিফট (মর্নিং/ডে)",
  "ভর্তির সেশন (ঐচ্ছিক)",
  "পিতার নাম",
  "মাতার নাম",
  "জন্ম তারিখ (YYYY-MM-DD)",
  "লিঙ্গ",
  "রক্তের গ্রুপ",
  "পিতার মোবাইল",
  "মাতার মোবাইল",
  "বর্তমান ঠিকানা",
  "পূর্ববর্তী স্কুল (ঐচ্ছিক)",
  "গাড়ি সুবিধা (হ্যাঁ/না)",
  "কোচিং (হ্যাঁ/না)",
  "ছাড়ের ধরণ (শতাংশ/টাকা)",
  "ছাড়ের মান",
  "ছাড়ের কারণ",
  "ছাড় শেষ সেশন",
];
const STUDENT_IMPORT_EXAMPLE_ROW = [
  "রহিম উদ্দিন",
  "১",
  "",
  "মর্নিং",
  "2026",
  "করিম উদ্দিন",
  "রহিমা বেগম",
  "2015-01-10",
  "ছেলে",
  "B+",
  "01700000000",
  "01800000000",
  "গ্রাম, ডাকঘর, উপজেলা, জেলা",
  "",
  "না",
  "না",
  "",
  "",
  "",
  "",
];

// "হ্যাঁ/yes/1/true" (any case, Bengali or English) → true, everything else
// (including blank) → false. Used for the গাড়ি সুবিধা import column.
function parseYesNo(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return ["হ্যাঁ", "হ্যা", "yes", "y", "1", "true"].includes(v);
}

// Normalizes the ছাড়ের ধরণ (discount type) column to the internal
// "percent" / "amount" values used everywhere else in the app. Anything
// unrecognized (including blank) means "no discount".
function parseDiscountType(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (["শতাংশ", "শতাংশ (%)", "%", "percent"].includes(v)) return "percent";
  if (["টাকা", "নির্দিষ্ট টাকা", "amount", "taka"].includes(v)) return "amount";
  return "";
}

// Normalizes a জন্ম তারিখ cell to the "YYYY-MM-DD" format that <input
// type="date"> requires. parseWorkbookBuffer's dateNF option already
// converts true Excel date cells, but if a date was typed as plain text
// (e.g. "10/01/2015" or "10-01-2015") it arrives here unchanged, so this
// catches the common slash/dash formats too. Day-first is assumed (the
// convention used on the template and in Bangladesh generally); if the
// first number is >12 it's unambiguous, otherwise day-first still wins.
// Anything already in YYYY-MM-DD, or unrecognized, passes through as-is.
function normalizeDobForImport(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    let [, a, b, year] = m;
    let day = parseInt(a, 10);
    let month = parseInt(b, 10);
    if (day > 12 && month <= 12) {
      // already day-first, nothing to swap
    } else if (month > 12 && day <= 12) {
      // was actually month-first (e.g. "01/10/2015" = Oct 1) — swap
      [day, month] = [month, day];
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return v;
}

// Turns one parsed template row into a student record (registration/id are
// assigned by the caller). Returns null when the row has no name — the one
// required field — so the caller can count/skip it.
function studentFromImportRow(row) {
  const name = String(pickField(row, ["নাম", "name"]) || "").trim();
  if (!name) return null;
  const get = (candidates) => String(pickField(row, candidates) || "").trim();
  const student = {
    name,
    roll: get(["রোল", "roll"]),
    section: get(["শিফট (মর্নিং/ডে)", "শিফট", "সেকশন", "section", "shift"]),
  };
  // Registration number is optional in the import sheet — if the admin
  // filled it in, use it as-is; otherwise it's left blank so it can be
  // typed in manually later on the student's profile page (no more
  // auto-numbering during bulk import).
  const registration = get(["রেজিস্ট্রেশন নম্বর (ঐচ্ছিক)", "রেজিস্ট্রেশন নম্বর", "registration", "reg no", "regno"]);
  if (registration) student.registration = registration;
  const session = get(["ভর্তির সেশন (ঐচ্ছিক)", "ভর্তির সেশন", "session"]);
  const fatherName = get(["পিতার নাম", "fathername", "father name", "father"]);
  const motherName = get(["মাতার নাম", "mothername", "mother name", "mother"]);
  const dob = normalizeDobForImport(get(["জন্ম তারিখ (YYYY-MM-DD)", "জন্ম তারিখ", "dob", "date of birth"]));
  const gender = get(["লিঙ্গ", "gender"]);
  const bloodGroup = get(["রক্তের গ্রুপ", "bloodgroup", "blood group"]);
  const fatherPhone = get(["পিতার মোবাইল", "fatherphone", "father phone", "father mobile"]);
  const motherPhone = get(["মাতার মোবাইল", "motherphone", "mother phone", "mother mobile"]);
  const presentAddress = get(["বর্তমান ঠিকানা", "address", "presentaddress", "present address"]);
  const previousSchool = get(["পূর্ববর্তী স্কুল (ঐচ্ছিক)", "পূর্ববর্তী স্কুল", "previous school"]);
  const transportEnabled = parseYesNo(get(["গাড়ি সুবিধা (হ্যাঁ/না)", "গাড়ি সুবিধা", "transport"]));
  const coachingEnabled = parseYesNo(get(["কোচিং (হ্যাঁ/না)", "কোচিং", "coaching"]));
  const discountType = parseDiscountType(get(["ছাড়ের ধরণ (শতাংশ/টাকা)", "ছাড়ের ধরণ", "discount type"]));
  const discountValueRaw = get(["ছাড়ের মান", "discount value"]);
  const discountNote = get(["ছাড়ের কারণ", "discount note", "discount reason"]);
  const discountUntilSession = get(["ছাড় শেষ সেশন", "discount until session"]);
  if (session) student.session = session;
  if (fatherName) student.fatherName = fatherName;
  if (motherName) student.motherName = motherName;
  if (dob) student.dob = dob;
  if (gender) student.gender = gender;
  if (bloodGroup) student.bloodGroup = bloodGroup;
  if (fatherPhone) student.fatherPhone = fatherPhone;
  if (motherPhone) student.motherPhone = motherPhone;
  if (presentAddress) student.presentAddress = presentAddress;
  if (previousSchool) student.previousSchool = previousSchool;
  if (transportEnabled) student.transportEnabled = true;
  if (coachingEnabled) student.coachingEnabled = true;
  if (discountType) {
    student.discountType = discountType;
    student.discountValue = Number(discountValueRaw) || 0;
    if (discountNote) student.discountNote = discountNote;
    if (discountUntilSession) student.discountUntilSession = discountUntilSession;
  }
  return student;
}

// Header row builder + row matcher for the per-subject marks template. The
// marks column header names the full marks so a teacher re-uploading an
// export of a *different* subject's template gets an obvious mismatch
// instead of silently importing under the wrong scale.
function marksColumnHeader(subject) {
  return `নম্বর (পূর্ণমান ${subject.fullMarks})`;
}

// A subject's পূর্ণমান is admin/teacher-chosen per subject (25, 33, 50, 70,
// 100 — anything) but must always itself sit within 0–100, since Bangladeshi
// report cards score every subject out of at most 100. Invalid/blank/out-of-
// range input falls back to 100 rather than silently accepting something
// like 150.
function clampFullMarks(raw) {
  const val = parseFloat(raw);
  if (!Number.isFinite(val) || val <= 0) return 100;
  if (val > 100) return 100;
  return val;
}

// ---- Shared mark validation (manual entry + bulk import, teacher + admin) ----
// A subject's fullMarks is per-subject and admin-defined (25, 33, 50, 100 —
// anything from 0 to 100), so this always checks against that subject's own
// fullMarks rather than a fixed 0-100 range. Used everywhere a mark is
// written so nothing bypasses the browser's client-side max="" check by
// posting directly to the server.
function parseMarkInput(raw, fullMarks) {
  const str = String(raw ?? "").trim();
  if (str === "") return { clear: true, value: null, error: null };
  const val = parseFloat(str);
  if (isNaN(val)) return { clear: false, value: null, error: "নম্বরটি সংখ্যা নয়" };
  if (val < 0) return { clear: false, value: null, error: "নম্বর ঋণাত্মক হতে পারবে না" };
  // Clamp the ceiling at 100 too — belt-and-braces in case a subject's
  // stored fullMarks ever exceeds 100 (e.g. data saved before this check
  // existed), a mark can still never legitimately be over 100.
  const full = Math.min(parseFloat(fullMarks) || 100, 100);
  if (val > full) return { clear: false, value: null, error: `নম্বর পূর্ণমান (${full}) এর বেশি হতে পারবে না` };
  return { clear: false, value: val, error: null };
}

function buildMarksTemplateRows(exam, subject, students) {
  return students.map((s) => {
    const existing = (exam.marksByStudent[s.id] && exam.marksByStudent[s.id][subject.name]) ?? "";
    return [s.roll || "", s.name, existing];
  });
}

// Applies a parsed marks-template upload to one exam subject. Matches each
// row to a student by roll number (Bengali/English digits both accepted).
// A blank marks cell clears that student's mark for this subject, same as
// leaving the field empty in the manual entry form. Rows whose roll doesn't
// match anyone, or whose marks cell isn't a number, are skipped and listed
// so the uploader can see exactly what didn't go in.
function applyMarksImport(exam, subject, students, rows) {
  const byRoll = new Map();
  students.forEach((s) => {
    const key = normalizeDigitsForImport(String(s.roll || "").trim().toLowerCase());
    if (key) byRoll.set(key, s);
  });

  let updated = 0;
  const skipped = [];
  const markHeader = marksColumnHeader(subject);

  for (const row of rows) {
    const rollRaw = String(pickField(row, ["রোল", "roll"]) || "").trim();
    const roll = normalizeDigitsForImport(rollRaw.toLowerCase());
    const student = roll ? byRoll.get(roll) : null;
    if (!student) {
      skipped.push({ roll: rollRaw || "(খালি)", reason: "এই রোলের কোনো শিক্ষার্থী পাওয়া যায়নি" });
      continue;
    }

    const markRaw = pickField(row, [markHeader, "নম্বর", "marks", "mark"]);
    const result = parseMarkInput(markRaw, subject.fullMarks);
    if (!exam.marksByStudent[student.id]) exam.marksByStudent[student.id] = {};

    if (result.error) {
      skipped.push({ roll: rollRaw, reason: result.error });
      continue;
    }
    if (result.clear) {
      delete exam.marksByStudent[student.id][subject.name];
      updated++;
      continue;
    }
    exam.marksByStudent[student.id][subject.name] = result.value;
    updated++;
  }

  return { updated, skipped };
}

// ---------- Public school website (no login required) ----------
// Shared data for every public page (home, about, teachers, gallery) so
// they always agree on notices, staff, fees etc. Each route below picks
// what its own template actually needs from this.
async function loadPublicSiteData() {
  const settings = await getSettings();
  const website = await getWebsite();
  const allNotices = markRecentNotices(
    ((await db.get("notices")) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  );
  const notices = allNotices.slice(0, 5);
  const [teachersRaw, galleryRaw, featuresRaw, totalStudents] = await Promise.all([
    db.get("teachers"),
    db.get("gallery"),
    db.get("features"),
    getTotalStudentCount(),
  ]);
  const teachers = teachersRaw || [];
  const gallery = galleryRaw || [];
  const features = featuresRaw || [];
  const feeInfo = website.showFees ? await buildPublicFeeInfo() : null;
  return {
    settings,
    website,
    notices,
    allNotices,
    hasMoreNotices: allNotices.length > notices.length,
    messageCards: buildMessageCards(website, teachers),
    feeInfo,
    features,
    teachers,
    gallery,
    totalStudents,
    whatsappNumber: toWhatsAppDigits(website.contactPhone),
    currentYear: new Date().getFullYear(),
  };
}

app.get("/", async (req, res) => {
  const data = await loadPublicSiteData();
  res.render("public-home", data);
});

// আমাদের সম্পর্কে: full পরিচালক/প্রধান শিক্ষকের বাণী, ভিশন ও মিশন, স্কুল পরিচিতি.
app.get("/about", async (req, res) => {
  const data = await loadPublicSiteData();
  res.render("public-about", data);
});

// শিক্ষকবৃন্দ: home page only teases the first few; this is the full list.
app.get("/teachers", async (req, res) => {
  const data = await loadPublicSiteData();
  res.render("public-teachers", data);
});

// গ্যালারি: home page only teases the first few; this is the full set.
app.get("/gallery", async (req, res) => {
  const data = await loadPublicSiteData();
  res.render("public-gallery", data);
});

app.get("/notices", async (req, res) => {
  const settings = await getSettings();
  const notices = markRecentNotices(
    ((await db.get("notices")) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  );
  res.render("public-notices", { settings, notices });
});

// ---------- Admin panel (requires login) ----------
app.get("/panel", async (req, res) => {
  const settings = await getSettings();
  const pendingAdmissions = await getPendingAdmissionCount();
  const classes = (await db.get("classlist")) || [];
  const examlist = (await db.get("examlist")) || [];
  const websiteTeachers = (await db.get("teachers")) || [];
  const totalStudents = await getTotalStudentCount();

  // examlist has one row per class per exam run — count distinct
  // name+session pairs so e.g. "বার্ষিক পরীক্ষা ২০২৬" across 5 classes
  // counts as one exam, not five.
  const examGroupKeys = new Set(examlist.map((e) => `${e.examName}||${e.session || ""}`));

  // School-wide fee summary — total charged/paid/due across every
  // student's ledger, plus this month's collection, for the ফি সারাংশ
  // card on the dashboard.
  const yearMonth = attendance.currentYearMonth();
  const attSession = await attendance.getCurrentSession();
  // Self-healing monthly billing: generate this month's charges the
  // first time anyone opens the dashboard after the month turns over,
  // instead of relying on an admin remembering to click a button.
  await fees.ensureMonthlyChargesAutoRun(attSession, yearMonth);
  const feeSummary = await fees.schoolFeeSummary(classes.map((c) => c.slug), yearMonth);
  const collectionTrend = await fees.monthlyCollectionTrend(classes.map((c) => c.slug), 6);
  const totalDue = feeSummary.totalDue;
  const studentsWithDue = feeSummary.studentsWithDue;
  const incomePercent = feeSummary.totalCharged > 0
    ? Math.round((feeSummary.totalPaid / feeSummary.totalCharged) * 100)
    : 0;
  const duePercent = feeSummary.totalCharged > 0 ? 100 - incomePercent : 0;

  // এই মাসের ব্যয় — শিক্ষকদের এই মাসে দেওয়া বেতন (আসল উত্তোলন, শুধু ধার্য
  // অঙ্ক নয়) + বিদ্যুৎ বিল/চিকিৎসা/মেটেরিয়াল ইত্যাদি আলাদাভাবে যোগ করা খরচ।
  const salaryPaidThisMonth = await teacherSalary.schoolSalaryPaidThisMonth(yearMonth);
  const otherExpenseThisMonth = await expenses.monthlyTotal(yearMonth);
  // এই মাসে ঋণ বাবদ আসলে যে টাকা পরিশোধ করা হয়েছে (নতুন ঋণ নেওয়ার অঙ্ক নয়) —
  // এটাও এই মাসের ক্যাশ আউটফ্লো, তাই মোট ব্যয়ে যোগ হয়।
  const loanRepaymentThisMonth = await loans.monthlyRepaymentTotal(yearMonth);
  const totalExpenseThisMonth = salaryPaidThisMonth + otherExpenseThisMonth + loanRepaymentThisMonth;
  // মোট বকেয়া ঋণ — এটা একটা দায় (ব্যালেন্স-শিট আইটেম), তাই এই মাসের
  // নেট আয়-ব্যয়ের হিসাবে ধরা হয় না, শুধু আলাদাভাবে দেখানো হয়।
  const totalOutstandingLoan = await loans.totalOutstanding();

  // Expected recurring monthly fee — মাসিক বেতন per class × active
  // students in that class this session. An estimate of what a full
  // month's billing looks like, not what has actually been charged yet.
  let monthlyFeeTotal = 0;
  const classFeeData = await Promise.all(
    classes.map(async (c) => ({
      structure: await fees.getFeeStructure(c.slug, attSession),
      roster: (await db.get(`students:${c.slug}`)) || [],
    }))
  );
  for (const { structure, roster } of classFeeData) {
    const active = attendance.activeRosterFor(roster, attSession);
    for (const s of active) {
      const tuition = structure.monthlyTuition || 0;
      monthlyFeeTotal += tuition - fees.computeStandingDiscountAmount(s, attSession, tuition);
    }
  }
  const feeSummaryCard = {
    thisMonthPaid: feeSummary.thisMonthPaid,
    totalDue,
    monthlyFeeTotal,
    incomePercent,
    duePercent,
    salaryPaidThisMonth,
    otherExpenseThisMonth,
    loanRepaymentThisMonth,
    totalExpenseThisMonth,
    netThisMonth: feeSummary.thisMonthPaid - totalExpenseThisMonth,
    totalOutstandingLoan,
  };

  // Today's student attendance, summed across every class that has
  // already been marked today. Classes with no shift set, or not yet
  // marked today, simply contribute nothing — the card reflects
  // "marked so far today", not a full-roster expectation.
  const shiftMap = await attendance.getSessionShifts(attSession);
  const today = attendance.todayStr();
  // শুক্র/শনিবার সাপ্তাহিক ছুটি — on these days no class or teacher is
  // expected to show up at all, so an unmarked class/teacher below isn't
  // "pending" and must never nudge the admin into marking it (which is
  // exactly how holidays were ending up counted as absent).
  const isTodayWeeklyHoliday = attendance.isWeeklyHoliday(today);
  let present = 0, absent = 0, leave = 0;
  let classesPendingAttendance = 0;
  for (const c of classes) {
    const shift = shiftMap[c.slug];
    if (!shift) continue;
    const rec = await attendance.getStudentAttendance(attSession, shift, c.slug, today);
    if (!rec) {
      if (!isTodayWeeklyHoliday) classesPendingAttendance++;
      continue;
    }
    for (const status of Object.values(rec.records)) {
      if (status === "present") present++;
      else if (status === "absent") absent++;
      else if (status === "leave") leave++;
    }
  }
  const attendanceMarkedTotal = present + absent + leave;

  // Donut chart segments — three stacked stroke-dasharray arcs (present /
  // absent / leave) on a single SVG circle. Precomputed here rather than
  // in the template so the view just loops and draws.
  const DONUT_RADIUS = 54;
  const DONUT_CIRC = 2 * Math.PI * DONUT_RADIUS;
  const donutParts = [
    { value: present, color: "#16a34a" },
    { value: absent, color: "#dc2626" },
    { value: leave, color: "#d97706" },
  ];
  let donutOffset = 0;
  const donutSegments = [];
  if (attendanceMarkedTotal > 0) {
    for (const part of donutParts) {
      if (part.value <= 0) continue;
      const len = (part.value / attendanceMarkedTotal) * DONUT_CIRC;
      donutSegments.push({
        color: part.color,
        dasharray: `${len} ${DONUT_CIRC - len}`,
        dashoffset: -donutOffset,
      });
      donutOffset += len;
    }
  }

  const attendanceToday = {
    present,
    absent,
    leave,
    total: attendanceMarkedTotal,
    percentage: attendanceMarkedTotal > 0 ? Math.round((present / attendanceMarkedTotal) * 1000) / 10 : null,
    radius: DONUT_RADIUS,
    donut: donutSegments,
  };

  const recentActivities = await activity.getRecentActivities(5);

  // Teachers who haven't self-checked-in yet today — same idea as
  // classesPendingAttendance above, for the শিক্ষক side.
  const teacherAccounts = await getTeacherAccounts();
  const teacherAttendanceToday = await attendance.getTeacherAttendanceForDate(attSession, today);
  const teachersNotCheckedIn = isTodayWeeklyHoliday
    ? 0
    : teacherAccounts.filter((t) => !teacherAttendanceToday[t.id]).length;

  // গুরুত্বপূর্ণ / অপেক্ষমাণ কাজ — every item here is a real, currently-true
  // count (not a fabricated "trend"), so the list only ever shows what's
  // actually outstanding right now. Nothing appears when a count is 0.
  const urgentTasks = [];
  if (pendingAdmissions > 0) {
    urgentTasks.push({
      icon: "📝", bg: "#dbeafe", color: "#2563eb",
      text: `${pendingAdmissions}টি নতুন ভর্তির আবেদন অপেক্ষমাণ`, count: pendingAdmissions, href: "/admissions",
    });
  }
  if (studentsWithDue > 0) {
    urgentTasks.push({
      icon: "💳", bg: "#fee2e2", color: "#dc2626",
      text: `${studentsWithDue} জন শিক্ষার্থীর ফি বকেয়া`, count: studentsWithDue, href: "/admin/fees/dues",
    });
  }
  if (classesPendingAttendance > 0) {
    urgentTasks.push({
      icon: "🧑", bg: "#fef3c7", color: "#d97706",
      text: `${classesPendingAttendance}টি ক্লাসের আজকের উপস্থিতি নেওয়া হয়নি`, count: classesPendingAttendance, href: "/admin/attendance/student",
    });
  }
  if (teachersNotCheckedIn > 0) {
    urgentTasks.push({
      icon: "🏫", bg: "#ede9fe", color: "#7c3aed",
      text: `${teachersNotCheckedIn} জন শিক্ষকের আজকের উপস্থিতি বাকি`, count: teachersNotCheckedIn, href: "/admin/attendance/teacher",
    });
  }

  const unreadCount = await activity.getUnreadCount();
  const todayBn = { date: bnDate.formatBnDate(), weekday: bnDate.bnWeekday() };

  // Real month-over-month trends for the stat cards — compares today's
  // numbers against the snapshot closest to 30 days ago. Recording
  // happens once per day (no-op if already recorded today); the compare
  // only shows a trend when a genuine ~30-day-old snapshot exists, so a
  // freshly-installed school simply sees no arrows for its first month
  // instead of a fabricated one.
  await snapshot.recordTodaySnapshot({
    totalStudents,
    totalTeachers: websiteTeachers.length,
    totalExams: examGroupKeys.size,
    totalDue,
  });
  const prevSnap = await snapshot.getSnapshotNear(30);
  function trendCount(current, previous) {
    if (previous === undefined || previous === null || current === previous) return null;
    return { dir: current > previous ? "up" : "down", diff: Math.abs(current - previous) };
  }
  function trendPercent(current, previous) {
    if (!previous || current === previous) return null;
    return { dir: current > previous ? "up" : "down", percent: Math.round((Math.abs(current - previous) / previous) * 100) };
  }
  const trends = prevSnap
    ? {
        totalStudents: trendCount(totalStudents, prevSnap.totalStudents),
        totalTeachers: trendCount(websiteTeachers.length, prevSnap.totalTeachers),
        totalExams: trendCount(examGroupKeys.size, prevSnap.totalExams),
        totalDue: trendPercent(totalDue, prevSnap.totalDue),
      }
    : null;

  // ---------- Analytics (dashboard বিশ্লেষণ section) ----------
  // Real data only. Wrapped in try/catch so a problem here can never
  // take the whole dashboard down — the section just hides itself.
  let analytics = null;
  try {
    const incomeExpense = [];
    for (const m of collectionTrend) {
      const exp =
        (await teacherSalary.schoolSalaryPaidThisMonth(m.yearMonth)) +
        (await expenses.monthlyTotal(m.yearMonth)) +
        (await loans.monthlyRepaymentTotal(m.yearMonth));
      incomeExpense.push({ label: m.label, income: m.amount, expense: exp });
    }

    const classStats = [];
    for (const c of sortClassesForDisplay(classes)) {
      const roster = (await db.get(`students:${c.slug}`)) || [];
      const active = attendance.activeRosterFor(roster, attSession);
      const dueRows = await fees.classDues(c.slug);
      classStats.push({
        name: c.name,
        students: active.length,
        due: dueRows.reduce((sum, r) => sum + (r.balance.due || 0), 0),
        dueCount: dueRows.length,
      });
    }

    const BN_DAYS = ["রবি", "সোম", "মঙ্গল", "বুধ", "বৃহঃ", "শুক্র", "শনি"];
    const attendanceWeek = [];
    for (let i = 6; i >= 0; i--) {
      const dStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const [yy, mm, dd] = dStr.split("-").map(Number);
      const label = BN_DAYS[new Date(yy, mm - 1, dd).getDay()];
      let p = 0, tot = 0;
      if (!attendance.isWeeklyHoliday(dStr)) {
        for (const c of classes) {
          const shift = shiftMap[c.slug];
          if (!shift) continue;
          const rec = await attendance.getStudentAttendance(attSession, shift, c.slug, dStr);
          if (!rec) continue;
          for (const st of Object.values(rec.records)) {
            tot++;
            if (st === "present") p++;
          }
        }
      }
      attendanceWeek.push({ label, rate: tot > 0 ? Math.round((p / tot) * 100) : null });
    }

    // সর্বশেষ পরীক্ষার বিশ্লেষণ — examlist-এ সবচেয়ে শেষে যোগ হওয়া
    // examName+session গ্রুপের সব ক্লাস মিলিয়ে পাশের হার, গড় ও শীর্ষ ফলাফল।
    let examAnalytics = null;
    const lastEntry = examlist[examlist.length - 1];
    if (lastEntry) {
      const group = examlist.filter((e) => e.examName === lastEntry.examName && (e.session || "") === (lastEntry.session || ""));
      const perClass = [];
      const allRows = [];
      for (const g of group) {
        const exam = await db.get(`exam:${g.key}`);
        if (!exam) continue;
        const students = (await db.get(`students:${exam.classSlug}`)) || [];
        const rows = computeResultsRows(exam, students).filter((r) => r.allEntered);
        if (rows.length === 0) continue;
        const passed = rows.filter((r) => r.overall.grade !== "F").length;
        perClass.push({
          name: exam.className,
          appeared: rows.length,
          passed,
          passRate: Math.round((passed / rows.length) * 100),
          avg: Math.round((rows.reduce((a, r) => a + r.pct, 0) / rows.length) * 10) / 10,
        });
        rows.forEach((r) => allRows.push({ name: r.student.name, className: exam.className, pct: r.pct, grade: r.overall.grade }));
      }
      if (perClass.length > 0) {
        const appeared = perClass.reduce((a, c) => a + c.appeared, 0);
        const passed = perClass.reduce((a, c) => a + c.passed, 0);
        examAnalytics = {
          title: lastEntry.examName + (lastEntry.session ? " " + lastEntry.session : ""),
          appeared,
          passed,
          passRate: Math.round((passed / appeared) * 100),
          perClass,
          top: allRows.sort((a, b) => b.pct - a.pct).slice(0, 5),
        };
      }
    }

    analytics = { incomeExpense, classStats, attendanceWeek, examAnalytics };
  } catch (err) {
    console.error("Dashboard analytics failed:", err);
  }

  res.render("dashboard", {
    settings,
    pendingAdmissions,
    totalStudents,
    totalClasses: classes.length,
    totalExams: examGroupKeys.size,
    totalTeachers: websiteTeachers.length,
    totalDue,
    studentsWithDue,
    attendanceToday,
    feeSummaryCard,
    collectionTrend,
    recentActivities,
    urgentTasks,
    unreadCount,
    todayBn,
    trends,
    analytics,
  });
});

// Notification bell target — lists the same activity feed as the
// dashboard card (more of it), and marks everything read on open since
// opening the list is itself the acknowledgment.
app.get("/admin/notifications", async (req, res) => {
  const settings = await getSettings();
  const items = await activity.getRecentActivities(50);
  await activity.markAllRead();
  res.render("admin-notifications", { settings, items });
});

app.post("/admin/notifications/:id/delete", async (req, res) => {
  await activity.deleteActivity(req.params.id);
  res.redirect("/admin/notifications");
});

app.post("/admin/notifications/clear", async (req, res) => {
  await activity.clearAllActivities();
  res.redirect("/admin/notifications");
});

// Simple cross-class student search (name or roll/registration no.) for
// the dashboard's সার্চ বার — students only for now, the one thing an
// admin most often needs to jump straight to.
app.get("/admin/search", async (req, res) => {
  const settings = await getSettings();
  const q = (req.query.q || "").trim();
  let results = [];
  if (q) {
    const needle = q.toLowerCase();
    const classes = (await db.get("classlist")) || [];
    const rosters = await Promise.all(
      classes.map((c) => db.get(`students:${c.slug}`))
    );
    classes.forEach((c, i) => {
      const students = rosters[i] || [];
      for (const s of students) {
        const roll = String(s.roll || s.registration || "");
        if ((s.name || "").toLowerCase().includes(needle) || roll.toLowerCase().includes(needle)) {
          results.push({ ...s, classSlug: c.slug, className: c.name });
        }
      }
    });
  }
  res.render("admin-search", { settings, q, results });
});

// ---------- Class routine (weekly timetable, per shift/class) ----------
const WEEKDAYS = [
  { key: "saturday", label: "শনিবার" },
  { key: "sunday", label: "রবিবার" },
  { key: "monday", label: "সোমবার" },
  { key: "tuesday", label: "মঙ্গলবার" },
  { key: "wednesday", label: "বুধবার" },
  { key: "thursday", label: "বৃহস্পতিবার" },
  { key: "friday", label: "শুক্রবার" },
];
const PERIOD_COUNT = 8;

async function getClassShifts() {
  return (await db.get("classShifts")) || {};
}
async function getShiftPeriodTimes() {
  return (
    (await db.get("shiftPeriodTimes")) || {
      morning: Array(PERIOD_COUNT).fill(""),
      day: Array(PERIOD_COUNT).fill(""),
    }
  );
}
async function getClassRoutine(classSlug) {
  return (await db.get(`classroutine:${classSlug}`)) || { offDays: [], schedule: {} };
}

app.get("/admin/routine", async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const classShifts = await getClassShifts();
  const shiftPeriodTimes = await getShiftPeriodTimes();
  res.render("admin-routine", { classes, classShifts, shiftPeriodTimes, PERIOD_COUNT });
});

app.post("/admin/routine/shift-times", async (req, res) => {
  const clean = (arr) =>
    (Array.isArray(arr) ? arr : [arr]).slice(0, PERIOD_COUNT).map((v) => (v || "").trim());
  const shiftPeriodTimes = {
    morning: clean(req.body.morningTimes),
    day: clean(req.body.dayTimes),
  };
  while (shiftPeriodTimes.morning.length < PERIOD_COUNT) shiftPeriodTimes.morning.push("");
  while (shiftPeriodTimes.day.length < PERIOD_COUNT) shiftPeriodTimes.day.push("");
  await db.set("shiftPeriodTimes", shiftPeriodTimes);
  res.redirect("/admin/routine");
});

app.post("/admin/routine/class-shift", async (req, res) => {
  const { classSlug, shift } = req.body;
  if (classSlug && (shift === "morning" || shift === "day")) {
    const classShifts = await getClassShifts();
    classShifts[classSlug] = shift;
    await db.set("classShifts", classShifts);
  }
  res.redirect("/admin/routine");
});

app.get("/admin/routine/:classSlug", async (req, res) => {
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === req.params.classSlug);
  if (!cls) return res.redirect("/admin/routine");
  const classShifts = await getClassShifts();
  const shift = classShifts[cls.slug] || "morning";
  const shiftPeriodTimes = await getShiftPeriodTimes();
  const routine = await getClassRoutine(cls.slug);
  const websiteTeachers = (await db.get("teachers")) || [];
  res.render("admin-routine-edit", {
    cls,
    shift,
    periodTimes: shiftPeriodTimes[shift],
    routine,
    weekdays: WEEKDAYS,
    periodCount: PERIOD_COUNT,
    websiteTeachers,
    saved: req.query.saved === "1",
  });
});

app.post("/admin/routine/:classSlug/save", async (req, res) => {
  const classSlug = req.params.classSlug;
  let offDays = req.body.offDays || [];
  if (!Array.isArray(offDays)) offDays = [offDays];

  const schedule = {};
  for (const day of WEEKDAYS) {
    if (offDays.includes(day.key)) continue;
    const periods = [];
    for (let i = 0; i < PERIOD_COUNT; i++) {
      periods.push({
        subject: (req.body[`subject_${day.key}_${i}`] || "").trim(),
        teacher: (req.body[`teacher_${day.key}_${i}`] || "").trim(),
      });
    }
    schedule[day.key] = periods;
  }

  await db.set(`classroutine:${classSlug}`, { offDays, schedule });
  res.redirect(`/admin/routine/${classSlug}?saved=1`);
});

// Figures out how many of the shift's PERIOD_COUNT rows are actually in
// use for a given routine (based on period times set, or any subject
// entered), so printed PDFs don't show a wall of empty trailing rows.
// Falls back to the full count if nothing has been filled in yet.
function computeEffectivePeriodCount(routine, periodTimes, maxCount) {
  let last = 0;
  (periodTimes || []).forEach((t, i) => {
    if ((t || "").trim()) last = Math.max(last, i + 1);
  });
  Object.values((routine && routine.schedule) || {}).forEach((periods) => {
    (periods || []).forEach((p, i) => {
      if (p && p.subject) last = Math.max(last, i + 1);
    });
  });
  return last > 0 ? Math.min(last, maxCount) : maxCount;
}

// Single-class routine PDF, usable from the admin edit page regardless of
// whether the class has been published to the public routine page yet.
app.get("/admin/routine/:classSlug/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === req.params.classSlug);
  if (!cls) return res.status(404).send("ক্লাস পাওয়া যায়নি");
  const classShifts = await getClassShifts();
  const shift = classShifts[cls.slug] || "morning";
  const shiftPeriodTimes = await getShiftPeriodTimes();
  const routine = await getClassRoutine(cls.slug);
  const settings = await getSettings();
  const periodTimes = shiftPeriodTimes[shift];
  const effectiveCount = computeEffectivePeriodCount(routine, periodTimes, PERIOD_COUNT);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    contentDispositionHeader(`রুটিন-${cls.name}`, "pdf", req.query.inline ? "inline" : "attachment")
  );
  streamRoutinePDF(res, {
    schoolName: settings.schoolName,
    logoDataUrl: settings.logoDataUrl,
    weekdays: WEEKDAYS,
    periodCount: PERIOD_COUNT,
    pages: [{ className: cls.name, shift, routine, periodTimes, periodCount: effectiveCount }],
  });
});

// Public — anyone can view the published routine, no login needed.
app.get("/routine", async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const classShifts = await getClassShifts();
  const shiftPeriodTimes = await getShiftPeriodTimes();

  const shifts = { morning: [], day: [] };
  for (const cls of classes) {
    const shift = classShifts[cls.slug];
    if (shift !== "morning" && shift !== "day") continue; // not assigned to a shift yet
    const routine = await getClassRoutine(cls.slug);
    const hasContent = Object.values(routine.schedule || {}).some((periods) =>
      (periods || []).some((p) => p.subject)
    );
    if (!hasContent) continue; // skip classes with no routine entered yet
    // Same trimming as the PDF: a class using only 4 periods shouldn't show
    // 5th–8th period rows full of dashes just because some other class
    // uses all 8.
    const periodCount = computeEffectivePeriodCount(routine, shiftPeriodTimes[shift], PERIOD_COUNT);
    shifts[shift].push({ cls, routine, periodCount });
  }

  res.render("public-routine", { shifts, shiftPeriodTimes, weekdays: WEEKDAYS, periodCount: PERIOD_COUNT });
});

// Public — combined PDF of every published class's routine (one page per
// class), or (with ?class=slug) just that one class's page — used by the
// "নির্দিষ্ট ক্লাসের রুটিন ডাউনলোড" picker on the public routine page for a
// guardian who only ever needs their own child's class.
app.get("/routine/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const classShifts = await getClassShifts();
  const shiftPeriodTimes = await getShiftPeriodTimes();
  const settings = await getSettings();
  const wantedSlug = (req.query.class || "").trim();

  const pages = [];
  let wantedClass = null;
  for (const cls of classes) {
    if (wantedSlug && cls.slug !== wantedSlug) continue;
    const shift = classShifts[cls.slug];
    if (shift !== "morning" && shift !== "day") continue;
    const routine = await getClassRoutine(cls.slug);
    const hasContent = Object.values(routine.schedule || {}).some((periods) =>
      (periods || []).some((p) => p.subject)
    );
    if (!hasContent) continue;
    if (wantedSlug) wantedClass = cls;
    pages.push({
      className: cls.name,
      shift,
      routine,
      periodTimes: shiftPeriodTimes[shift],
      periodCount: computeEffectivePeriodCount(routine, shiftPeriodTimes[shift], PERIOD_COUNT),
    });
  }
  // Asked for one specific class but it isn't published (bad slug, or not
  // yet assigned a shift/routine) — don't silently fall back to the
  // combined PDF, that'd be confusing.
  if (wantedSlug && !wantedClass) return res.status(404).send("এই ক্লাসের রুটিন এখনো প্রকাশ করা হয়নি।");
  if (pages.length === 0) return res.status(404).send("এখনো কোনো রুটিন প্রকাশ করা হয়নি।");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    contentDispositionHeader(wantedClass ? `রুটিন-${wantedClass.name}` : "ক্লাস-রুটিন", "pdf", req.query.inline ? "inline" : "attachment")
  );
  streamRoutinePDF(res, {
    schoolName: settings.schoolName,
    logoDataUrl: settings.logoDataUrl,
    weekdays: WEEKDAYS,
    periodCount: PERIOD_COUNT,
    pages,
  });
});

// ---------- Admin: website content management (notices, admission info,
// teachers, gallery, contact) ----------
app.get("/admin/website", async (req, res) => {
  const website = await getWebsite();
  const notices = ((await db.get("notices")) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const teachers = (await db.get("teachers")) || [];
  const gallery = (await db.get("gallery")) || [];
  const totalStudents = await getTotalStudentCount();
  const rolePeople = { head: findRoleTeacher(teachers, "head"), director: findRoleTeacher(teachers, "director") };
  const features = (await db.get("features")) || [];
  res.render("admin-website", { website, notices, teachers, gallery, totalStudents, rolePeople, features });
});

app.post("/admin/website/info", async (req, res) => {
  const website = await getWebsite();
  website.tagline = (req.body.tagline || "").trim();
  website.about = (req.body.about || "").trim();
  website.admission = (req.body.admission || "").trim();
  website.contactAddress = (req.body.contactAddress || "").trim();
  website.contactPhone = (req.body.contactPhone || "").trim();
  website.contactEmail = (req.body.contactEmail || "").trim();
  website.mapEmbedUrl = (req.body.mapEmbedUrl || "").trim();
  website.foundedYear = (req.body.foundedYear || "").trim();
  website.facebookUrl = (req.body.facebookUrl || "").trim();
  website.youtubeUrl = (req.body.youtubeUrl || "").trim();
  website.admissionBannerEnabled = req.body.admissionBannerEnabled === "on";
  website.admissionBannerText = (req.body.admissionBannerText || "").trim();
  await db.set("website", website);
  res.redirect("/admin/website");
});

// Headmaster's and director's message cards on the public home page — each has
// its own form so saving one never touches the other website fields.
["head", "director"].forEach((key) => {
  const Key = key.charAt(0).toUpperCase() + key.slice(1);
  app.post(`/admin/website/${key}`, async (req, res) => {
    const website = await getWebsite();
    // Name/designation/photo inputs are hidden while the teacher list already
    // supplies them, so only overwrite what was actually submitted.
    if (req.body[`${key}Name`] !== undefined) website[`${key}Name`] = (req.body[`${key}Name`] || "").trim().slice(0, 80);
    if (req.body[`${key}Designation`] !== undefined) website[`${key}Designation`] = (req.body[`${key}Designation`] || "").trim().slice(0, 80);
    website[`${key}Message`] = (req.body[`${key}Message`] || "").trim().slice(0, 2000);
    const photo = (req.body[`${key}PhotoDataUrl`] || "").trim();
    if (photo) website[`${key}PhotoDataUrl`] = photo;
    if (req.body[`remove${Key}Photo`] === "on") website[`${key}PhotoDataUrl`] = "";
    await db.set("website", website);
    res.redirect("/admin/website");
  });
});

// ভিশন ও মিশন card — vision is a short paragraph, mission is one point per line.
app.post("/admin/website/vision", async (req, res) => {
  const website = await getWebsite();
  website.vision = (req.body.vision || "").trim().slice(0, 400);
  website.mission = (req.body.mission || "").trim().slice(0, 1200);
  await db.set("website", website);
  res.redirect("/admin/website");
});

// Show/hide the public ফি-এর তথ্য table (amounts come from Admin → ফি).
app.post("/admin/website/fees", async (req, res) => {
  const website = await getWebsite();
  website.showFees = req.body.showFees === "on";
  website.feesNote = (req.body.feesNote || "").trim().slice(0, 400);
  await db.set("website", website);
  res.redirect("/admin/website");
});

// সুযোগ-সুবিধা cards on the public home page — each is a small emoji icon, a
// title and an optional one-line description, managed at /admin/website. Can
// hold school facilities or online services, whatever the school wants to
// highlight.
function cleanFeatureFields(body) {
  const icon = Array.from((body.icon || "").trim()).slice(0, 3).join("");
  return {
    icon: icon || "✅",
    title: (body.title || "").trim().slice(0, 60),
    text: (body.text || "").trim().slice(0, 200),
  };
}

app.post("/admin/website/features/add", async (req, res) => {
  const features = (await db.get("features")) || [];
  const f = cleanFeatureFields(req.body);
  if (f.title && features.length < 24) {
    features.push({ id: shortId(), ...f });
    await db.set("features", features);
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/features/:id/edit", async (req, res) => {
  const features = (await db.get("features")) || [];
  const item = features.find((x) => x.id === req.params.id);
  const f = cleanFeatureFields(req.body);
  if (item && f.title) {
    Object.assign(item, f);
    await db.set("features", features);
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/features/:id/delete", async (req, res) => {
  const features = ((await db.get("features")) || []).filter((x) => x.id !== req.params.id);
  await db.set("features", features);
  res.redirect("/admin/website");
});

app.post("/admin/website/notices/add", async (req, res) => {
  const notices = (await db.get("notices")) || [];
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  const date = (req.body.date || "").trim();
  if (title) {
    notices.push({ id: shortId(), title, body, date, createdAt: Date.now() });
    await db.set("notices", notices);
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/notices/:id/delete", async (req, res) => {
  let notices = (await db.get("notices")) || [];
  notices = notices.filter((n) => n.id !== req.params.id);
  await db.set("notices", notices);
  res.redirect("/admin/website");
});

app.post("/admin/website/teachers/add", async (req, res) => {
  const teachers = (await db.get("teachers")) || [];
  const name = (req.body.name || "").trim();
  const designation = (req.body.designation || "").trim();
  const photoDataUrl = (req.body.photoDataUrl || "").trim();
  if (name) {
    const teacher = { id: shortId(), name, designation };
    if (photoDataUrl) teacher.photoDataUrl = photoDataUrl;
    teachers.push(teacher);
    await db.set("teachers", teachers);
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/teachers/:id/edit", async (req, res) => {
  const teachers = (await db.get("teachers")) || [];
  const teacher = teachers.find((t) => t.id === req.params.id);
  if (teacher) {
    const name = (req.body.name || "").trim();
    const designation = (req.body.designation || "").trim();
    const photoDataUrl = (req.body.photoDataUrl || "").trim();
    if (name) {
      teacher.name = name;
      teacher.designation = designation;
      if (photoDataUrl) teacher.photoDataUrl = photoDataUrl;
      await db.set("teachers", teachers);
    }
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/teachers/:id/delete", async (req, res) => {
  let teachers = (await db.get("teachers")) || [];
  teachers = teachers.filter((t) => t.id !== req.params.id);
  await db.set("teachers", teachers);
  res.redirect("/admin/website");
});

app.post("/admin/website/gallery/add", async (req, res) => {
  const gallery = (await db.get("gallery")) || [];
  const imageDataUrl = (req.body.imageDataUrl || "").trim();
  const caption = (req.body.caption || "").trim();
  if (imageDataUrl) {
    gallery.push({ id: shortId(), imageDataUrl, caption });
    await db.set("gallery", gallery);
  }
  res.redirect("/admin/website");
});

app.post("/admin/website/gallery/:id/delete", async (req, res) => {
  let gallery = (await db.get("gallery")) || [];
  gallery = gallery.filter((g) => g.id !== req.params.id);
  await db.set("gallery", gallery);
  res.redirect("/admin/website");
});

// ---------- Admin: settings, backup & restore ----------
app.get("/admin", async (req, res) => {
  const settings = await getSettings();
  res.render("admin", { restoreError: null, restoreSuccess: null, settings, counterReset: req.query.counterReset === "1" });
});

app.post("/admin/school-name", async (req, res) => {
  const settings = await getSettings();
  settings.schoolName = (req.body.schoolName || "").trim();
  await db.set("settings", settings);
  res.redirect("/admin");
});

app.post("/admin/logo", async (req, res) => {
  const settings = await getSettings();
  const dataUrl = (req.body.logoDataUrl || "").trim();
  if (dataUrl) settings.logoDataUrl = dataUrl;
  await db.set("settings", settings);
  res.redirect("/admin");
});

app.post("/admin/logo/remove", async (req, res) => {
  const settings = await getSettings();
  delete settings.logoDataUrl;
  await db.set("settings", settings);
  res.redirect("/admin");
});

// Zeroes out this calendar year's ভর্তি আবেদন নম্বর counter — for use after
// test admissions were submitted, so the next real submission starts back
// at 0001 instead of continuing from wherever testing left off. Only
// affects the number shown/searched on new applications; it does not
// touch any already-submitted application's stored admissionNo.
app.post("/admin/admissions/reset-counter", async (req, res) => {
  const year = new Date().getFullYear();
  await db.set(`admissions:counter:${year}`, 0);
  res.redirect("/admin?counterReset=1");
});

app.get("/admin/backup", async (req, res) => {
  try {
    const keys = await db.keys("");
    const dump = {};
    for (const key of keys) {
      dump[key] = await db.get(key);
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", contentDispositionHeader(`progress-card-backup-${dateStr}`, "json"));
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) {
    console.error("Backup export error:", err);
    res.status(500).send("ব্যাকআপ তৈরি করতে সমস্যা হয়েছে। সার্ভার লগ চেক করুন।");
  }
});

app.post("/admin/restore", async (req, res) => {
  try {
    const dump = JSON.parse(req.body.backupJson || "");
    if (!dump || typeof dump !== "object" || Array.isArray(dump)) throw new Error("invalid shape");
    const keys = Object.keys(dump);
    for (const key of keys) {
      await db.set(key, dump[key]);
    }
    const settings = await getSettings();
    res.render("admin", { restoreError: null, restoreSuccess: keys.length, settings, counterReset: false });
  } catch (err) {
    console.error("Backup restore error:", err);
    const settings = await getSettings();
    res.render("admin", {
      restoreError: "ফাইলটা সঠিক ব্যাকআপ JSON মনে হচ্ছে না। এই সিস্টেম থেকেই আগে ডাউনলোড করা ব্যাকআপ ফাইলটা দিন।",
      restoreSuccess: null,
      settings,
      counterReset: false,
    });
  }
});

// Wipes every student's fee ledger (all classes) — for clearing test/demo
// fee data before real billing starts. Gated behind a typed confirmation
// phrase (checked here too, not just client-side, since this is
// irreversible) and logged to the activity feed so there's at least a
// record that it happened and when.
app.post("/admin/fees/reset-all-ledgers", async (req, res) => {
  const settings = await getSettings();
  if ((req.body.confirmPhrase || "").trim() !== "সব মুছে দিন") {
    return res.render("admin", {
      restoreError: null,
      restoreSuccess: null,
      settings,
      counterReset: false,
      ledgerResetError: "নিশ্চিতকরণ লেখাটা মেলেনি — কিছু মোছা হয়নি।",
    });
  }
  const classes = (await db.get("classlist")) || [];
  const count = await fees.resetAllLedgers(classes.map((c) => c.slug));
  await activity.logActivity(
    "fee_payment",
    `⚠️ সব ছাত্রের ফি লেজার রিসেট করা হয়েছে (${count} জন ছাত্রের ডাটা মোছা হয়েছে)`,
    null
  );
  res.render("admin", { restoreError: null, restoreSuccess: null, settings, counterReset: false, ledgerResetDone: count });
});

// ---------- Class Promotion (bulk, once-a-year, based on বার্ষিক পরীক্ষা) ----------
// GET: shows the session-picker form (and, if a plan was just built, its
// preview — see /admin/promotion/preview below).
app.get("/admin/promotion", async (req, res) => {
  const settings = await getSettings();
  res.render("admin-promotion", { settings, plan: null, session: "", applied: null });
});

// Builds the plan and shows it for review — does NOT change any data yet.
app.post("/admin/promotion/preview", async (req, res) => {
  const settings = await getSettings();
  const session = (req.body.session || "").trim();
  if (!session) return res.render("admin-promotion", { settings, plan: null, session: "", applied: null });
  const plan = await buildPromotionPlan(db, session);
  res.render("admin-promotion", { settings, plan, session, applied: null });
});

// Re-builds the plan fresh (rather than trusting anything posted back from
// the browser) and actually applies it — this is the irreversible step.
app.post("/admin/promotion/confirm", async (req, res) => {
  const settings = await getSettings();
  const session = (req.body.session || "").trim();
  if (!session) return res.render("admin-promotion", { settings, plan: null, session: "", applied: null });
  const plan = await buildPromotionPlan(db, session);
  await applyPromotionPlan(db, plan);
  res.render("admin-promotion", { settings, plan: null, session: "", applied: plan });
});

// ---------- ফি ম্যানেজমেন্ট (Fee management) ----------
// Admin-only for now (no teacher access) — see lib/fees.js for the data
// model: a per-class+session fee structure, plus a simple running
// charge/payment ledger per student.
app.get("/admin/fees", async (req, res) => {
  const settings = await getSettings();
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const session = (req.query.session || String(new Date().getFullYear())).trim();

  // Same "one exam name+session run across several classes" grouping used
  // on /exams, so a single ৫ম শ্রেণির/৬ষ্ঠ শ্রেণির... বার্ষিক পরীক্ষা shows
  // as one pickable row instead of one per class.
  const examlist = (await db.get("examlist")) || [];
  const examGroups = [];
  const groupIndex = new Map();
  examlist.forEach((e) => {
    const gKey = `${e.examName}||${e.session || ""}`;
    if (!groupIndex.has(gKey)) {
      groupIndex.set(gKey, examGroups.length);
      examGroups.push({ examName: e.examName, session: e.session, entries: [] });
    }
    examGroups[groupIndex.get(gKey)].entries.push(e);
  });

  const monthlyResult =
    req.query.monthlyCharged !== undefined
      ? { studentsCharged: parseInt(req.query.monthlyCharged, 10) || 0, classesSkipped: (req.query.monthlySkipped || "").split("||").filter(Boolean) }
      : null;
  const examResult =
    req.query.examCharged !== undefined
      ? { studentsCharged: parseInt(req.query.examCharged, 10) || 0, classesSkipped: (req.query.examSkipped || "").split("||").filter(Boolean) }
      : null;

  res.render("admin-fees", { settings, classes, session, examGroups, monthlyResult, examResult });
});

app.get("/admin/fees/structure/:classSlug", async (req, res) => {
  const { classSlug } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  if (!cls) return res.status(404).send("ক্লাস পাওয়া যায়নি");
  const session = (req.query.session || String(new Date().getFullYear())).trim();
  const structure = await fees.getFeeStructure(classSlug, session);
  res.render("admin-fees-structure", {
    settings: await getSettings(),
    classSlug,
    className: cls.name,
    session,
    structure,
    saved: req.query.saved === "1",
  });
});

app.post("/admin/fees/structure/:classSlug", async (req, res) => {
  const { classSlug } = req.params;
  const session = (req.body.session || "").trim() || String(new Date().getFullYear());
  await fees.saveFeeAmounts(classSlug, session, {
    sessionFee: req.body.sessionFee,
    monthlyTuition: req.body.monthlyTuition,
    transportMonthly: req.body.transportMonthly,
    coachingMonthly: req.body.coachingMonthly,
    examFees: {
      quarterly: req.body.examFeeQuarterly,
      halfYearly: req.body.examFeeHalfYearly,
      annual: req.body.examFeeAnnual,
    },
  });
  res.redirect(`/admin/fees/structure/${encodeURIComponent(classSlug)}?session=${encodeURIComponent(session)}&saved=1`);
});

app.post("/admin/fees/structure/:classSlug/items/add", async (req, res) => {
  const { classSlug } = req.params;
  const session = (req.body.session || "").trim() || String(new Date().getFullYear());
  const { name, amount } = req.body;
  if ((name || "").trim() && Number(amount) > 0) {
    await fees.addAdmissionItem(classSlug, session, { name, amount });
  }
  res.redirect(`/admin/fees/structure/${encodeURIComponent(classSlug)}?session=${encodeURIComponent(session)}`);
});

app.post("/admin/fees/structure/:classSlug/items/:itemId/delete", async (req, res) => {
  const { classSlug, itemId } = req.params;
  const session = (req.body.session || "").trim() || String(new Date().getFullYear());
  await fees.removeAdmissionItem(classSlug, session, itemId);
  res.redirect(`/admin/fees/structure/${encodeURIComponent(classSlug)}?session=${encodeURIComponent(session)}`);
});

// Bills every student in every class that has a monthly amount configured
// for the given session — see fees.generateMonthlyCharges for the
// duplicate-safe / not-before-admission logic.
app.post("/admin/fees/generate-monthly", async (req, res) => {
  const session = (req.body.session || "").trim() || String(new Date().getFullYear());
  const month = (req.body.month || "").trim() || new Date().toISOString().slice(0, 7);
  const result = await fees.generateMonthlyCharges(session, month);
  res.redirect(
    `/admin/fees?session=${encodeURIComponent(session)}&monthlyCharged=${result.studentsCharged}&monthlySkipped=${encodeURIComponent(
      result.classesSkipped.join("||")
    )}`
  );
});

// Bills the configured exam fee (matched by exam name — ত্রি মাসিক/অর্ধ
// বার্ষিক/বার্ষিক) to every student across every class in that exam's run.
app.post("/admin/fees/generate-exam", async (req, res) => {
  const [examName, session] = (req.body.examChoice || "||").split("||").map((s) => s.trim());
  const examlist = (await db.get("examlist")) || [];
  const entries = examlist.filter((e) => e.examName === examName && (e.session || "") === session);
  const result = await fees.generateExamCharges(entries);
  res.redirect(
    `/admin/fees?session=${encodeURIComponent(session)}&examCharged=${result.studentsCharged}&examSkipped=${encodeURIComponent(
      result.classesSkipped.join("||")
    )}`
  );
});

app.get("/admin/fees/dues", async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const classSlug = req.query.class || (classes[0] && classes[0].slug) || "";
  const rows = classSlug ? await fees.classDues(classSlug) : [];
  const totalDue = rows.reduce((sum, r) => sum + r.balance.due, 0);
  res.render("admin-fees-dues", { settings: await getSettings(), classes, classSlug, rows, totalDue });
});

// ---------- Teacher salary (admin-only) ----------
// Same ledger idea as the student fee ledger above — see
// lib/teacherSalary.js. monthlySalary lives directly on each teacher's
// record in the "teachers" list (set below), so changing it only affects
// months generated after the change; already-billed months keep their
// original amount, same as fee-structure changes never touching old
// student charges.
app.get("/admin/salary", async (req, res) => {
  const teachers = (await db.get("teachers")) || [];
  res.render("admin-salary", {
    teachers,
    monthlyResult: req.query.charged !== undefined ? {
      teachersCharged: Number(req.query.charged) || 0,
      coachingCharged: Number(req.query.coachingCharged) || 0,
      teachersSkipped: (req.query.skipped || "").split(",").filter(Boolean),
    } : null,
    amountSaved: req.query.amountSaved === "1",
  });
});

app.post("/admin/salary/:teacherId/set-amount", async (req, res) => {
  const teachers = (await db.get("teachers")) || [];
  const teacher = teachers.find((t) => t.id === req.params.teacherId);
  if (teacher) {
    teacher.monthlySalary = Number(req.body.monthlySalary) || 0;
    teacher.coachingMonthlySalary = Number(req.body.coachingMonthlySalary) || 0;
    await db.set("teachers", teachers);
  }
  res.redirect("/admin/salary?amountSaved=1");
});

app.post("/admin/salary/generate-monthly", async (req, res) => {
  const month = req.body.month;
  const result = month ? await teacherSalary.generateMonthlySalary(month) : { teachersCharged: 0, coachingCharged: 0, teachersSkipped: [] };
  res.redirect(`/admin/salary?charged=${result.teachersCharged}&coachingCharged=${result.coachingCharged}&skipped=${encodeURIComponent(result.teachersSkipped.join(","))}`);
});

app.get("/admin/salary/dues", async (req, res) => {
  const rows = (await teacherSalary.allBalances()).sort((a, b) => b.balance.due - a.balance.due);
  const totalDue = rows.reduce((sum, r) => sum + Math.max(r.balance.due, 0), 0);
  const totalAdvance = rows.reduce((sum, r) => sum + Math.max(-r.balance.due, 0), 0);
  res.render("admin-salary-dues", { rows, totalDue, totalAdvance });
});

// ---------- Institutional expenses (বিদ্যুৎ বিল, চিকিৎসা, মেটেরিয়াল ইত্যাদি) ----------
// Separate from teacher salary (which has its own ledger system above) —
// this is everything else the school spends on. Feeds the ড্যাশবোর্ড's
// আয়-ব্যয় সারাংশ card alongside salaryPaidThisMonth.
app.get("/admin/expenses", async (req, res) => {
  const month = req.query.month || attendance.currentYearMonth();
  const all = (await expenses.listExpenses()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const rows = all.filter((e) => (e.date || "").startsWith(month));
  const monthTotal = rows.reduce((sum, e) => sum + e.amount, 0);
  res.render("admin-expenses", {
    categories: expenses.CATEGORIES,
    rows,
    month,
    monthTotal,
    saved: req.query.saved === "1",
  });
});

app.post("/admin/expenses/add", async (req, res) => {
  const { category, customCategory, amount, note, date } = req.body;
  const finalCategory = category === "অন্যান্য" && customCategory ? customCategory.trim() : category;
  if (Number(amount) > 0) {
    const entry = await expenses.addExpense({ category: finalCategory, amount, note, date });
    await activity.logActivity(
      "expense",
      `${entry.category} বাবদ ৳${entry.amount.toLocaleString("en-US")} খরচ যোগ হয়েছে`,
      `/admin/expenses?month=${encodeURIComponent(entry.date.slice(0, 7))}`
    );
  }
  res.redirect(`/admin/expenses?month=${encodeURIComponent(req.body.date ? req.body.date.slice(0, 7) : attendance.currentYearMonth())}&saved=1`);
});

app.post("/admin/expenses/:id/delete", async (req, res) => {
  await expenses.deleteExpense(req.params.id);
  res.redirect(`/admin/expenses?month=${encodeURIComponent(req.query.month || attendance.currentYearMonth())}`);
});

// ---------- Loans (পরিচালক বিভিন্ন উৎস থেকে যে ঋণ নেন) ----------
// প্রতিটি ঋণের নিজস্ব payments লগ থাকে (lib/loans.js) — মোট পরিশোধিত ও
// বাকি ব্যালেন্স সবসময় সেখান থেকেই হিসাব হয়। এই মাসে যা আসলে পরিশোধ করা
// হয়েছে তা ড্যাশবোর্ডের আয়-ব্যয় সারাংশে "মোট ব্যয়"-এ যোগ হয়; মোট বকেয়া
// ঋণ (দায়) আলাদাভাবে দেখানো হয়, নেট আয়ের হিসাবে ধরা হয় না।
app.get("/admin/loans", async (req, res) => {
  const loanList = (await loans.listLoansWithSummary()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const totalOutstanding = loanList.reduce((sum, l) => sum + l.remaining, 0);
  res.render("admin-loans", {
    loans: loanList,
    totalOutstanding,
    repaymentTypes: loans.REPAYMENT_TYPES,
    saved: req.query.saved === "1",
  });
});

app.post("/admin/loans/add", async (req, res) => {
  const { lender, amount, date, interestRate, repaymentType, note } = req.body;
  if (Number(amount) > 0) {
    const entry = await loans.addLoan({ lender, amount, date, interestRate, repaymentType, note });
    await activity.logActivity(
      "loan",
      `${entry.lender} থেকে ৳${entry.amount.toLocaleString("en-US")} ঋণ যোগ হয়েছে`,
      `/admin/loans/${entry.id}`
    );
  }
  res.redirect("/admin/loans?saved=1");
});

app.post("/admin/loans/:id/delete", async (req, res) => {
  await loans.deleteLoan(req.params.id);
  res.redirect("/admin/loans");
});

app.get("/admin/loans/:id", async (req, res) => {
  const loan = await loans.getLoanWithSummary(req.params.id);
  if (!loan) return res.redirect("/admin/loans");
  res.render("admin-loan-detail", { loan, saved: req.query.saved === "1" });
});

app.post("/admin/loans/:id/payment/add", async (req, res) => {
  const { amount, date, note } = req.body;
  const loan = await loans.getLoanWithSummary(req.params.id);
  if (loan && Number(amount) > 0) {
    const capped = Math.min(Number(amount), loan.remaining);
    await loans.addPayment(req.params.id, { amount: capped, date, note });
    await activity.logActivity(
      "loan-payment",
      `${loan.lender}-কে ৳${capped.toLocaleString("en-US")} ঋণ পরিশোধ`,
      `/admin/loans/${req.params.id}`
    );
  }
  res.redirect(`/admin/loans/${req.params.id}?saved=1`);
});

app.post("/admin/loans/:id/payment/:paymentId/delete", async (req, res) => {
  await loans.deletePayment(req.params.id, req.params.paymentId);
  res.redirect(`/admin/loans/${req.params.id}`);
});

app.get("/admin/salary/:teacherId", async (req, res) => {
  const teachers = (await db.get("teachers")) || [];
  const teacher = teachers.find((t) => t.id === req.params.teacherId);
  if (!teacher) return res.redirect("/admin/salary");
  const chronological = (await teacherSalary.getLedger(teacher.id))
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.createdAt - b.createdAt);
  const balance = teacherSalary.computeBalance(chronological);
  res.render("teacher-salary", {
    teacher,
    balance,
    ledger: chronological.slice().reverse(),
    saved: req.query.saved === "1",
  });
});

app.post("/admin/salary/:teacherId/withdrawal", async (req, res) => {
  const { teacherId } = req.params;
  const { amount, note, isAdvance } = req.body;
  if (Number(amount) > 0) {
    await teacherSalary.addWithdrawal(teacherId, { amount, note, isAdvance: isAdvance === "1" });
  }
  res.redirect(`/admin/salary/${encodeURIComponent(teacherId)}?saved=1`);
});

app.post("/admin/salary/:teacherId/charge", async (req, res) => {
  const { teacherId } = req.params;
  const { label, amount, note } = req.body;
  if (Number(amount) > 0) {
    await teacherSalary.addOneOffCharge(teacherId, { label: (label || "").trim(), amount, note });
  }
  res.redirect(`/admin/salary/${encodeURIComponent(teacherId)}?saved=1`);
});

app.post("/admin/salary/:teacherId/entry/:entryId/delete", async (req, res) => {
  const { teacherId, entryId } = req.params;
  await teacherSalary.deleteEntry(teacherId, entryId);
  res.redirect(`/admin/salary/${encodeURIComponent(teacherId)}?saved=1`);
});

// ---------- Students ----------
app.get("/students", async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const classSlug = req.query.class || (classes[0] && classes[0].slug) || "";
  const students = classSlug ? (await db.get(`students:${classSlug}`)) || [] : [];
  const importResult =
    req.query.imported !== undefined
      ? {
          added: parseInt(req.query.imported, 10) || 0,
          skippedDuplicate: parseInt(req.query.skippedDup, 10) || 0,
          skippedNoName: parseInt(req.query.skippedNoName, 10) || 0,
          error: null,
        }
      : req.query.importError
      ? { added: 0, skippedDuplicate: 0, skippedNoName: 0, error: req.query.importError }
      : null;
  res.render("students", { classes, classSlug, students, importResult });
});

app.post("/students/add-class", async (req, res) => {
  const className = (req.body.className || "").trim();
  if (className) {
    const classes = (await db.get("classlist")) || [];
    const slug = slugify(className);
    if (!classes.find((c) => c.slug === slug)) {
      // classCode is fixed permanently at the moment the class is created,
      // based on how many classes already exist — so classes keep their
      // registration-number code even if another class is deleted later.
      const code = String(classes.length).padStart(2, "0");
      classes.push({ slug, name: className, code });
      await db.set("classlist", classes);
    }
    return res.redirect(`/students?class=${encodeURIComponent(slug)}`);
  }
  res.redirect("/students");
});

app.post("/students/add", async (req, res) => {
  const { classSlug, name, roll, section } = req.body;
  if (classSlug && name) {
    const key = `students:${classSlug}`;
    const students = (await db.get(key)) || [];
    const cleanName = name.trim();
    const cleanRoll = (roll || "").trim();
    const isDuplicate = students.some(
      (s) => s.name.toLowerCase() === cleanName.toLowerCase() && (s.roll || "") === cleanRoll
    );
    if (!isDuplicate) {
      const classes = (await db.get("classlist")) || [];
      const cls = classes.find((c) => c.slug === classSlug);
      const classCode = cls ? await ensureClassCode(classes, cls) : "00";
      students.push({
        id: shortId(),
        name: cleanName,
        roll: cleanRoll,
        section: (section || "").trim(),
        registration: await generateRegistrationNumber(classSlug, classCode),
      });
      students.sort((a, b) => (a.roll || "").localeCompare(b.roll || "", undefined, { numeric: true }));
      await db.set(key, students);
    }
  }
  res.redirect(`/students?class=${encodeURIComponent(classSlug)}`);
});

// ---------- Bulk student import (Super Admin only — this whole /students
// section is already unreachable to teacher sessions, see requireAuth in
// lib/auth.js) ----------
app.get("/students/import/template", async (req, res) => {
  const buffer = buildWorkbookBuffer(STUDENT_IMPORT_HEADERS, [STUDENT_IMPORT_EXAMPLE_ROW]);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDispositionHeader("শিক্ষার্থী-ইম্পোর্ট-টেমপ্লেট", "xlsx"));
  res.send(buffer);
});

// ---------- Class-wise full student export (A2Z — everything on the
// profile page, one row per student) ----------
const STUDENT_EXPORT_HEADERS = [
  "রোল",
  "নাম",
  "রেজিস্ট্রেশন নম্বর",
  "শিফট",
  "ভর্তির সেশন",
  "পিতার নাম",
  "মাতার নাম",
  "জন্ম তারিখ",
  "লিঙ্গ",
  "রক্তের গ্রুপ",
  "পিতার মোবাইল",
  "মাতার মোবাইল",
  "বর্তমান ঠিকানা",
  "পূর্ববর্তী স্কুল",
  "ছাড়ার কারণ (যদি প্রযোজ্য)",
  "গাড়ি সুবিধা",
  "কোচিং",
  "ছাড়ের ধরণ",
  "ছাড়ের মান",
  "ছাড়ের কারণ",
  "ছাড় শেষ সেশন",
];
function studentToExportRow(s) {
  return [
    s.roll || "",
    s.name || "",
    s.registration || "",
    s.section || "",
    s.session || "",
    s.fatherName || "",
    s.motherName || "",
    s.dob || "",
    s.gender || "",
    s.bloodGroup || "",
    s.fatherPhone || "",
    s.motherPhone || "",
    s.presentAddress || "",
    s.previousSchool || "",
    s.reasonForLeaving || "",
    s.transportEnabled ? "হ্যাঁ" : "না",
    s.coachingEnabled ? "হ্যাঁ" : "না",
    s.discountType === "percent" ? "শতাংশ (%)" : s.discountType === "amount" ? "নির্দিষ্ট টাকা" : "",
    s.discountValue || "",
    s.discountNote || "",
    s.discountUntilSession || "",
  ];
}
app.get("/students/export", async (req, res) => {
  const classSlug = (req.query.class || "").trim();
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  if (!cls) return res.redirect("/students");
  const students = (await db.get(`students:${classSlug}`)) || [];
  const rows = students.map(studentToExportRow);
  const buffer = buildWorkbookBuffer(STUDENT_EXPORT_HEADERS, rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDispositionHeader(`শিক্ষার্থী-তালিকা-${cls.name}`, "xlsx"));
  res.send(buffer);
});

app.post("/students/import", upload.single("file"), async (req, res) => {
  const classSlug = (req.body.classSlug || "").trim();
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  if (!cls) return res.redirect("/students");

  if (!req.file) {
    return res.redirect(`/students?class=${encodeURIComponent(classSlug)}&importError=${encodeURIComponent("কোনো ফাইল পাওয়া যায়নি।")}`);
  }

  let rows;
  try {
    rows = parseWorkbookBuffer(req.file.buffer);
  } catch (err) {
    console.error("Student import parse error:", err);
    return res.redirect(
      `/students?class=${encodeURIComponent(classSlug)}&importError=${encodeURIComponent("ফাইলটি পড়া যায়নি। .xlsx বা .csv ফাইল দিন।")}`
    );
  }

  const key = `students:${classSlug}`;
  const students = (await db.get(key)) || [];

  let added = 0;
  let skippedDuplicate = 0;
  let skippedNoName = 0;
  for (const row of rows) {
    const parsed = studentFromImportRow(row);
    if (!parsed) {
      skippedNoName++;
      continue;
    }
    const isDuplicate = students.some(
      (s) => s.name.toLowerCase() === parsed.name.toLowerCase() && (s.roll || "") === parsed.roll
    );
    if (isDuplicate) {
      skippedDuplicate++;
      continue;
    }
    parsed.id = shortId();
    // No auto-generated registration number here — parsed.registration is
    // only set above if the admin filled it in on the sheet. Otherwise it
    // stays blank and can be typed in manually on the student's profile.
    students.push(parsed);
    added++;
  }

  students.sort((a, b) => (a.roll || "").localeCompare(b.roll || "", undefined, { numeric: true }));
  await db.set(key, students);

  res.redirect(
    `/students?class=${encodeURIComponent(classSlug)}&imported=${added}&skippedDup=${skippedDuplicate}&skippedNoName=${skippedNoName}`
  );
});

app.post("/students/delete", async (req, res) => {
  const { classSlug, id } = req.body;
  const key = `students:${classSlug}`;
  const students = ((await db.get(key)) || []).filter((s) => s.id !== id);
  await db.set(key, students);
  res.redirect(`/students?class=${encodeURIComponent(classSlug)}`);
});

app.post("/students/edit", async (req, res) => {
  const { classSlug, id, name, roll, section } = req.body;
  const key = `students:${classSlug}`;
  const students = (await db.get(key)) || [];
  const student = students.find((s) => s.id === id);
  if (student) {
    student.name = (name || "").trim();
    student.roll = (roll || "").trim();
    student.section = (section || "").trim();
    students.sort((a, b) => (a.roll || "").localeCompare(b.roll || "", undefined, { numeric: true }));
    await db.set(key, students);
  }
  res.redirect(`/students?class=${encodeURIComponent(classSlug)}`);
});

app.post("/students/delete-class", async (req, res) => {
  const { classSlug } = req.body;
  const classes = ((await db.get("classlist")) || []).filter((c) => c.slug !== classSlug);
  await db.set("classlist", classes);
  await db.set(`students:${classSlug}`, []);
  res.redirect("/students");
});

// ---------- Student Profile (staff only — full details, not just the
// quick roll/name/section fields shown inline in the students list) ----------
app.get("/students/:classSlug/:id", async (req, res) => {
  const { classSlug, id } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  const students = (await db.get(`students:${classSlug}`)) || [];
  const student = students.find((s) => s.id === id);
  if (!cls || !student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");
  res.render("student-profile", { classSlug, className: cls.name, student, saved: req.query.saved === "1" });
});

app.post("/students/:classSlug/:id", async (req, res) => {
  const { classSlug, id } = req.params;
  const key = `students:${classSlug}`;
  const students = (await db.get(key)) || [];
  const student = students.find((s) => s.id === id);
  if (student) {
    const b = req.body;
    student.name = (b.name || "").trim();
    student.roll = (b.roll || "").trim();
    student.section = (b.section || "").trim();
    student.registration = (b.registration || "").trim();
    student.fatherName = (b.fatherName || "").trim();
    student.motherName = (b.motherName || "").trim();
    student.dob = (b.dob || "").trim();
    student.gender = (b.gender || "").trim();
    student.bloodGroup = (b.bloodGroup || "").trim();
    student.fatherPhone = (b.fatherPhone || "").trim();
    student.motherPhone = (b.motherPhone || "").trim();
    student.presentAddress = (b.presentAddress || "").trim();
    student.previousSchool = (b.previousSchool || "").trim();
    student.reasonForLeaving = (b.reasonForLeaving || "").trim();
    student.session = (b.session || "").trim();
    student.transportEnabled = b.transportEnabled === "1";
    student.transportFee = b.transportFee !== undefined && b.transportFee !== "" ? Number(b.transportFee) || 0 : 0;
    student.coachingEnabled = b.coachingEnabled === "1";
    student.coachingFee = b.coachingFee !== undefined && b.coachingFee !== "" ? Number(b.coachingFee) || 0 : 0;
    student.discountType = b.discountType === "percent" || b.discountType === "amount" ? b.discountType : "";
    student.discountValue = student.discountType ? Number(b.discountValue) || 0 : 0;
    student.discountNote = (b.discountNote || "").trim();
    student.discountUntilSession = (b.discountUntilSession || "").trim();
    if ((b.photoDataUrl || "").trim()) student.photoDataUrl = b.photoDataUrl.trim();
    students.sort((a, c) => (a.roll || "").localeCompare(c.roll || "", undefined, { numeric: true }));
    await db.set(key, students);
  }
  res.redirect(`/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}?saved=1`);
});

// ---------- Student fee ledger (admin-only) ----------
app.get("/students/:classSlug/:id/fees", async (req, res) => {
  const { classSlug, id } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  const students = (await db.get(`students:${classSlug}`)) || [];
  const student = students.find((s) => s.id === id);
  if (!cls || !student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");

  const chronological = (await fees.getLedger(id))
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.createdAt - b.createdAt);
  const balance = fees.computeBalance(chronological);

  res.render("student-fees", {
    classSlug,
    className: cls.name,
    student,
    ledger: chronological.slice().reverse(), // newest first on screen
    balance,
    saved: req.query.saved === "1",
  });
});

app.post("/students/:classSlug/:id/fees/charge", async (req, res) => {
  const { classSlug, id } = req.params;
  const { label, amount, note } = req.body;
  if ((label || "").trim() && Number(amount) > 0) {
    await fees.addOneOffCharge(id, { label: label.trim(), amount, note });
  }
  res.redirect(`/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees?saved=1`);
});

app.post("/students/:classSlug/:id/fees/payment", async (req, res) => {
  const { classSlug, id } = req.params;
  const { amount, method, note } = req.body;
  if (Number(amount) > 0) {
    await fees.addPayment(id, { amount, method, note, classSlug });
    const students = (await db.get(`students:${classSlug}`)) || [];
    const student = students.find((s) => s.id === id);
    if (student) {
      await activity.logActivity(
        "fee_payment",
        `${student.name} এর ফি জমা হয়েছে — ৳${Number(amount).toLocaleString("en-US")}`,
        `/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees`
      );
    }
  }
  res.redirect(`/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees?saved=1`);
});

app.post("/students/:classSlug/:id/fees/discount", async (req, res) => {
  const { classSlug, id } = req.params;
  const { label, amount, note } = req.body;
  if (Number(amount) > 0) {
    await fees.addDiscount(id, { label, amount, note });
    const students = (await db.get(`students:${classSlug}`)) || [];
    const student = students.find((s) => s.id === id);
    if (student) {
      await activity.logActivity(
        "fee_discount",
        `${student.name} কে ছাড়/মওকুফ দেওয়া হয়েছে — ৳${Number(amount).toLocaleString("en-US")}`,
        `/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees`
      );
    }
  }
  res.redirect(`/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees?saved=1`);
});

app.post("/students/:classSlug/:id/fees/entry/:entryId/delete", async (req, res) => {
  const { classSlug, id, entryId } = req.params;
  await fees.deleteEntry(id, entryId);
  res.redirect(`/students/${encodeURIComponent(classSlug)}/${encodeURIComponent(id)}/fees?saved=1`);
});

app.get("/students/:classSlug/:id/fees/receipt/:entryId/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res.status(500).send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const { classSlug, id, entryId } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  const students = (await db.get(`students:${classSlug}`)) || [];
  const student = students.find((s) => s.id === id);
  const ledger = await fees.getLedger(id);
  const payment = ledger.find((e) => e.id === entryId && e.kind === "payment");
  if (!cls || !student || !payment) return res.status(404).send("রশিদ পাওয়া যায়নি");

  // Which charges (মাসিক বেতন, গাড়ি ভাড়া, ...) this specific payment
  // actually covered, oldest-open-charge-first — plus the running due
  // right after it, walked chronologically so an old receipt always shows
  // the due as it was at collection time, unaffected by entries added since.
  const allocation = await fees.getPaymentAllocation(id, entryId);

  const settings = await getSettings();

  // QR code linking to the public verification page — printed in the
  // receipt's top-right corner. Generation failures shouldn't block the
  // receipt itself, so this just falls back to no QR on error.
  let qrDataUrl = null;
  try {
    qrDataUrl = await qrDataUrlFor(publicReceiptVerifyUrl(req, payment.receiptNo));
  } catch (e) {
    console.error("Receipt QR generation error:", e);
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDispositionHeader(`রশিদ-${student.name}-${payment.receiptNo}`, "pdf", "inline"));
  streamFeeReceipt(res, {
    schoolName: settings.schoolName,
    logoDataUrl: settings.logoDataUrl,
    student,
    className: cls.name,
    payment,
    appliedTo: allocation.appliedTo,
    balanceAfter: allocation.balanceAfter,
    qrDataUrl,
  });
});

// ---------- Leaving documents: Transfer Certificate & Character Certificate ----------
// Both are generated on demand from a small GET form on the student's
// profile page (see student-profile.ejs) — leaving date / last result /
// conduct remark only make sense at leaving time, so they aren't stored on
// the student record itself and are just passed as query params here.
// Nothing is persisted; re-generating with different values is always
// fine, and each download still gets its own permanent serial number.
app.get("/students/:classSlug/:id/tc/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res.status(500).send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const { classSlug, id } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  const students = (await db.get(`students:${classSlug}`)) || [];
  const student = students.find((s) => s.id === id);
  if (!cls || !student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");

  const settings = await getSettings();
  const websiteTeachers = (await db.get("teachers")) || [];
  const headTeacher = findRoleTeacher(websiteTeachers, "head") || {};

  const ledger = await fees.getLedger(id);
  const balance = fees.computeBalance(ledger);
  const dueNote = balance.due > 0 ? `${balance.due} টাকা বকেয়া আছে` : "কোনো বকেয়া নেই";

  const tcNo = await generateDocumentNo("tc");
  const issueDate = new Date().toLocaleDateString("bn-BD");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDispositionHeader(`TC-${student.name}`, "pdf", "inline"));
  streamTransferCertificate(res, {
    student,
    className: cls.name,
    schoolName: settings.schoolName,
    logoDataUrl: settings.logoDataUrl,
    headTeacher,
    tcNo,
    issueDate,
    extra: {
      leavingDate: (req.query.leavingDate || "").trim(),
      lastExamResult: (req.query.lastExamResult || "").trim(),
      conductRemark: (req.query.conductRemark || "").trim(),
      dueNote,
    },
  });
});

app.get("/students/:classSlug/:id/character-certificate/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res.status(500).send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const { classSlug, id } = req.params;
  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === classSlug);
  const students = (await db.get(`students:${classSlug}`)) || [];
  const student = students.find((s) => s.id === id);
  if (!cls || !student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");

  const settings = await getSettings();
  const websiteTeachers = (await db.get("teachers")) || [];
  const headTeacher = findRoleTeacher(websiteTeachers, "head") || {};

  const certNo = await generateDocumentNo("character");
  const issueDate = new Date().toLocaleDateString("bn-BD");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDispositionHeader(`চরিত্র-সনদ-${student.name}`, "pdf", "inline"));
  streamCharacterCertificate(res, {
    student,
    className: cls.name,
    schoolName: settings.schoolName,
    logoDataUrl: settings.logoDataUrl,
    headTeacher,
    certNo,
    issueDate,
    extra: {
      leavingDate: (req.query.leavingDate || "").trim(),
      conductRemark: (req.query.conductRemark || "").trim(),
    },
  });
});

// ---------- Online Admission (public form + staff review) ----------
// Every submission is saved permanently under admission:<id> (so the
// applicant can always re-download their filled PDF, and staff keep a
// record even after approving/rejecting). admissions:pending is just the
// queue of ids still awaiting a staff decision.
app.get("/admission", async (req, res) => {
  const settings = await getSettings();
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const submittedId = req.query.success === "1" ? req.query.id : null;
  const submittedApplication = submittedId ? await db.get(`admission:${submittedId}`) : null;
  res.render("admission", { settings, classes, submittedId, submittedAdmissionNo: submittedApplication ? submittedApplication.admissionNo : null });
});

app.post("/admission", async (req, res) => {
  const classes = (await db.get("classlist")) || [];
  const b = req.body;
  const classSlug = (b.classSlug || "").trim();
  const name = (b.name || "").trim();
  const cls = classes.find((c) => c.slug === classSlug);
  if (cls && name) {
    const id = shortId();
    const admissionNo = await generateAdmissionNo();
    const application = {
      id,
      admissionNo,
      classSlug,
      className: cls.name,
      name,
      fatherName: (b.fatherName || "").trim(),
      motherName: (b.motherName || "").trim(),
      dob: (b.dob || "").trim(),
      gender: (b.gender || "").trim(),
      bloodGroup: (b.bloodGroup || "").trim(),
      fatherPhone: (b.fatherPhone || "").trim(),
      motherPhone: (b.motherPhone || "").trim(),
      presentAddress: (b.presentAddress || "").trim(),
      previousSchool: (b.previousSchool || "").trim(),
      reasonForLeaving: (b.reasonForLeaving || "").trim(),
      photoDataUrl: (b.photoDataUrl || "").trim(),
      submittedAt: Date.now(),
      status: "pending",
    };
    await db.set(`admission:${id}`, application);
    const pending = (await db.get("admissions:pending")) || [];
    pending.push(id);
    await db.set("admissions:pending", pending);
    await activity.logActivity(
      "admission_submitted",
      `${name} নতুন ভর্তির আবেদন জমা দিয়েছে — ${cls.name}`,
      `/admissions?q=${encodeURIComponent(admissionNo)}`
    );
    return res.redirect(`/admission?success=1&id=${encodeURIComponent(id)}`);
  }
  res.redirect("/admission");
});

// Public — the applicant downloads their own filled form right after
// submitting (link shown on the success page). No login required, same
// as the public result page: knowing the random application id is what
// gates access, not a session.
app.get("/admission/:id/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res.status(500).send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  const application = await db.get(`admission:${req.params.id}`);
  if (!application) return res.status(404).send("আবেদন পাওয়া যায়নি");
  const settings = await getSettings();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDispositionHeader(`ভর্তি-আবেদন-${application.name}`, "pdf", "inline"));
  streamAdmissionForm(res, { application, schoolName: settings.schoolName, logoDataUrl: settings.logoDataUrl });
});

// ---------- Staff: review admission applications ----------
app.get("/admissions", async (req, res) => {
  const pendingIds = (await db.get("admissions:pending")) || [];
  let pending = (
    await Promise.all(pendingIds.map((id) => db.get(`admission:${id}`)))
  )
    .filter(Boolean)
    .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  const q = (req.query.q || "").trim();
  if (q) {
    const needle = q.toLowerCase();
    pending = pending.filter(
      (a) =>
        (a.admissionNo || "").toLowerCase().includes(needle) ||
        (a.name || "").toLowerCase().includes(needle) ||
        (a.fatherPhone || "").toLowerCase().includes(needle) ||
        (a.motherPhone || "").toLowerCase().includes(needle)
    );
  }

  res.render("admissions", { pending, q });
});

app.post("/admissions/:id/approve", async (req, res) => {
  const application = await db.get(`admission:${req.params.id}`);
  const pendingIds = (await db.get("admissions:pending")) || [];
  if (!application) return res.redirect("/admissions");

  const classes = (await db.get("classlist")) || [];
  const cls = classes.find((c) => c.slug === application.classSlug);
  const classCode = cls ? await ensureClassCode(classes, cls) : "00";

  // The session is chosen here at approval time (not when the application
  // was submitted), since applications can be collected online well in
  // advance and approved only once the relevant session actually starts —
  // e.g. collecting applications in December but approving them for the
  // 2027 session. Defaults to the current year if the admin leaves it
  // blank. This tag lets বার্ষিক ক্লাস প্রমোশন (see lib/promotion.js) tell
  // a student admitted in advance for a future session apart from one who
  // has actually studied a full session in this class — without it, such
  // a student would get swept into a promotion round they never attended.
  const session = (req.body.session || "").trim() || String(new Date().getFullYear());

  const key = `students:${application.classSlug}`;
  const students = (await db.get(key)) || [];
  const newStudent = {
    id: shortId(),
    admissionId: application.id,
    name: application.name,
    roll: "",
    section: "",
    session,
    registration: await generateRegistrationNumber(application.classSlug, classCode),
    fatherName: application.fatherName || "",
    motherName: application.motherName || "",
    dob: application.dob || "",
    gender: application.gender || "",
    bloodGroup: application.bloodGroup || "",
    fatherPhone: application.fatherPhone || "",
    motherPhone: application.motherPhone || "",
    presentAddress: application.presentAddress || "",
    previousSchool: application.previousSchool || "",
    reasonForLeaving: application.reasonForLeaving || "",
    photoDataUrl: application.photoDataUrl || "",
    admissionDate: new Date().toISOString().slice(0, 10),
  };
  students.push(newStudent);
  await db.set(key, students);

  // Auto-bill the admission-time fees (ভর্তি ফি, আইডি কার্ড, রশিদ বই,
  // সেশন ফি ইত্যাদি) right away, if a fee structure has been set up for
  // this class+session — no-op (skipped, added: 0) if none is configured.
  try {
    await fees.chargeAdmissionItems(newStudent.id, application.classSlug, session, newStudent.admissionDate);
  } catch (e) {}

  application.status = "approved";
  await db.set(`admission:${application.id}`, application);
  await db.set("admissions:pending", pendingIds.filter((id) => id !== application.id));
  await activity.logActivity(
    "admission_approved",
    `${application.name} শিক্ষার্থী হিসেবে ভর্তি হয়েছে — ${application.className}`,
    `/students/${encodeURIComponent(application.classSlug)}/${encodeURIComponent(newStudent.id)}`
  );

  // Send staff straight to the new profile to assign a roll number.
  res.redirect(`/students/${encodeURIComponent(application.classSlug)}/${encodeURIComponent(newStudent.id)}`);
});

app.post("/admissions/:id/reject", async (req, res) => {
  const application = await db.get(`admission:${req.params.id}`);
  const pendingIds = (await db.get("admissions:pending")) || [];
  if (application) {
    application.status = "rejected";
    await db.set(`admission:${application.id}`, application);
  }
  await db.set("admissions:pending", pendingIds.filter((id) => id !== req.params.id));
  res.redirect("/admissions");
});

// ---------- Exams ----------
app.get("/exams", async (req, res) => {
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const examlist = (await db.get("examlist")) || [];
  const settings = await getSettings();

  // Group exams that share the same name+session (i.e. the same exam run
  // across multiple classes) so they display together on the list page.
  const groups = [];
  const groupIndex = new Map();
  examlist.forEach((e) => {
    const gKey = `${e.examName}||${e.session || ""}`;
    if (!groupIndex.has(gKey)) {
      groupIndex.set(gKey, groups.length);
      groups.push({ examName: e.examName, session: e.session, entries: [] });
    }
    groups[groupIndex.get(gKey)].entries.push(e);
  });
  // Within each exam group, list classes in grade order (not creation
  // order) — same rule as everywhere else classes are listed.
  groups.forEach((g) => g.entries.sort((a, b) => classRank(a.className) - classRank(b.className)));

  res.render("exams", { classes, examGroups: groups.reverse(), settings });
});

app.post("/exams/create", async (req, res) => {
  const { examName, session } = req.body;
  let classSlugs = req.body.classSlug || [];
  if (!Array.isArray(classSlugs)) classSlugs = [classSlugs];
  classSlugs = classSlugs.filter(Boolean);

  if (classSlugs.length === 0) return res.redirect("/exams");

  const classes = (await db.get("classlist")) || [];
  const settings = await getSettings();
  const examlist = (await db.get("examlist")) || [];

  let firstKey = null;
  for (const classSlug of classSlugs) {
    const cls = classes.find((c) => c.slug === classSlug);
    if (!cls) continue;
    // Same exam name/session/school for every class — a separate exam
    // record per class (since subjects/marks are entered per class), but
    // the admin only types the shared details once.
    const key = `${slugify(cls.name)}-${slugify(examName)}-${slugify(session)}-${shortId()}`;
    const exam = {
      key,
      classSlug,
      className: cls.name,
      examName,
      session,
      schoolName: settings.schoolName || "",
      subjects: [],
      marksByStudent: {},
      createdAt: Date.now(),
    };
    await db.set(`exam:${key}`, exam);
    examlist.push({ key, className: cls.name, examName, session });
    if (!firstKey) firstKey = key;
  }
  await db.set("examlist", examlist);

  // One class selected → jump straight into it, same as before.
  // Multiple classes → back to the list, where they're now grouped together.
  if (classSlugs.length === 1 && firstKey) {
    return res.redirect(`/exams/${firstKey}`);
  }
  res.redirect("/exams");
});

// Subject-wise highest mark, computed on the fly from whatever marks are
// currently entered — never stored separately, so editing/updating any
// student's mark automatically changes the highest the next time this runs.
function computeSubjectHighest(exam, students) {
  const highest = {};
  exam.subjects.forEach((s) => {
    let max = null;
    students.forEach((student) => {
      const marks = exam.marksByStudent[student.id] || {};
      const raw = marks[s.name];
      if (raw === undefined || raw === null || raw === "") return;
      const val = parseFloat(raw);
      if (!isNaN(val) && (max === null || val > max)) max = val;
    });
    highest[s.name] = max;
  });
  return highest;
}

app.get("/exams/:key", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  res.render("exam-detail", { exam, studentCount: students.length });
});

app.post("/exams/:key/delete", async (req, res) => {
  const examlist = ((await db.get("examlist")) || []).filter((e) => e.key !== req.params.key);
  await db.set("examlist", examlist);
  await db.set(`exam:${req.params.key}`, null);
  res.redirect("/exams");
});

// Delete an entire exam group (every class's entry that shares the same
// exam name + session) in one go, instead of deleting each class one by one.
app.post("/exams/group/delete", async (req, res) => {
  const { examName, session } = req.body;
  const examlist = (await db.get("examlist")) || [];
  const toDelete = examlist.filter((e) => e.examName === examName && (e.session || "") === (session || ""));
  const remaining = examlist.filter((e) => !(e.examName === examName && (e.session || "") === (session || "")));
  await db.set("examlist", remaining);
  for (const e of toDelete) {
    await db.set(`exam:${e.key}`, null);
  }
  res.redirect("/exams");
});

// ---- Fix typos after creation: exam name, session, or a one-off school
// name override for this exam (className/class is left alone since results
// are tied to that class's student list). ----
app.get("/exams/:key/edit", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const settings = await getSettings();
  res.render("exam-edit", { exam, settings });
});

app.post("/exams/:key/edit", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");

  const examName = (req.body.examName || "").trim();
  const session = (req.body.session || "").trim();
  const schoolName = (req.body.schoolName || "").trim();

  if (examName) exam.examName = examName;
  exam.session = session;
  if (schoolName) exam.schoolName = schoolName;
  await db.set(`exam:${req.params.key}`, exam);

  // Keep the lightweight examlist summary (used on the exam list page) in sync.
  const examlist = (await db.get("examlist")) || [];
  const entry = examlist.find((e) => e.key === req.params.key);
  if (entry) {
    entry.examName = exam.examName;
    entry.session = exam.session;
    await db.set("examlist", examlist);
  }

  res.redirect(`/exams/${req.params.key}`);
});

app.post("/exams/:key/subjects/add", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const name = (req.body.subjectName || "").trim();
  const fullMarks = clampFullMarks(req.body.fullMarks);
  if (name && !exam.subjects.find((s) => s.name === name)) {
    exam.subjects.push({ name, fullMarks });
    await db.set(`exam:${req.params.key}`, exam);
  }
  res.redirect(`/exams/${req.params.key}`);
});

// ---- Fix a typo in a subject's name/full marks after it's been added.
// If the name changes, migrate any marks already entered under the old
// name so they aren't lost. ----
app.post("/exams/:key/subjects/:index/edit", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.index, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");

  const newName = (req.body.subjectName || "").trim();
  const newFullMarks = clampFullMarks(req.body.fullMarks);
  const duplicate = newName && exam.subjects.some((s, i) => i !== idx && s.name === newName);

  if (newName && !duplicate) {
    const oldName = subject.name;
    subject.name = newName;
    subject.fullMarks = newFullMarks;
    if (oldName !== newName) {
      Object.keys(exam.marksByStudent).forEach((studentId) => {
        const marks = exam.marksByStudent[studentId];
        if (marks && Object.prototype.hasOwnProperty.call(marks, oldName)) {
          marks[newName] = marks[oldName];
          delete marks[oldName];
        }
      });
    }
    await db.set(`exam:${req.params.key}`, exam);
  }
  res.redirect(`/exams/${req.params.key}`);
});

// ---- Remove a subject added by mistake. Also clears any marks already
// entered for it, so no orphaned data is left behind. ----
app.post("/exams/:key/subjects/:index/delete", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.index, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");

  exam.subjects.splice(idx, 1);
  Object.keys(exam.marksByStudent).forEach((studentId) => {
    const marks = exam.marksByStudent[studentId];
    if (marks && Object.prototype.hasOwnProperty.call(marks, subject.name)) {
      delete marks[subject.name];
    }
  });
  await db.set(`exam:${req.params.key}`, exam);
  res.redirect(`/exams/${req.params.key}`);
});

app.get("/exams/:key/marks/:subjectIndex", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  res.render("marks-entry", { exam, subject, subjectIndex: idx, students, importResult: null });
});

app.post("/exams/:key/marks/:subjectIndex", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");

  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const marksInput = req.body.marks || {};
  const invalidEntries = [];
  for (const studentId of Object.keys(marksInput)) {
    const result = parseMarkInput(marksInput[studentId], subject.fullMarks);
    if (result.error) {
      const student = students.find((s) => s.id === studentId);
      invalidEntries.push({ roll: (student && student.roll) || "?", reason: result.error });
      continue; // leave this student's previously saved mark untouched
    }
    if (!exam.marksByStudent[studentId]) exam.marksByStudent[studentId] = {};
    if (result.clear) {
      delete exam.marksByStudent[studentId][subject.name];
    } else {
      exam.marksByStudent[studentId][subject.name] = result.value;
    }
  }
  await db.set(`exam:${req.params.key}`, exam);

  if (invalidEntries.length > 0) {
    return res.render("marks-entry", {
      exam,
      subject,
      subjectIndex: idx,
      students,
      importResult: null,
      manualError: invalidEntries,
    });
  }
  res.redirect(`/exams/${req.params.key}`);
});

// ---------- Bulk marks import (Admin panel) ----------
app.get("/exams/:key/marks/:subjectIndex/template", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const headers = ["রোল", "নাম", marksColumnHeader(subject)];
  const rows = buildMarksTemplateRows(exam, subject, students);
  const buffer = buildWorkbookBuffer(headers, rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDispositionHeader(`নম্বর-টেমপ্লেট-${subject.name}`, "xlsx"));
  res.send(buffer);
});

app.post("/exams/:key/marks/:subjectIndex/import", upload.single("file"), async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const idx = parseInt(req.params.subjectIndex, 10);
  const subject = exam.subjects[idx];
  if (!subject) return res.status(404).send("বিষয় পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];

  const renderWith = (importResult) =>
    res.render("marks-entry", { exam, subject, subjectIndex: idx, students, importResult });

  if (!req.file) {
    return renderWith({ updated: 0, skipped: [], error: "কোনো ফাইল পাওয়া যায়নি।" });
  }
  let rows;
  try {
    rows = parseWorkbookBuffer(req.file.buffer);
  } catch (err) {
    console.error("Marks import parse error:", err);
    return renderWith({ updated: 0, skipped: [], error: "ফাইলটি পড়া যায়নি। .xlsx বা .csv ফাইল দিন।" });
  }

  const { updated, skipped } = applyMarksImport(exam, subject, students, rows);
  await db.set(`exam:${req.params.key}`, exam);
  renderWith({ updated, skipped, error: null });
});

// ---- Edit one student's marks across ALL subjects (for fixing a single mistake) ----
app.get("/exams/:key/student/:studentId/edit-marks", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const student = students.find((s) => s.id === req.params.studentId);
  if (!student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");
  const marks = exam.marksByStudent[student.id] || {};
  res.render("student-edit-marks", { exam, student, marks });
});

app.post("/exams/:key/student/:studentId/edit-marks", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const student = students.find((s) => s.id === req.params.studentId);
  if (!student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");

  const marksInput = req.body.marks || {};
  if (!exam.marksByStudent[student.id]) exam.marksByStudent[student.id] = {};
  const invalidEntries = [];
  exam.subjects.forEach((s) => {
    const result = parseMarkInput(marksInput[s.name], s.fullMarks);
    if (result.error) {
      invalidEntries.push({ subjectName: s.name, reason: result.error });
      return; // leave this subject's previously saved mark untouched
    }
    if (result.clear) {
      delete exam.marksByStudent[student.id][s.name];
    } else {
      exam.marksByStudent[student.id][s.name] = result.value;
    }
  });
  await db.set(`exam:${req.params.key}`, exam);

  if (invalidEntries.length > 0) {
    const marks = exam.marksByStudent[student.id] || {};
    return res.render("student-edit-marks", { exam, student, marks, manualError: invalidEntries });
  }
  res.redirect(`/exams/${req.params.key}/results`);
});

// Computes each student's totals AND their class position (merit rank).
// Ranking only considers students whose marks are fully entered (allEntered),
// since ranking someone against an incomplete result would be misleading.
// Standard competition ranking is used (equal totals share the same rank,
// e.g. 1, 2, 2, 4 — the next distinct score skips ahead accordingly).
// computeResultsRows moved to lib/results.js (shared with the promotion tool)

// Matches a student by roll OR registration number for the public result
// lookup. Case-insensitive, trims whitespace, and also compares numerically
// so "5" matches a stored roll of "05". Returns null on no match — callers
// must never reveal *why* a lookup failed (wrong exam vs wrong number), to
// avoid leaking which numbers are valid.
// Bengali digits (০-৯) must match their English equivalents (0-9) and
// vice versa — a roll saved as "৯" should still be found by someone typing
// "9", and a roll saved as "9" should still be found by someone typing "৯".
const BN_TO_EN_DIGITS = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
function normalizeDigits(s) {
  return String(s || "").replace(/[০-৯]/g, (d) => BN_TO_EN_DIGITS[d]);
}

function findStudentByCode(students, code) {
  const c = normalizeDigits(String(code || "").trim().toLowerCase());
  if (!c) return null;
  const cNum = /^\d+$/.test(c) ? parseInt(c, 10) : null;
  const matchesField = (val) => {
    const v = normalizeDigits(String(val || "").trim().toLowerCase());
    if (!v) return false;
    if (v === c) return true;
    if (cNum !== null && /^\d+$/.test(v) && parseInt(v, 10) === cNum) return true;
    return false;
  };
  return students.find((s) => matchesField(s.roll) || matchesField(s.registration)) || null;
}

// ---------- Public Receipt Verification Page (no login required) ----------
// Reached by scanning the QR printed on a payment receipt — confirms the
// receipt number is genuine and shows the same core details that were on
// the paper, without exposing the student's full fee ledger or anything
// not already printed on the receipt itself.
app.get("/verify/receipt/:receiptNo", async (req, res) => {
  const receiptNo = (req.params.receiptNo || "").trim();
  const settings = await getSettings();
  let result = null;

  const idx = await fees.findReceiptIndex(receiptNo);
  if (idx) {
    const classes = (await db.get("classlist")) || [];
    const cls = classes.find((c) => c.slug === idx.classSlug);
    const students = (await db.get(`students:${idx.classSlug}`)) || [];
    const student = students.find((s) => s.id === idx.studentId);
    if (cls && student) {
      const ledger = await fees.getLedger(idx.studentId);
      const payment = ledger.find((e) => e.id === idx.entryId && e.kind === "payment");
      if (payment) {
        result = {
          receiptNo: payment.receiptNo,
          amount: payment.amount,
          date: payment.date,
          method: payment.method,
          studentName: student.name,
          className: cls.name,
          rollOrReg: student.roll || student.registration || "-",
        };
      }
    }
  }

  res.render("verify-receipt", { settings, receiptNo, result });
});


// Access to any individual result is gated by requiring the correct
// roll/registration number rather than by login — see lib/auth.js.
app.get("/result", async (req, res) => {
  const examlist = ((await db.get("examlist")) || [])
    .slice()
    .sort((a, b) => classRank(a.className) - classRank(b.className));
  const settings = await getSettings();
  const examKey = (req.query.exam || "").trim();
  const code = (req.query.code || "").trim();
  let error = null;
  let data = null;

  if (examKey && code) {
    const exam = await db.get(`exam:${examKey}`);
    if (!exam) {
      error = "পরীক্ষা খুঁজে পাওয়া যায়নি। আবার চেষ্টা করুন।";
    } else {
      const students = (await db.get(`students:${exam.classSlug}`)) || [];
      const student = findStudentByCode(students, code);
      if (!student) {
        error = "সঠিক রোল অথবা রেজিস্ট্রেশন নম্বর দেওয়া হয়নি। আবার চেষ্টা করুন।";
      } else {
        const rows = computeResultsRows(exam, students);
        const resultRow = rows.find((r) => r.student.id === student.id);
        const subjectHighest = computeSubjectHighest(exam, students);
        const marks = exam.marksByStudent[student.id] || {};
        const subjectRows = exam.subjects.map((s) => {
          const raw = marks[s.name];
          const entered = raw !== undefined && raw !== null && raw !== "";
          const full = parseFloat(s.fullMarks) || 100;
          const highest = subjectHighest[s.name];
          if (!entered) return { name: s.name, full, obtained: null, highest, grade: "—" };
          const obtained = parseFloat(raw) || 0;
          const { grade } = getGrade(full ? (obtained / full) * 100 : 0);
          return { name: s.name, full, obtained, highest, grade };
        });
        data = { exam, student, resultRow, subjectRows };
      }
    }
  }

  res.render("public-result", { examlist, examKey, code, error, data, settings });
});

app.get("/result/pdf", async (req, res) => {
  const examKey = (req.query.exam || "").trim();
  const code = (req.query.code || "").trim();
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  try {
    const exam = await db.get(`exam:${examKey}`);
    if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
    const students = (await db.get(`students:${exam.classSlug}`)) || [];
    const student = findStudentByCode(students, code);
    if (!student) return res.status(403).send("সঠিক রোল/রেজিস্ট্রেশন নম্বর ছাড়া রেজাল্ট দেখা যাবে না।");

    const marks = exam.marksByStudent[student.id] || {};
    const resultRow = computeResultsRows(exam, students).find((r) => r.student.id === student.id);
    const subjectHighest = computeSubjectHighest(exam, students);
    const settings = await getSettings();
    const qrDataUrl = await qrForStudent(req, examKey, student);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDispositionHeader(`progress-card-${student.name}`, "pdf"));
    streamProgressCard(res, {
      student,
      exam,
      marks,
      position: resultRow && resultRow.position,
      totalStudents: resultRow && resultRow.totalRanked,
      subjectHighest,
      logoDataUrl: settings.logoDataUrl,
      qrDataUrl,
    });
  } catch (err) {
    console.error("Public result PDF generation error:", err);
    if (!res.headersSent) {
      res.status(500).send("PDF তৈরি করতে সমস্যা হয়েছে। সম্ভবত ফন্ট ফাইলে সমস্যা আছে — সার্ভার লগ চেক করুন।");
    } else {
      res.end();
    }
  }
});

app.get("/exams/:key/results", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const rows = computeResultsRows(exam, students);
  res.render("results", { exam, rows });
});

app.get("/exams/:key/student/:studentId/pdf", async (req, res) => {
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  try {
    const exam = await db.get(`exam:${req.params.key}`);
    if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
    const students = (await db.get(`students:${exam.classSlug}`)) || [];
    const student = students.find((s) => s.id === req.params.studentId);
    if (!student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");
    const marks = exam.marksByStudent[student.id] || {};
    const resultRow = computeResultsRows(exam, students).find((r) => r.student.id === student.id);
    const subjectHighest = computeSubjectHighest(exam, students);
    const settings = await getSettings();
    const qrDataUrl = await qrForStudent(req, req.params.key, student);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      contentDispositionHeader(`progress-card-${student.name}`, "pdf", req.query.inline ? "inline" : "attachment")
    );
    streamProgressCard(res, {
      student,
      exam,
      marks,
      position: resultRow && resultRow.position,
      totalStudents: resultRow && resultRow.totalRanked,
      subjectHighest,
      logoDataUrl: settings.logoDataUrl,
      qrDataUrl,
    });
  } catch (err) {
    console.error("PDF generation error:", err);
    if (!res.headersSent) {
      res.status(500).send("PDF তৈরি করতে সমস্যা হয়েছে। সম্ভবত ফন্ট ফাইলে সমস্যা আছে — সার্ভার লগ চেক করুন।");
    } else {
      res.end();
    }
  }
});

// Renders a PDF's pages onto <canvas> elements with pdf.js and then calls
// window.print() on the page itself — so a single click goes straight to
// the browser's print dialog. Used both for printing one student's card
// and for printing every student's card at once (a multi-page PDF works
// exactly the same way here — it just loops over more pages).
//
// We deliberately don't embed the PDF in an <iframe>: desktop Chrome can
// display a PDF inline in an iframe, but mobile Chrome cannot — it just
// downloads the file instead, so an iframe-based approach silently fails
// to print on phones. Drawing the pages ourselves works the same way on
// desktop and mobile.
function printPageHtml({ title, pdfUrl }) {
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #525659; font-family: sans-serif; }
  #status { text-align: center; padding: 60px 20px; color: #fff; font-size: 15px; }
  #status a { color: #93c5fd; }
  #manualPrint {
    display: none;
    position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
    background: #2563eb; color: #fff; border: none; border-radius: 999px;
    padding: 14px 28px; font-size: 15px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.3);
  }
  #pages canvas { display: block; margin: 16px auto; max-width: 100%; height: auto; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  @media print {
    html, body { background: #fff; }
    #status, #manualPrint { display: none !important; }
    #pages canvas { margin: 0; box-shadow: none; width: 100% !important; height: auto !important; page-break-after: always; }
    #pages canvas:last-child { page-break-after: auto; }
  }
</style>
</head>
<body>
  <div id="status">PDF লোড হচ্ছে...</div>
  <div id="pages"></div>
  <button id="manualPrint" onclick="window.print()">🖨️ প্রিন্ট করুন</button>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    const pdfUrl = ${JSON.stringify(pdfUrl)};
    const statusEl = document.getElementById('status');
    const manualBtn = document.getElementById('manualPrint');

    async function run() {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
      const container = document.getElementById('pages');
      for (let i = 1; i <= pdf.numPages; i++) {
        statusEl.textContent = 'PDF লোড হচ্ছে... (' + i + '/' + pdf.numPages + ')';
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        container.appendChild(canvas);
      }
      statusEl.style.display = 'none';
      manualBtn.style.display = 'block';
      setTimeout(() => window.print(), 200);
    }

    run().catch(() => {
      statusEl.innerHTML =
        'PDF প্রিভিউ লোড করা যায়নি। <a href="' + pdfUrl + '" target="_blank">এখানে ট্যাপ করে PDF খুলুন</a>';
    });
  </script>
</body>
</html>`;
}

app.get("/exams/:key/student/:studentId/print", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  const student = students.find((s) => s.id === req.params.studentId);
  if (!student) return res.status(404).send("শিক্ষার্থী পাওয়া যায়নি");

  const pdfUrl = `/exams/${req.params.key}/student/${req.params.studentId}/pdf?inline=1`;
  res.send(printPageHtml({ title: `প্রিন্ট — ${student.name}`, pdfUrl }));
});

// One combined PDF with every student's card, one page each (in roll
// order), so it can be downloaded or previewed as a single file.
app.get("/exams/:key/pdf-combined", async (req, res) => {
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  try {
    const exam = await db.get(`exam:${req.params.key}`);
    if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
    const students = (await db.get(`students:${exam.classSlug}`)) || [];
    if (students.length === 0) return res.status(404).send("এই ক্লাসে কোনো শিক্ষার্থী নেই");
    const resultRows = computeResultsRows(exam, students);
    const subjectHighest = computeSubjectHighest(exam, students);
    const settings = await getSettings();

    // Roll order, not storage order — matches how the printed stack is
    // normally expected to come out (same order as the class register).
    const ordered = [...students].sort((a, b) => {
      const an = parseFloat(a.roll),
        bn = parseFloat(b.roll);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return String(a.roll).localeCompare(String(b.roll));
    });

    // cardOptsFor below runs synchronously per page, but QR generation is
    // async — so generate every student's QR code up front and hand out
    // pre-computed data URLs by student id.
    const qrByStudentId = {};
    for (const student of ordered) {
      qrByStudentId[student.id] = await qrForStudent(req, req.params.key, student);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      contentDispositionHeader(`progress-cards-${exam.className}`, "pdf", req.query.inline ? "inline" : "attachment")
    );

    streamAllProgressCards(res, {
      students: ordered,
      cardOptsFor: (student) => {
        const resultRow = resultRows.find((r) => r.student.id === student.id);
        return {
          exam,
          marks: exam.marksByStudent[student.id] || {},
          position: resultRow && resultRow.position,
          totalStudents: resultRow && resultRow.totalRanked,
          subjectHighest,
          logoDataUrl: settings.logoDataUrl,
          qrDataUrl: qrByStudentId[student.id],
        };
      },
    });
  } catch (err) {
    console.error("Combined PDF generation error:", err);
    if (!res.headersSent) {
      res.status(500).send("PDF তৈরি করতে সমস্যা হয়েছে। সম্ভবত ফন্ট ফাইলে সমস্যা আছে — সার্ভার লগ চেক করুন।");
    } else {
      res.end();
    }
  }
});

// One tap → renders every student's card and opens the print dialog for
// the whole stack at once, the same way the single-student print does.
app.get("/exams/:key/print-all", async (req, res) => {
  const exam = await db.get(`exam:${req.params.key}`);
  if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
  const students = (await db.get(`students:${exam.classSlug}`)) || [];
  if (students.length === 0) return res.status(404).send("এই ক্লাসে কোনো শিক্ষার্থী নেই");

  const pdfUrl = `/exams/${req.params.key}/pdf-combined?inline=1`;
  res.send(printPageHtml({ title: `সবার প্রিন্ট — ${exam.className}`, pdfUrl }));
});

app.get("/exams/:key/pdf-all", async (req, res) => {
  if (!fontsAvailable()) {
    return res
      .status(500)
      .send("বাংলা ফন্ট ফাইল খুঁজে পাওয়া যাচ্ছে না বা করাপ্ট — সার্ভারে fonts ফোল্ডার চেক করুন।");
  }
  try {
    const exam = await db.get(`exam:${req.params.key}`);
    if (!exam) return res.status(404).send("পরীক্ষা পাওয়া যায়নি");
    const students = (await db.get(`students:${exam.classSlug}`)) || [];
    const resultRows = computeResultsRows(exam, students);
    const subjectHighest = computeSubjectHighest(exam, students);
    const settings = await getSettings();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", contentDispositionHeader(`progress-cards-${exam.className}`, "zip"));

    const archive = archiver("zip");
    archive.pipe(res);

    for (const student of students) {
      const marks = exam.marksByStudent[student.id] || {};
      const resultRow = resultRows.find((r) => r.student.id === student.id);
      const qrDataUrl = await qrForStudent(req, req.params.key, student);
      const { PassThrough } = require("stream");
      const buffers = [];
      const passthrough = new PassThrough();
      passthrough.on("data", (chunk) => buffers.push(chunk));
      await new Promise((resolve, reject) => {
        passthrough.on("end", resolve);
        passthrough.on("error", reject);
        try {
          streamProgressCard(passthrough, {
            student,
            exam,
            marks,
            position: resultRow && resultRow.position,
            totalStudents: resultRow && resultRow.totalRanked,
            subjectHighest,
            logoDataUrl: settings.logoDataUrl,
            qrDataUrl,
          });
        } catch (e) {
          reject(e);
        }
      });
      archive.append(Buffer.concat(buffers), { name: `${student.name.replace(/\s+/g, "_")}.pdf` });
    }

    archive.finalize();
  } catch (err) {
    console.error("Bulk PDF (ZIP) generation error:", err);
    if (!res.headersSent) {
      res.status(500).send("PDF তৈরি করতে সমস্যা হয়েছে। সম্ভবত ফন্ট ফাইলে সমস্যা আছে — সার্ভার লগ চেক করুন।");
    } else {
      res.end();
    }
  }
});

// ==========================================================================
// ---------- Attendance (Student + Teacher) ----------
// New, additive module. Reuses existing classlist / students:<slug> /
// teacheraccounts data — adds no fields to those, only new db keys of its
// own (see lib/attendance.js). Admin-only routes here rely on the global
// auth.requireAuth already installed above (a teacher session is redirected
// away from anything outside /teacher/* before it ever reaches these), so
// no extra admin check is needed route-by-route. Teacher routes each use
// requireTeacher plus an explicit ownership check against that teacher's
// Class Teacher assignment — a teacher must never be able to read or write
// another class's attendance by guessing/editing the URL.
// ==========================================================================

const SHIFT_LABELS = { morning: "মর্নিং শিফট", day: "ডে শিফট" };

function classNameFor(classes, slug) {
  const cls = classes.find((c) => c.slug === slug);
  return cls ? cls.name : slug;
}

// ---------- Setup: Academic Sessions + Class↔Shift + Class Teacher ----------
async function renderAttendanceSetup(req, res, session, error) {
  const currentSession = await attendance.getCurrentSession();
  const selectedSession = session || currentSession;
  await attendance.ensureSessionExists(selectedSession);

  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const teacherAccounts = await getTeacherAccounts();
  const shifts = await attendance.getSessionShifts(selectedSession);
  const classTeachers = await attendance.getClassTeachers(selectedSession);
  const sessions = await attendance.getAcademicSessions();

  res.render("admin-attendance-setup", {
    sessions,
    currentSession,
    selectedSession,
    classes,
    teacherAccounts,
    shifts,
    classTeachers,
    SHIFT_LABELS,
    error: error || null,
    saved: req.query.saved === "1",
  });
}

app.get("/admin/attendance/setup", async (req, res) => {
  await renderAttendanceSetup(req, res, req.query.session, null);
});

app.post("/admin/attendance/setup/session/add", async (req, res) => {
  const newSession = (req.body.newSession || "").trim();
  if (!newSession) return renderAttendanceSetup(req, res, req.body.session, "নতুন সেশনের নাম/বছর দিন।");
  await attendance.addAcademicSession(newSession);
  res.redirect(`/admin/attendance/setup?session=${encodeURIComponent(newSession)}`);
});

app.post("/admin/attendance/setup/session/set-current", async (req, res) => {
  const session = (req.body.session || "").trim();
  if (session) await attendance.setCurrentSession(session);
  res.redirect(`/admin/attendance/setup?session=${encodeURIComponent(session)}`);
});

app.post("/admin/attendance/setup/shift", async (req, res) => {
  const { session, classSlug, shift } = req.body;
  if (!classSlug || (shift !== "morning" && shift !== "day")) {
    return renderAttendanceSetup(req, res, session, "ক্লাস ও শিফট বেছে নিন।");
  }
  await attendance.setClassShift(session, classSlug, shift);
  res.redirect(`/admin/attendance/setup?session=${encodeURIComponent(session)}&saved=1`);
});

app.post("/admin/attendance/setup/class-teacher", async (req, res) => {
  const { session, shift, classSlug, teacherAccountId } = req.body;
  if (!session || !shift || !classSlug || !teacherAccountId) {
    return renderAttendanceSetup(req, res, session, "সেশন, শিফট, ক্লাস ও শিক্ষক — সব বেছে নিন।");
  }
  const shiftMap = await attendance.getSessionShifts(session);
  if (shiftMap[classSlug] !== shift) {
    return renderAttendanceSetup(req, res, session, "এই ক্লাসটি এই শিফটে চলে না — আগে উপরে শিফট ঠিক করুন।");
  }
  const classes = (await db.get("classlist")) || [];
  const teacherAccounts = await getTeacherAccounts();
  const teacherAccount = teacherAccounts.find((t) => t.id === teacherAccountId);
  if (!teacherAccount) {
    return renderAttendanceSetup(req, res, session, "শিক্ষক পাওয়া যায়নি।");
  }
  const existingList = await attendance.getClassTeachers(session);
  const conflict = attendance.teacherAlreadyHasShift(existingList, teacherAccountId, shift, classSlug);
  if (conflict) {
    return renderAttendanceSetup(
      req,
      res,
      session,
      `${teacherAccount.name} ইতিমধ্যে ${SHIFT_LABELS[shift]}-এ "${conflict.className}"-এর ক্লাস টিচার — একজন শিক্ষক একই শিফটে দুইটি ক্লাসের দায়িত্বে থাকতে পারবেন না। আগে সেই এসাইনমেন্ট সরান।`
    );
  }
  await attendance.assignClassTeacher(session, {
    shift,
    classSlug,
    className: classNameFor(classes, classSlug),
    teacherAccountId,
    teacherName: teacherAccount.name,
  });
  res.redirect(`/admin/attendance/setup?session=${encodeURIComponent(session)}&saved=1`);
});

app.post("/admin/attendance/setup/class-teacher/remove", async (req, res) => {
  const { session, shift, classSlug } = req.body;
  if (session && shift && classSlug) await attendance.removeClassTeacher(session, shift, classSlug);
  res.redirect(`/admin/attendance/setup?session=${encodeURIComponent(session)}`);
});

// ---------- Student attendance: take / edit (admin — any class/shift) ----------
app.get("/admin/attendance/student", async (req, res) => {
  const currentSession = await attendance.getCurrentSession();
  const session = req.query.session || currentSession;
  const classes = sortClassesForDisplay((await db.get("classlist")) || []);
  const shiftMap = await attendance.getSessionShifts(session);
  const shift = req.query.shift === "morning" || req.query.shift === "day" ? req.query.shift : "";
  const classesInShift = shift ? classes.filter((c) => shiftMap[c.slug] === shift) : [];
  const classSlug = req.query.classSlug || "";
  const date = req.query.date || attendance.todayStr();

  let cls = null, students = [], existing = null;
  if (shift && classSlug) {
    cls = classesInShift.find((c) => c.slug === classSlug) || null;
    if (cls) {
      const roster = (await db.get(`students:${classSlug}`)) || [];
      students = attendance.activeRosterFor(roster, session).sort((a, b) => (a.roll || "").localeCompare(b.roll || "", "bn", { numeric: true }));
      existing = await attendance.getStudentAttendance(session, shift, classSlug, date);
    }
  }

  res.render("attendance-student-take", {
    restricted: false,
    sessions: await attendance.getAcademicSessions(),
    session,
    shift,
    classSlug,
    classes,
    classesInShift,
    cls,
    date,
    students,
    existing,
    saveUrl: "/admin/attendance/student/save",
    backUrl: "/panel",
    SHIFT_LABELS,
    saved: req.query.saved === "1",
    error: null,
    isHoliday: attendance.isWeeklyHoliday(date),
  });
});

app.post("/admin/attendance/student/save", async (req, res) => {
  const { session, shift, classSlug, date } = req.body;
  const classes = (await db.get("classlist")) || [];
  const shiftMap = await attendance.getSessionShifts(session);
  if (!session || !shift || !classSlug || !date || shiftMap[classSlug] !== shift) {
    return res.redirect("/admin/attendance/student");
  }
  const roster = (await db.get(`students:${classSlug}`)) || [];
  const students = attendance.activeRosterFor(roster, session);
  const records = {};
  students.forEach((s) => {
    const v = req.body[`status_${s.id}`];
    if (v === "present" || v === "absent" || v === "leave") records[s.id] = v;
  });
  // Only log the first time this class+date's attendance is taken — a
  // teacher/admin re-opening the same day to fix one student's status
  // (or a slow connection triggering a double-submit) shouldn't spam a
  // second "উপস্থিতি নেওয়া হয়েছে" notification for the same day.
  const alreadyTaken = await attendance.getStudentAttendance(session, shift, classSlug, date);
  await attendance.saveStudentAttendance(
    session,
    shift,
    classSlug,
    classNameFor(classes, classSlug),
    date,
    records,
    { type: "admin", id: "admin", name: "Admin" }
  );
  if (!alreadyTaken) {
    await activity.logActivity(
      "attendance",
      `${classNameFor(classes, classSlug)} এর উপস্থিতি নেওয়া হয়েছে (${date})`,
      `/admin/attendance/student?session=${encodeURIComponent(session)}&shift=${encodeURIComponent(shift)}&classSlug=${encodeURIComponent(classSlug)}&date=${encodeURIComponent(date)}`
    );
  }
  res.redirect(
    `/admin/attendance/student?session=${encodeURIComponent(session)}&shift=${shift}&classSlug=${encodeURIComponent(classSlug)}&date=${date}&saved=1`
  );
});

// ---------- Teacher attendance (self check-in + admin management) ----------
app.get("/admin/attendance/teacher", async (req, res) => {
  const session = req.query.session || (await attendance.getCurrentSession());
  const date = req.query.date || attendance.todayStr();
  const teacherAccounts = await getTeacherAccounts();
  const map = await attendance.getTeacherAttendanceForDate(session, date);
  res.render("admin-attendance-teacher", {
    session,
    date,
    teacherAccounts,
    map,
    saved: req.query.saved === "1",
    isHoliday: attendance.isWeeklyHoliday(date),
  });
});

app.post("/admin/attendance/teacher/save", async (req, res) => {
  const { session, date } = req.body;
  const teacherAccounts = await getTeacherAccounts();
  // Only touch a teacher's entry when the submitted status is actually
  // different from what's already stored — the form always resubmits
  // every dropdown's current value (including ones already set by a
  // teacher's own self check-in), so writing unconditionally here would
  // silently relabel untouched "self" check-ins as "admin" every time
  // the admin saves this page for a completely different teacher.
  const existingMap = await attendance.getTeacherAttendanceForDate(session, date);
  for (const t of teacherAccounts) {
    const status = req.body[`status_${t.id}`];
    if (status !== "present" && status !== "absent" && status !== "leave") continue;
    const existingStatus = existingMap[t.id] && existingMap[t.id].status;
    if (existingStatus === status) continue;
    await attendance.setTeacherAttendanceStatus(session, date, t.id, t.name, status);
  }
  res.redirect(`/admin/attendance/teacher?session=${encodeURIComponent(session)}&date=${date}&saved=1`);
});

// ---------- Reports: Student ----------
async function renderStudentReport(req, res, opts) {
  const { restricted, fixedSession, fixedShift, fixedClassSlug, fixedClassName } = opts;
  const session = restricted ? fixedSession : req.query.session || (await attendance.getCurrentSession());
  const classes = (await db.get("classlist")) || [];
  const shiftMap = await attendance.getSessionShifts(session);
  const shift = restricted ? fixedShift : (req.query.shift === "morning" || req.query.shift === "day" ? req.query.shift : "");
  const classesInShift = shift ? classes.filter((c) => shiftMap[c.slug] === shift) : [];
  const classSlug = restricted ? fixedClassSlug : req.query.classSlug || "";
  const mode = req.query.mode === "daily" ? "daily" : "monthly";
  const date = req.query.date || attendance.todayStr();
  const month = req.query.month || attendance.currentYearMonth();

  let students = [], dailyRecord = null, monthly = null, className = fixedClassName || "";
  if (classSlug) {
    className = classNameFor(classes, classSlug);
    const roster = (await db.get(`students:${classSlug}`)) || [];
    students = attendance.activeRosterFor(roster, session).sort((a, b) => (a.roll || "").localeCompare(b.roll || "", "bn", { numeric: true }));
    if (mode === "daily") {
      dailyRecord = await attendance.getStudentAttendance(session, shift, classSlug, date);
    } else {
      monthly = await attendance.computeStudentMonthlyReport(session, shift, classSlug, students, month);
    }
  }

  res.render("attendance-report-student", {
    restricted: Boolean(restricted),
    sessions: await attendance.getAcademicSessions(),
    session,
    shift,
    classSlug,
    className,
    classes,
    classesInShift,
    mode,
    date,
    month,
    students,
    dailyRecord,
    monthly,
    SHIFT_LABELS,
    baseUrl: restricted ? "/teacher/attendance/report" : "/admin/attendance/reports/student",
  });
}

app.get("/admin/attendance/reports/student", async (req, res) => {
  await renderStudentReport(req, res, { restricted: false });
});

// ---------- Reports: Teacher (admin only) ----------
app.get("/admin/attendance/reports/teacher", async (req, res) => {
  const session = req.query.session || (await attendance.getCurrentSession());
  const mode = req.query.mode === "daily" ? "daily" : "monthly";
  const date = req.query.date || attendance.todayStr();
  const month = req.query.month || attendance.currentYearMonth();
  const teacherAccounts = await getTeacherAccounts();

  let dailyMap = null, monthly = null;
  if (mode === "daily") {
    dailyMap = await attendance.getTeacherAttendanceForDate(session, date);
  } else {
    monthly = await attendance.computeTeacherMonthlyReport(session, teacherAccounts, month);
  }

  res.render("attendance-report-teacher", {
    sessions: await attendance.getAcademicSessions(),
    session,
    mode,
    date,
    month,
    teacherAccounts,
    dailyMap,
    monthly,
  });
});

// ---------- Teacher panel: my assigned class(es) ----------
app.get("/teacher/attendance", requireTeacher, async (req, res) => {
  const session = await attendance.getCurrentSession();
  const assignments = await attendance.findTeacherAssignments(session, req.teacher.id);
  res.render("teacher-attendance", {
    teacher: req.teacher,
    session,
    assignments,
    SHIFT_LABELS,
    today: attendance.todayStr(),
  });
});

// Resolves + verifies (session, shift) -> this teacher's own assignment.
// Every teacher-facing attendance route below calls this first — never
// trusts classSlug/className from the request, only from the assignment
// record itself, so a teacher can't take attendance for a class that
// isn't theirs by editing the URL/form.
async function requireOwnAssignment(req, res, shift) {
  const session = await attendance.getCurrentSession();
  if (shift !== "morning" && shift !== "day") return null;
  const assignments = await attendance.findTeacherAssignments(session, req.teacher.id);
  const own = assignments.find((a) => a.shift === shift);
  if (!own) return null;
  return { session, own };
}

app.get("/teacher/attendance/mark", requireTeacher, async (req, res) => {
  const shift = req.query.shift;
  const ctx = await requireOwnAssignment(req, res, shift);
  if (!ctx) return res.redirect("/teacher/attendance");
  const { session, own } = ctx;
  const date = req.query.date || attendance.todayStr();
  const roster = (await db.get(`students:${own.classSlug}`)) || [];
  const students = attendance.activeRosterFor(roster, session).sort((a, b) => (a.roll || "").localeCompare(b.roll || "", "bn", { numeric: true }));
  const existing = await attendance.getStudentAttendance(session, shift, own.classSlug, date);

  res.render("attendance-student-take", {
    restricted: true,
    sessions: [session],
    session,
    shift,
    classSlug: own.classSlug,
    classes: [{ slug: own.classSlug, name: own.className }],
    classesInShift: [{ slug: own.classSlug, name: own.className }],
    cls: { slug: own.classSlug, name: own.className },
    date,
    students,
    existing,
    saveUrl: "/teacher/attendance/mark/save",
    backUrl: "/teacher/attendance",
    SHIFT_LABELS,
    saved: req.query.saved === "1",
    error: null,
    isHoliday: attendance.isWeeklyHoliday(date),
  });
});

app.post("/teacher/attendance/mark/save", requireTeacher, async (req, res) => {
  const { shift, date } = req.body;
  const ctx = await requireOwnAssignment(req, res, shift);
  if (!ctx) return res.redirect("/teacher/attendance");
  const { session, own } = ctx;
  if (!date) return res.redirect("/teacher/attendance");

  const roster = (await db.get(`students:${own.classSlug}`)) || [];
  const students = attendance.activeRosterFor(roster, session);
  const records = {};
  students.forEach((s) => {
    const v = req.body[`status_${s.id}`];
    if (v === "present" || v === "absent" || v === "leave") records[s.id] = v;
  });
  // Same de-dup as the admin save route above — don't re-notify every
  // time the teacher revisits and re-saves the same day.
  const alreadyTaken = await attendance.getStudentAttendance(session, shift, own.classSlug, date);
  await attendance.saveStudentAttendance(session, shift, own.classSlug, own.className, date, records, {
    type: "teacher",
    id: req.teacher.id,
    name: req.teacher.name,
  });
  if (!alreadyTaken) {
    await activity.logActivity(
      "attendance",
      `শিক্ষক ${req.teacher.name} উপস্থিতি দিয়েছেন — ${own.className}`,
      `/admin/attendance/student?session=${encodeURIComponent(session)}&shift=${encodeURIComponent(shift)}&classSlug=${encodeURIComponent(own.classSlug)}&date=${encodeURIComponent(date)}`
    );
  }
  res.redirect(`/teacher/attendance/mark?shift=${shift}&date=${date}&saved=1`);
});

app.get("/teacher/attendance/report", requireTeacher, async (req, res) => {
  const shift = req.query.shift;
  const ctx = await requireOwnAssignment(req, res, shift);
  if (!ctx) return res.redirect("/teacher/attendance");
  const { session, own } = ctx;
  await renderStudentReport(req, res, {
    restricted: true,
    fixedSession: session,
    fixedShift: shift,
    fixedClassSlug: own.classSlug,
    fixedClassName: own.className,
  });
});

// ---------- Teacher self check-in ----------
app.get("/teacher/attendance/self", requireTeacher, async (req, res) => {
  const session = await attendance.getCurrentSession();
  const today = attendance.todayStr();
  const todayMap = await attendance.getTeacherAttendanceForDate(session, today);
  const todayEntry = todayMap[req.teacher.id] || null;
  const monthly = await attendance.computeTeacherMonthlyReport(session, [{ id: req.teacher.id, name: req.teacher.name }], attendance.currentYearMonth());
  res.render("teacher-attendance-self", {
    teacher: req.teacher,
    today,
    todayEntry,
    myMonthly: monthly.rows[0] || { present: 0, absent: 0, leave: 0, total: 0, percentage: null },
    checked: req.query.checked || null,
    isHoliday: attendance.isWeeklyHoliday(today),
  });
});

app.post("/teacher/attendance/self/checkin", requireTeacher, async (req, res) => {
  const session = await attendance.getCurrentSession();
  const today = attendance.todayStr();
  await attendance.teacherCheckIn(session, today, req.teacher.id, req.teacher.name);
  res.redirect("/teacher/attendance/self?checked=1");
});

app.post("/teacher/attendance/self/checkout", requireTeacher, async (req, res) => {
  const session = await attendance.getCurrentSession();
  const today = attendance.todayStr();
  await attendance.teacherCheckOut(session, today, req.teacher.id, req.teacher.name);
  res.redirect("/teacher/attendance/self?checked=2");
});

// ==========================================================================

const fs = require("fs");
const FONT_CHECK_FILES = [
  path.join(__dirname, "fonts", "HindSiliguri-Regular.ttf"),
  path.join(__dirname, "fonts", "HindSiliguri-Bold.ttf"),
];
FONT_CHECK_FILES.forEach((f) => {
  if (!fs.existsSync(f)) {
    console.error(`[startup] MISSING FONT FILE: ${f} — PDF generation will fail.`);
  } else {
    const size = fs.statSync(f).size;
    if (size < 50 * 1024) {
      console.error(`[startup] FONT FILE TOO SMALL (${size} bytes): ${f} — likely corrupted, PDF generation will fail.`);
    } else {
      console.log(`[startup] Font OK: ${path.basename(f)} (${size} bytes)`);
    }
  }
});

// Per-request error handler: if a route throws, show a friendly message
// instead of leaving the page loading forever.
app.use((err, req, res, next) => {
  console.error("[request error]", req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).send("সার্ভারে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।");
});

// Safety net: one bad/unexpected request should never take down the whole
// server for every user. Log it and keep running instead of crashing.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Server stayed alive despite this error:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] Server stayed alive despite this error:", err);
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Progress card server running on port ${PORT}`));
}

// ---------- Demo mode: seed on boot, then reset on a timer ----------
if (DEMO_MODE && !process.env.VERCEL) {
  console.log(`[demo] DEMO_MODE চালু — প্রতি ${DEMO_RESET_HOURS} ঘণ্টায় ডেমো ডেটা রিসেট হবে।`);
  demoSeed
    .resetAndSeed()
    .then((r) => { console.log("[demo] ডেমো ডেটা সাজানো হয়েছে:", r); return demoLive.enrich(); })
    .catch((e) => console.error("[demo] প্রাথমিক সিডিং ব্যর্থ হয়েছে:", e));
  setInterval(() => {
    demoSeed
      .resetAndSeed()
      .then((r) => { console.log("[demo] ডেমো ডেটা রিসেট/রিসিড করা হয়েছে:", r); return demoLive.enrich(); })
      .catch((e) => console.error("[demo] রিসেট ব্যর্থ হয়েছে:", e));
  }, DEMO_RESET_HOURS * 60 * 60 * 1000);
  // প্রতি DEMO_TICK_MINUTES (ডিফল্ট ২) মিনিটে একটা নতুন ফি জমা — যাতে সংখ্যা বদলাতে থাকে
  setInterval(() => demoLive.tick().catch((e) => console.error("[demo] টিক ব্যর্থ:", e.message)),
    (parseFloat(process.env.DEMO_TICK_MINUTES || "2") || 2) * 60 * 1000);
}

module.exports = app;
