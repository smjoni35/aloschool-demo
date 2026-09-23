const { getGrade } = require("./pdf");

// Computes each student's total marks, percentage, grade and merit
// position for one exam. Shared by the results/print pages and by the
// class-promotion tool (which uses `position` to assign new roll numbers).
function computeResultsRows(exam, students) {
  const rows = students.map((student) => {
    const marks = exam.marksByStudent[student.id] || {};
    let totalObtained = 0,
      totalFull = 0,
      gpSum = 0,
      failCount = 0,
      gradedCount = 0;
    exam.subjects.forEach((s) => {
      const raw = marks[s.name];
      const entered = raw !== undefined && raw !== null && raw !== "";
      const full = parseFloat(s.fullMarks) || 100;
      if (!entered) return; // not yet marked — exclude entirely, don't count as 0
      const obtained = parseFloat(raw) || 0;
      totalObtained += obtained;
      totalFull += full;
      const { grade, gp } = getGrade((obtained / full) * 100);
      if (grade === "F") failCount++;
      gpSum += gp;
      gradedCount++;
    });
    const pct = totalFull ? (totalObtained / totalFull) * 100 : 0;
    const allEntered = gradedCount === exam.subjects.length && exam.subjects.length > 0;
    const overall = !allEntered ? { grade: "—", gp: 0 } : failCount > 0 ? { grade: "F", gp: 0 } : getGrade(pct);
    const avgGP = gradedCount ? gpSum / gradedCount : 0;
    return { student, totalObtained, totalFull, pct, overall, avgGP, allEntered };
  });

  const ranked = rows.filter((r) => r.allEntered).sort((a, b) => b.totalObtained - a.totalObtained);
  let lastScore = null,
    lastRank = 0;
  ranked.forEach((r, i) => {
    if (r.totalObtained !== lastScore) {
      lastRank = i + 1;
      lastScore = r.totalObtained;
    }
    r.position = lastRank;
  });
  const totalRanked = ranked.length;
  rows.forEach((r) => {
    r.totalRanked = totalRanked;
    if (!r.allEntered) r.position = null;
  });

  return rows;
}

module.exports = { computeResultsRows };
