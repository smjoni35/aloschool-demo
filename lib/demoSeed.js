// ---------- Demo-site data seeder ----------
// Only ever runs when DEMO_MODE=true (wired up in server.js). Wipes the
// entire database and refills it with realistic-looking sample data so a
// client browsing the demo sees every feature (students, exams/marks/PDF
// progress cards, fees, attendance, admissions, notices, public website,
// routine, teacher accounts) already populated — instead of a blank app
// they'd have to fill in themselves. Safe to call again any time (e.g. on
// a schedule) to wipe out whatever visitors have changed and start fresh.
const crypto = require("crypto");
const db = require("./db");
const fees = require("./fees");
const auth = require("./auth");
const attendance = require("./attendance");

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}
function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}
function pick(arr, i) {
  return arr[i % arr.length];
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function todayMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const YEAR = String(new Date().getFullYear());

const CLASS_NAMES = [
  "প্রাক-প্রাথমিক",
  "প্রথম শ্রেণি",
  "দ্বিতীয় শ্রেণি",
  "তৃতীয় শ্রেণি",
  "চতুর্থ শ্রেণি",
  "পঞ্চম শ্রেণি",
];

const SUBJECTS = ["বাংলা", "ইংরেজি", "গণিত", "বিজ্ঞান", "ধর্ম শিক্ষা"];

const BOY_NAMES = [
  "আরিয়ান হোসেন", "রাফিদ ইসলাম", "সামিউল হক", "তানভীর আহমেদ", "ফাহিম রহমান",
  "নাফিজ চৌধুরী", "রাকিব হাসান", "ইমরান খান", "সাব্বির আলম", "মাহিন উদ্দিন",
  "জিহাদ শেখ", "রিয়াদ মোল্লা",
];
const GIRL_NAMES = [
  "সাদিয়া আক্তার", "মাইশা জাহান", "তানজিলা বেগম", "নুসরাত জাহান", "ফারিহা ইসলাম",
  "রিমা খাতুন", "সুমাইয়া আক্তার", "তাসনিয়া হক", "মিম আক্তার", "লামিয়া সুলতানা",
  "জান্নাতুল ফেরদৌস", "আনিকা তাবাসসুম",
];
const FATHER_NAMES = ["মো. আব্দুল করিম", "মো. রফিকুল ইসলাম", "মো. জসিম উদ্দিন", "মো. শাহজাহান আলী", "মো. নূরুল হক"];
const MOTHER_NAMES = ["মোছা. রহিমা বেগম", "মোছা. সালমা খাতুন", "মোছা. রোকেয়া বেগম", "মোছা. আয়েশা আক্তার"];

const TEACHERS = [
  { name: "মো. আব্দুল হালিম", designation: "প্রধান শিক্ষক" },
  { name: "মিসেস নাসরিন সুলতানা", designation: "পরিচালক" },
  { name: "মো. কামরুজ্জামান", designation: "সহকারী প্রধান শিক্ষক" },
  { name: "মিসেস শাহনাজ পারভীন", designation: "সহকারী শিক্ষিকা" },
  { name: "মো. ফরহাদ হোসেন", designation: "সহকারী শিক্ষক" },
  { name: "মিসেস তাহমিনা আক্তার", designation: "সহকারী শিক্ষিকা" },
];

const NOTICES = [
  {
    title: `${YEAR} শিক্ষাবর্ষে নতুন ভর্তি চলছে`,
    body: "প্রাক-প্রাথমিক থেকে পঞ্চম শ্রেণি পর্যন্ত ভর্তি কার্যক্রম শুরু হয়েছে। আসন সংখ্যা সীমিত, দ্রুত ভর্তি নিশ্চিত করুন।",
  },
  {
    title: "প্রথম সাময়িক পরীক্ষার ফলাফল প্রকাশ",
    body: "প্রথম সাময়িক পরীক্ষার ফলাফল ওয়েবসাইটের \"রেজাল্ট\" অপশন থেকে রোল/রেজিস্ট্রেশন নম্বর দিয়ে দেখা যাবে।",
  },
  {
    title: "বার্ষিক ক্রীড়া প্রতিযোগিতা",
    body: "আগামী মাসে বিদ্যালয় মাঠে বার্ষিক ক্রীড়া প্রতিযোগিতা অনুষ্ঠিত হবে। সকল শিক্ষার্থীর অংশগ্রহণ কাম্য।",
  },
  {
    title: "অভিভাবক সমাবেশ",
    body: "শিক্ষার্থীদের অগ্রগতি নিয়ে আলোচনার জন্য একটি অভিভাবক সমাবেশের আয়োজন করা হয়েছে।",
  },
];

const FEATURES = [
  { icon: "📚", title: "অভিজ্ঞ শিক্ষকমণ্ডলী", text: "প্রতিটি শ্রেণিতে দক্ষ ও অভিজ্ঞ শিক্ষক দ্বারা পাঠদান।" },
  { icon: "🖥️", title: "ডিজিটাল রেজাল্ট সিস্টেম", text: "অনলাইনে রোল/রেজিস্ট্রেশন দিয়ে ফলাফল ও প্রগ্রেস কার্ড।" },
  { icon: "🚌", title: "পরিবহন সুবিধা", text: "শিক্ষার্থীদের জন্য নিরাপদ যাতায়াত ব্যবস্থা।" },
  { icon: "🏫", title: "নিরাপদ ক্যাম্পাস", text: "সিসিটিভি নজরদারিতে সুরক্ষিত শিক্ষা পরিবেশ।" },
  { icon: "🎯", title: "নিয়মিত পরীক্ষা ও মূল্যায়ন", text: "প্রতি মাসে ক্লাস টেস্ট ও সাময়িক পরীক্ষার মাধ্যমে মূল্যায়ন।" },
];

async function wipeEverything() {
  const keys = await db.keys("");
  for (const k of keys) {
    await db.set(k, null);
  }
}

async function resetAndSeed() {
  await wipeEverything();

  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const teacherPassword = process.env.DEMO_TEACHER_PASSWORD || "teacher123";

  // ---------- Basic settings & website ----------
  await db.set("settings", { schoolName: "আলো শিক্ষা একাডেমি (ডেমো)" });
  await db.set("website", {
    tagline: "মানসম্মত শিক্ষায় আগামীর প্রজন্ম গড়ার প্রত্যয়ে",
    about:
      "আলো শিক্ষা একাডেমি একটি আদর্শ শিক্ষা প্রতিষ্ঠান, যেখানে শিক্ষার্থীদের নৈতিক ও একাডেমিক উভয় দিক থেকে গড়ে তোলা হয়। এটি একটি ডেমো ওয়েবসাইট — এখানে দেখানো সকল তথ্য কাল্পনিক।",
    admission: `${YEAR} শিক্ষাবর্ষে প্রাক-প্রাথমিক থেকে পঞ্চম শ্রেণি পর্যন্ত ভর্তি চলছে। অনলাইনে আবেদন ফরম পূরণ করে সহজেই আবেদন করা যাবে।`,
    contactAddress: "১২৩ স্কুল রোড, শেরপুর, রাজশাহী",
    contactPhone: "01700-000000",
    contactEmail: "info@demo-school.example",
    mapEmbedUrl: "",
    foundedYear: String(new Date().getFullYear() - 8),
    facebookUrl: "",
    youtubeUrl: "",
    admissionBannerEnabled: true,
    admissionBannerText: `${YEAR} শিক্ষাবর্ষে ভর্তি চলছে — আজই আবেদন করুন!`,
    vision: "প্রতিটি শিশুর মেধা ও মননের পূর্ণ বিকাশ ঘটিয়ে একটি আলোকিত সমাজ গড়ে তোলা।",
    mission: "নৈতিক শিক্ষা নিশ্চিত করা\nআধুনিক পাঠদান পদ্ধতি প্রয়োগ করা\nপ্রতিটি শিক্ষার্থীর প্রতি ব্যক্তিগত যত্ন নেওয়া",
    showFees: true,
    feesNote: "নিচের ফি কাঠামো নমুনা হিসেবে দেখানো হয়েছে।",
    directorMessage:
      "আমাদের প্রতিষ্ঠানের লক্ষ্য প্রতিটি শিক্ষার্থীকে একজন যোগ্য ও নৈতিক মানুষ হিসেবে গড়ে তোলা। আপনাদের সহযোগিতায় আমরা একসাথে এগিয়ে যেতে চাই।",
    headMessage:
      "শিক্ষার্থীদের সুন্দর ভবিষ্যৎ গড়তে আমরা প্রতিশ্রুতিবদ্ধ। আমাদের বিদ্যালয়ে ভর্তির জন্য সকলকে আন্তরিক আমন্ত্রণ।",
  });
  await db.set("features", FEATURES.map((f) => ({ id: shortId(), ...f })));

  // ---------- Classes ----------
  const classes = CLASS_NAMES.map((name, i) => ({ slug: slugify(name), name, code: String(i).padStart(2, "0") }));
  await db.set("classlist", classes);

  // ---------- Teachers (public list) + login accounts ----------
  const teachers = TEACHERS.map((t) => ({ id: shortId(), name: t.name, designation: t.designation }));
  await db.set("teachers", teachers);

  const teacherAccounts = [];
  for (const src of [teachers[0], teachers[2]]) {
    const { salt, hash } = auth.hashPassword(teacherPassword);
    teacherAccounts.push({
      id: shortId(),
      name: src.name,
      sourceTeacherId: src.id,
      salt,
      hash,
      createdAt: Date.now(),
    });
  }
  await db.set("teacheraccounts", teacherAccounts);

  // ---------- Students, per class ----------
  const examlist = [];
  const perClassStudents = {};

  for (let ci = 0; ci < classes.length; ci++) {
    const cls = classes[ci];
    const count = randInt(9, 12);
    const students = [];
    for (let i = 1; i <= count; i++) {
      const isGirl = i % 2 === 0;
      const name = isGirl ? pick(GIRL_NAMES, i + ci) : pick(BOY_NAMES, i + ci);
      const roll = String(i).padStart(2, "0");
      students.push({
        id: shortId(),
        name,
        roll,
        section: "",
        registration: `${YEAR}${cls.code}${roll}`,
        fatherName: pick(FATHER_NAMES, i + ci),
        motherName: pick(MOTHER_NAMES, i + ci),
        phone: `01${randInt(300000000, 999999999)}`,
        address: "শেরপুর, রাজশাহী",
      });
    }
    await db.set(`students:${cls.slug}`, students);
    perClassStudents[cls.slug] = students;

    // ---------- One exam per class, fully marked ----------
    const examKey = `${slugify(cls.name)}-${slugify("প্রথম সাময়িক পরীক্ষা")}-${slugify(YEAR)}-${shortId()}`;
    const subjects = SUBJECTS.map((s) => ({ name: s, fullMarks: 100 }));
    const marksByStudent = {};
    students.forEach((st, si) => {
      const row = {};
      subjects.forEach((subj, subi) => {
        // leave one subject blank for the last student, to show the
        // "ungraded" (—) handling the app has for incomplete results
        if (si === students.length - 1 && subi === subjects.length - 1) return;
        const base = randInt(55, 98);
        const weak = si % 5 === 0 && subi === 2; // occasional weak math score
        row[subj.name] = weak ? randInt(28, 48) : base;
      });
      marksByStudent[st.id] = row;
    });
    const exam = {
      key: examKey,
      classSlug: cls.slug,
      className: cls.name,
      examName: "প্রথম সাময়িক পরীক্ষা",
      session: YEAR,
      schoolName: "আলো শিক্ষা একাডেমি (ডেমো)",
      subjects,
      marksByStudent,
      createdAt: Date.now(),
    };
    await db.set(`exam:${examKey}`, exam);
    examlist.push({ key: examKey, className: cls.name, examName: exam.examName, session: YEAR });

    // ---------- Fee structure + charges + some payments ----------
    await fees.saveFeeAmounts(cls.slug, YEAR, {
      sessionFee: 500,
      monthlyTuition: 600 + ci * 50,
      transportMonthly: 300,
      coachingMonthly: 0,
      examFees: { quarterly: 200, halfYearly: 250, annual: 300 },
    });
  }
  await db.set("examlist", examlist);

  // Bill the last two months for every class, then pay most (not all) of it.
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return d.toISOString().slice(0, 7);
  });
  for (const month of months) {
    await fees.generateMonthlyCharges(YEAR, month);
  }
  for (const cls of classes) {
    const students = perClassStudents[cls.slug];
    for (let i = 0; i < students.length; i++) {
      const st = students[i];
      const ledger = await fees.getLedger(st.id);
      const balance = fees.computeBalance(ledger);
      if (balance.due <= 0) continue;
      // Most students pay in full, a few keep a partial due for realism.
      const payAmount = i % 4 === 0 ? Math.round(balance.due * 0.5) : balance.due;
      if (payAmount > 0) {
        await fees.addPayment(st.id, {
          amount: payAmount,
          method: i % 2 === 0 ? "নগদ" : "বিকাশ",
          note: "",
          classSlug: cls.slug,
          date: todayMinus(randInt(0, 20)),
        });
      }
    }
  }

  // ---------- Notices ----------
  const notices = NOTICES.map((n, i) => ({
    id: shortId(),
    title: n.title,
    body: n.body,
    date: todayMinus(i * 3),
    createdAt: Date.now() - i * 3 * 86400000,
  }));
  await db.set("notices", notices);

  // ---------- Pending admissions ----------
  const admissionsPending = [];
  for (let i = 0; i < 3; i++) {
    const cls = pick(classes, i);
    const isGirl = i % 2 === 0;
    const id = shortId();
    const application = {
      id,
      admissionNo: `${YEAR}-${String(i + 1).padStart(4, "0")}`,
      classSlug: cls.slug,
      className: cls.name,
      name: isGirl ? pick(GIRL_NAMES, i + 5) : pick(BOY_NAMES, i + 5),
      fatherName: pick(FATHER_NAMES, i),
      motherName: pick(MOTHER_NAMES, i),
      dob: "2018-05-15",
      gender: isGirl ? "মেয়ে" : "ছেলে",
      bloodGroup: "O+",
      fatherPhone: `01${randInt(300000000, 999999999)}`,
      motherPhone: `01${randInt(300000000, 999999999)}`,
      presentAddress: "শেরপুর, রাজশাহী",
      previousSchool: "",
      reasonForLeaving: "",
      photoDataUrl: "",
      submittedAt: Date.now() - i * 86400000,
      status: "pending",
    };
    await db.set(`admission:${id}`, application);
    admissionsPending.push(id);
  }
  await db.set("admissions:pending", admissionsPending);
  await db.set(`admissions:counter:${YEAR}`, 3);

  // ---------- Routine (one class fully filled, rest just shift-assigned) ----------
  const classShifts = {};
  classes.forEach((c, i) => (classShifts[c.slug] = i % 2 === 0 ? "morning" : "day"));
  await db.set("classShifts", classShifts);

  const periodTimes = ["৯:০০-৯:৪৫", "৯:৪৫-১০:৩০", "১০:৩০-১১:১৫", "১১:১৫-১২:০০", "১২:০০-১২:৩০", "১২:৩০-১:১৫", "১:১৫-২:০০", "২:০০-২:৪৫"];
  await db.set("shiftPeriodTimes", { morning: periodTimes, day: periodTimes });

  const routineClass = classes[1]; // প্রথম শ্রেণি
  const weekdayKeys = ["saturday", "sunday", "monday", "tuesday", "wednesday", "thursday"];
  const schedule = {};
  weekdayKeys.forEach((day, di) => {
    const periods = [];
    for (let p = 0; p < 8; p++) {
      periods.push({ subject: pick(SUBJECTS, p + di), teacher: pick(teachers, p).name });
    }
    schedule[day] = periods;
  });
  await db.set(`classroutine:${routineClass.slug}`, { offDays: ["friday"], schedule });

  // ---------- Attendance: session + a class teacher + a few days' records ----------
  await attendance.setCurrentSession(YEAR);
  await attendance.setClassShift(YEAR, routineClass.slug, "morning");
  await attendance.assignClassTeacher(YEAR, {
    shift: "morning",
    classSlug: routineClass.slug,
    className: routineClass.name,
    teacherAccountId: teacherAccounts[0].id,
    teacherName: teacherAccounts[0].name,
  });
  const roster = perClassStudents[routineClass.slug];
  for (let back = 0; back < 3; back++) {
    const date = todayMinus(back);
    const records = {};
    roster.forEach((st, i) => {
      records[st.id] = i % 9 === 0 ? "absent" : i % 11 === 0 ? "leave" : "present";
    });
    await attendance.saveStudentAttendance(YEAR, "morning", routineClass.slug, routineClass.name, date, records, {
      type: "admin",
      id: "demo",
      name: "ডেমো অ্যাডমিন",
    });
    for (const acc of teacherAccounts) {
      await attendance.teacherCheckIn(YEAR, date, acc.id, acc.name);
    }
  }

  await db.set("demoSeededAt", Date.now());
  return { classes: classes.length, teachers: teachers.length, examlist: examlist.length };
}

module.exports = { resetAndSeed, adminPassword: () => process.env.ADMIN_PASSWORD || "admin123", teacherPassword: () => process.env.DEMO_TEACHER_PASSWORD || "teacher123" };
