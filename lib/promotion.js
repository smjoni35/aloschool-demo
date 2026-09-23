const { computeResultsRows } = require("./results");

// Standard class sequence used to figure out what the "next class up" is
// called. Matched against a class's existing name after stripping a
// trailing শ্রেণী/শ্রেণি suffix and surrounding whitespace, so this works
// whether the admin named the class "সপ্তম", "সপ্তম শ্রেণী" or "সপ্তম শ্রেণি".
// New classes auto-created by promotion are always named with the full
// "<অর্ডিনাল> শ্রেণী" form (e.g. "অষ্টম শ্রেণী") — this is a display
// convention only, not something the rest of the app depends on.
const CLASS_ORDINALS = [
  "প্রাক-প্রাথমিক",
  "প্রথম",
  "দ্বিতীয়",
  "তৃতীয়",
  "চতুর্থ",
  "পঞ্চম",
  "ষষ্ঠ",
  "সপ্তম",
  "অষ্টম",
  "নবম",
  "দশম",
];

// A student counts as "held for a future session" if they were approved
// (see server.js's /admissions/:id/approve) with a `session` tag that is
// later than the session currently being promoted — e.g. a student
// admitted in advance for 2027 while promotion is still being run for
// 2026. Such students must not be swept into the current run (they
// haven't attended a single class yet, let alone sat the annual exam),
// and they must not be counted as a "pre-existing resident" when we
// check whether a target class already has conflicting students, since
// them sitting in their own new class is exactly the intended state.
// Students with no `session` tag at all (all students created before
// this field existed, and any created some other way) are always
// treated as normal — never held back — for backward compatibility.
function isHeldForFutureSession(student, session) {
  const s = parseInt(student && student.session, 10);
  const p = parseInt(session, 10);
  if (Number.isNaN(s) || Number.isNaN(p)) return false;
  return s > p;
}

function ordinalIndex(className) {
  const trimmed = (className || "").trim();
  const core = trimmed.replace(/\s*শ্রেণ[ীি]\s*$/, "").trim().normalize("NFC");
  // See server.js's classRank() for why NFC normalization matters here —
  // "দ্বিতীয়" and "তৃতীয়" contain "য়", which can be stored as either a
  // single precomposed codepoint or a base letter + nukta sequence.
  // Without normalizing both sides, those two classes silently fail to
  // match here even though they look identical on screen.
  return CLASS_ORDINALS.findIndex((o) => o.normalize("NFC") === core);
}

// Returns the display name for the class one level above `className`, or
// null if className isn't recognized or is already the last known class
// (দশম) — in both cases the admin needs to create/name that class by hand
// before promotion can continue into it.
function nextClassName(className) {
  const idx = ordinalIndex(className);
  if (idx === -1 || idx >= CLASS_ORDINALS.length - 1) return null;
  return `${CLASS_ORDINALS[idx + 1]} শ্রেণী`;
}

// Finds each class's বার্ষিক (annual) exam for the given session, i.e. the
// examlist entry for that class whose examName contains "বার্ষিক".
// Returns a Map from classSlug -> that examlist entry (or undefined if the
// class has no annual exam recorded for this session).
function findAnnualExamsBySession(examlist, classes, session) {
  const bySlug = new Map();
  for (const cls of classes) {
    const entry = examlist.find(
      (e) =>
        e.className === cls.name &&
        (e.session || "") === (session || "") &&
        (e.examName || "").includes("বার্ষিক")
    );
    if (entry) bySlug.set(cls.slug, entry);
  }
  return bySlug;
}

