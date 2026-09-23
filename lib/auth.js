const crypto = require("crypto");
const db = require("./db");

// Single shared admin password, set via the ADMIN_PASSWORD environment
// variable on your host (Render -> Environment). Falls back to a default
// so the app still runs locally, but that default is NOT safe for a
// public deployment — change it.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    "[auth] সতর্কতা: ADMIN_PASSWORD environment variable সেট করা নেই — ডিফল্ট পাসওয়ার্ড 'admin123' ব্যবহার হচ্ছে।\n" +
      "         পাবলিক হোস্টিং (Render ইত্যাদি)-এ Environment Variable হিসেবে ADMIN_PASSWORD অবশ্যই সেট করে দিন।"
  );
}

// ---------- Login rate-limiting (brute-force protection) ----------
// Tracks failed login attempts per IP address, separately for the admin
// login and the teacher login (so one doesn't block the other). After
// MAX_ATTEMPTS failures in a row, that IP is blocked from that login form
// for BLOCK_DURATION_MS. A successful login clears the counter.
// In-memory only — resets on server restart/redeploy, same as sessions.
const MAX_ATTEMPTS = 3;
const BLOCK_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const loginAttempts = new Map(); // key: `${scope}:${ip}` -> { count, blockedUntil }

// Best-effort real client IP: works whether or not the host sits behind a
// proxy (Render does). app.set("trust proxy", 1) in server.js makes
// req.ip already reflect the original client via X-Forwarded-For.
function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

// Call before attempting a login. Returns { blocked: true, remainingMs }
// if this IP is currently locked out for this scope, otherwise
// { blocked: false }.
function checkRateLimit(req, scope) {
  const key = `${scope}:${clientIp(req)}`;
  const entry = loginAttempts.get(key);
  if (!entry || !entry.blockedUntil) return { blocked: false };
  const remainingMs = entry.blockedUntil - Date.now();
  if (remainingMs <= 0) {
    loginAttempts.delete(key);
    return { blocked: false };
  }
  return { blocked: true, remainingMs };
}

// Call after a failed login attempt. Once MAX_ATTEMPTS is reached, sets
// a block for BLOCK_DURATION_MS.
function recordFailedAttempt(req, scope) {
  const key = `${scope}:${clientIp(req)}`;
  const entry = loginAttempts.get(key) || { count: 0, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = Date.now() + BLOCK_DURATION_MS;
  }
  loginAttempts.set(key, entry);
}

// Call after a successful login to clear this IP's failed-attempt count.
function clearRateLimit(req, scope) {
  loginAttempts.delete(`${scope}:${clientIp(req)}`);
}

function minutesRemaining(remainingMs) {
  return Math.max(1, Math.ceil(remainingMs / 60000));
}

const SESSION_COOKIE = "pcs_session";

// Sessions are stored in the same persistent database as everything else
// (Upstash Redis when configured, otherwise the local data/ files) instead
// of an in-memory Map. A plain in-memory Map used to mean every login was
// wiped out whenever the server process restarted — which, on a free
// Render instance, happens both on every redeploy AND automatically
// whenever the instance spins down from inactivity (Render's free tier
// does this after ~15 minutes idle) — so people were getting logged out
// far more often than they'd ever expect. Storing sessions in the database
// instead means a login now survives both of those.
function sessionKey(token) {
  return `session:${token}`;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

// ---------- Password hashing (for per-teacher accounts) ----------
// The admin password stays a plain env-var comparison (as before) — this
// is only for teacher accounts, whose usernames/passwords are created
// through the admin panel and stored in the database.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const check = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
    const a = Buffer.from(check, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------- Sessions ----------
// Timing-safe comparison: a plain `!==` check returns faster the sooner
// the strings differ, which in theory could leak information about the
// password one character at a time. Hashing both sides to a fixed length
// first, then comparing with crypto.timingSafeEqual, avoids that.
function passwordsMatch(input, expected) {
  const a = crypto.createHash("sha256").update(String(input || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(a, b);
}

async function login(password) {
  if (!passwordsMatch(password, ADMIN_PASSWORD)) return null;
  const token = crypto.randomBytes(24).toString("hex");
  await db.set(sessionKey(token), { role: "admin" });
  return token;
}

// `teacher` is a teacher-account record ({ id, name, ... }) already
// verified (username + password checked) by the caller.
async function createTeacherSession(teacher) {
  const token = crypto.randomBytes(24).toString("hex");
  await db.set(sessionKey(token), { role: "teacher", teacherId: teacher.id, teacherName: teacher.name });
  return token;
}

async function logout(token) {
  if (token) await db.set(sessionKey(token), null);
}

async function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return (await db.get(sessionKey(token))) || null;
}

async function isAuthed(req) {
  return Boolean(await getSession(req));
}

async function isAdmin(req) {
  const session = await getSession(req);
  return Boolean(session && session.role === "admin");
}

// Returns { id, name } for a logged-in teacher session, otherwise null.
async function currentTeacher(req) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return null;
  return { id: session.teacherId, name: session.teacherName };
}

// These must stay reachable even when not logged in, or nobody could ever log in.
const PUBLIC_PATHS = new Set([
  "/login",
  "/logout",
  "/teacher/login",
  "/teacher/logout",
  "/",
  "/about",
  "/teachers",
  "/gallery",
  "/notices",
  "/admission",
  "/routine",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
]);

// The public Student/Guardian result page (search + view + PDF download) is
// intentionally open with no login — access to any one student's result is
// instead gated by requiring their correct roll/registration number (see
// server.js findStudentByCode). Everything under /result is public.
// The public school website (home page + notices) is likewise open to
// anyone — it's meant to be shared, not an admin tool. Same for /routine —
// the routine page itself was already public, but its PDF downloads
// (all-classes and the per-class one) live one level deeper and need the
// same open access so a guardian without a login can actually fetch them.
const PUBLIC_PATH_PREFIXES = ["/result", "/admission", "/routine"];

async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (PUBLIC_PATH_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))) return next();

  let session;
  try {
    session = await getSession(req);
  } catch (e) {
    console.error("[auth] session lookup failed:", e);
    return res.redirect("/login");
  }
  if (!session) return res.redirect("/login");

  // Teacher sessions are confined to the Teacher Panel (/teacher/*) — the
  // rest of the site (settings, backups, student management, website
  // content, etc.) stays admin-only.
  if (session.role === "teacher" && !(req.path === "/teacher" || req.path.startsWith("/teacher/"))) {
    return res.redirect("/teacher/panel");
  }

  return next();
}

// "Secure" makes the browser send the session cookie over HTTPS only. Turned
// on automatically on Render / when NODE_ENV=production; left off locally so
// http://localhost still works while developing.
const SECURE_FLAG = process.env.NODE_ENV === "production" || process.env.RENDER ? "; Secure" : "";

function setSessionCookie(res, token) {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${SECURE_FLAG}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${SECURE_FLAG}`);
}

module.exports = {
  login,
  createTeacherSession,
  logout,
  isAuthed,
  isAdmin,
  currentTeacher,
  getSession,
  requireAuth,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
  minutesRemaining,
  SESSION_COOKIE,
};
