// Runs automatically after "npm install" (see package.json "postinstall").
// Ensures the Bengali font files exist and are valid, downloading fresh
// copies if they're missing or look corrupted (e.g. from a bad manual upload).
const fs = require("fs");
const path = require("path");
const https = require("https");

const FONTS_DIR = path.join(__dirname, "..", "fonts");
const FILES = {
  "HindSiliguri-Regular.ttf":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/hindsiliguri/HindSiliguri-Regular.ttf",
  "HindSiliguri-Bold.ttf":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/hindsiliguri/HindSiliguri-Bold.ttf",
};

const MIN_VALID_SIZE = 50 * 1024; // a real TTF here is 200KB+; anything tiny means a bad/failed upload

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function ensureFont(filename, url) {
  const dest = path.join(FONTS_DIR, filename);
  const exists = fs.existsSync(dest);
  const validSize = exists && fs.statSync(dest).size >= MIN_VALID_SIZE;

  if (exists && validSize) {
    console.log(`[fonts] OK: ${filename}`);
    return;
  }

  console.log(`[fonts] Missing or invalid, downloading: ${filename}`);
  try {
    await download(url, dest);
    const size = fs.statSync(dest).size;
    if (size < MIN_VALID_SIZE) {
      throw new Error(`Downloaded file too small (${size} bytes)`);
    }
    console.log(`[fonts] Downloaded: ${filename} (${size} bytes)`);
  } catch (err) {
    console.error(`[fonts] FAILED to download ${filename}:`, err.message);
    console.error(`[fonts] PDF generation will not work until this is fixed.`);
  }
}

async function main() {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const [filename, url] of Object.entries(FILES)) {
    await ensureFont(filename, url);
  }
}

main();