// Builds a full promotion plan for every class, without changing any data.
// `classes` must be in ascending order (lowest class first, same order as
// classlist) — the plan is computed from the highest class down, since
// that's the order promotion has to actually run in (see nextClassName /
// server route) to avoid one class's incoming students mixing with the
// class above's own current students before that class has moved out.
//
// Returns { steps, errors } where:
//   steps  — array of { fromClass, toClassName, toClassSlug (may be null
//            if the class must be auto-created), isNewClass, students: [{
//            id, name, oldRoll, newRoll, position }] }, ordered highest
//            class first (the order to apply them in)
//   errors — array of human-readable Bengali strings for classes that
//            can't be planned (no annual exam found for the session, or
//            no known "next class" name and no existing class with that
//            name either) — the caller should show these and refuse to
//            proceed until they're resolved.
async function buildPromotionPlan(db, session) {
  const classes = (await db.get("classlist")) || [];
  const examlist = (await db.get("examlist")) || [];
  const annualExamBySlug = findAnnualExamsBySession(examlist, classes, session);

  const steps = [];
  const errors = [];
  // Tracks which classes will actually be emptied out by this same plan
  // (their own promotion succeeded earlier in this loop) — used below to
  // make sure we never move incoming students into a class that still has
  // its own current occupants sitting in it un-promoted, which would mix
  // two different classes' students together under duplicate roll numbers.
  const vacatedSlugs = new Set();

  // Highest class first. classlist is NOT guaranteed to be stored in
  // ascending grade order — classes get their array position from the
  // order the admin happened to create them in (see server.js), which can
  // be arbitrary. So sort by the known ordinal here rather than trusting
  // that stored order/reversing it; a class whose name doesn't match a
  // known ordinal sorts last (it will hit the "next class name" error
  // below anyway, so its position among other unknowns doesn't matter).
  const orderedClasses = [...classes].sort((a, b) => {
    const ra = ordinalIndex(a.name);
    const rb = ordinalIndex(b.name);
    return (rb === -1 ? -Infinity : rb) - (ra === -1 ? -Infinity : ra);
  });

  for (const cls of orderedClasses) {
    const examEntry = annualExamBySlug.get(cls.slug);
    if (!examEntry) {
      errors.push(`"${cls.name}" ক্লাসের ${session} সেশনের বার্ষিক পরীক্ষা পাওয়া যায়নি — এই ক্লাসের প্রমোশন বাদ থাকবে।`);
      continue;
    }

    const allStudents = (await db.get(`students:${cls.slug}`)) || [];
    // Students admitted in advance for a later session sit in this class's
    // list but haven't actually studied here yet — leave them behind.
    const students = allStudents.filter((s) => !isHeldForFutureSession(s, session));
    if (students.length === 0) continue; // nothing to promote for an empty class

    const targetName = nextClassName(cls.name);
    let targetClass = targetName ? classes.find((c) => c.name === targetName) : null;
    if (!targetName) {
      errors.push(
        `"${cls.name}" এর পরের ক্লাসের নাম বুঝতে পারিনি — এটা যদি স্ট্যান্ডার্ড ক্লাস (প্রাক-প্রাথমিক–দশম) না হয়, তাহলে আগে ম্যানুয়ালি পরের ক্লাসটা তৈরি করে দিন।`
      );
      continue;
    }

    // Guard against mixing: if the target class already exists and still
    // has its own current students who are not themselves being promoted
    // out as part of this same run, moving this class's students into it
    // would merge two different cohorts (and likely duplicate roll
    // numbers) — so skip this one transfer and tell the admin why, rather
    // than silently merging.
    if (targetClass && !vacatedSlugs.has(targetClass.slug)) {
      const allTargetStudents = (await db.get(`students:${targetClass.slug}`)) || [];
      // Students already sitting in the target class because they were
      // admitted in advance for this same upcoming session aren't a
      // conflict — merging this class's promoted batch with them is
      // exactly the intended outcome, not two cohorts mixing.
      const targetStudents = allTargetStudents.filter((s) => !isHeldForFutureSession(s, session));
      if (targetStudents.length > 0) {
        errors.push(
          `"${cls.name}" থেকে "${targetName}"-এ প্রমোশন বাদ থাকবে — কারণ "${targetName}"-এ আগে থেকেই ${targetStudents.length} জন শিক্ষার্থী আছে যারা এই দফায় প্রমোট হচ্ছে না (সম্ভবত তাদের নিজেদের বার্ষিক পরীক্ষা এই সেশনে পাওয়া যায়নি)। আগে সেটা ঠিক করুন, নইলে দুই ব্যাচ মিশে যাবে।`
        );
        continue;
      }
    }

    const exam = await db.get(`exam:${examEntry.key}`);
    const rows = exam ? computeResultsRows(exam, students) : [];
    const rowByStudentId = new Map(rows.map((r) => [r.student.id, r]));

    // Rank: students with a merit position first (by position ascending),
    // then everyone else (incomplete marks / absent) after them, in their
    // existing roll order — so nobody is silently dropped, per the
    // decision to promote everyone regardless of pass/fail.
    const withPosition = [];
    const withoutPosition = [];
    for (const student of students) {
      const row = rowByStudentId.get(student.id);
      if (row && row.position) withPosition.push({ student, position: row.position });
      else withoutPosition.push({ student, position: null });
    }
    withPosition.sort((a, b) => a.position - b.position);

    const orderedStudents = [...withPosition, ...withoutPosition];
    const studentPlans = orderedStudents.map((entry, i) => ({
      id: entry.student.id,
      name: entry.student.name,
      oldRoll: entry.student.roll || "",
      newRoll: String(i + 1),
      position: entry.position,
    }));

    steps.push({
      fromClassSlug: cls.slug,
      fromClassName: cls.name,
      toClassName: targetName,
      toClassSlug: targetClass ? targetClass.slug : null,
      isNewClass: !targetClass,
      students: studentPlans,
    });
    vacatedSlugs.add(cls.slug);
  }

  return { steps, errors };
}

