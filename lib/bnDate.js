// Small helper for rendering Bangla-digit dates on the admin dashboard
// greeting banner (e.g. "১৫ সেপ্টেম্বর ২০২৬" / "মঙ্গলবার"). Separate from
// lib/pdf.js's own digit conversion since this has nothing to do with PDF
// generation and other views may want it later.
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBnDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
}

const BN_MONTHS = [
  "জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
  "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর",
];
const BN_WEEKDAYS = [
  "রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার",
];

function formatBnDate(date) {
  const d = date || new Date();
  return `${toBnDigits(d.getDate())} ${BN_MONTHS[d.getMonth()]} ${toBnDigits(d.getFullYear())}`;
}
function bnWeekday(date) {
  const d = date || new Date();
  return BN_WEEKDAYS[d.getDay()];
}

module.exports = { toBnDigits, formatBnDate, bnWeekday };
