// Sends every logged activity to the director (পরিচালক) on Telegram.
// Configure with two environment variables (same style as R2/Upstash
// config elsewhere in lib/): TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
// If either is missing, sending is silently skipped — nothing breaks.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const enabled = Boolean(BOT_TOKEN && CHAT_ID);

// Fire-and-forget: never await this from a request handler. A slow or
// failing Telegram API call must never delay a page save or crash the
// request — so every failure is caught and swallowed here.
function notify(text) {
  if (!enabled) return;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  }).catch((err) => {
    console.error("Telegram notify failed:", err.message);
  });
}

module.exports = { notify, enabled };