// Slug helper duplicated from server.js's own (kept identical) so this
// module has no circular dependency on server.js.
function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

// Applies a plan built by buildPromotionPlan. Must be called with the
// exact same `plan` the admin was shown and confirmed — this function
// does not re-check anything, it just executes the moves.
async function applyPromotionPlan(db, plan) {
  const classes = (await db.get("classlist")) || [];

  for (const step of plan.steps) {
    let toClass = classes.find((c) => c.slug === step.toClassSlug);
    if (!toClass) {
      const slug = slugify(step.toClassName);
      toClass = { slug, name: step.toClassName, code: String(classes.length).padStart(2, "0") };
      classes.push(toClass);
    }

    // Re-fetch full student records for the source class right now (rather
    // than trust whatever slim shape the confirm form posted back) so
    // every existing field — section, parents' names, DOB, gender, blood
    // group, mobile, address, registration, etc. — carries over intact;
    // only roll number changes, per the plan.
    const fromStudents = (await db.get(`students:${step.fromClassSlug}`)) || [];
    const byId = new Map(fromStudents.map((s) => [s.id, s]));
    const newRollById = new Map(step.students.map((s) => [s.id, s.newRoll]));

    const incoming = step.students
      .map((s) => byId.get(s.id))
      .filter(Boolean)
      .map((student) => ({ ...student, roll: newRollById.get(student.id) }));

    // Merge into the target class rather than overwrite — the target may
    // already hold students promoted into it earlier in this same run
    // (there shouldn't be any yet, since promotion always runs highest
    // class first, but this keeps the function safe either way).
    const existingTarget = (await db.get(`students:${toClass.slug}`)) || [];
    await db.set(`students:${toClass.slug}`, [...existingTarget, ...incoming]);
    // Only remove the students actually promoted — anyone else left in the
    // source class (e.g. students admitted in advance for a later session,
    // held back by buildPromotionPlan) must stay put.
    const remaining = fromStudents.filter((s) => !newRollById.has(s.id));
    await db.set(`students:${step.fromClassSlug}`, remaining);
  }

  await db.set("classlist", classes);
}

module.exports = {
  CLASS_ORDINALS,
  nextClassName,
  buildPromotionPlan,
  applyPromotionPlan,
};
