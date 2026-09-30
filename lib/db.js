const fs = require("fs");
const path = require("path");

// Vercel-এ প্রজেক্ট ফোল্ডার read-only, তাই সেখানে শুধু /tmp-এ লেখা যায় (অস্থায়ী)।
const DATA_DIR = process.env.VERCEL
  ? path.join(require("os").tmpdir(), "data")
  : path.join(__dirname, "..", "data");
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error("[db] data ফোল্ডার বানানো যায়নি:", e.message);
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

function fileFor(key) {
  const safe = key.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return path.join(DATA_DIR, `${safe}.json`);
}

async function get(key) {
  if (useUpstash) {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return null;
    try {
      return JSON.parse(data.result);
    } catch {
      return null;
    }
  } else {
    const f = fileFor(key);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {
      return null;
    }
  }
}

async function set(key, value) {
  const json = JSON.stringify(value);
  if (useUpstash) {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: json,
    });
  } else {
    fs.writeFileSync(fileFor(key), json, "utf-8");
  }
}

async function keys(prefix) {
  if (useUpstash) {
    const res = await fetch(`${UPSTASH_URL}/keys/${encodeURIComponent(prefix + "*")}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    return data.result || [];
  } else {
    if (!fs.existsSync(DATA_DIR)) return [];
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "").replace(/_/g, ":"))
      .filter((k) => k.startsWith(prefix));
  }
}

module.exports = { get, set, keys, useUpstash };
