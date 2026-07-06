import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { PDFDocument } from "pdf-lib";

const PORT = process.env.PORT || 3000;
// Supports one key (GEMINI_API_KEY) or several as a comma-separated list
// (GEMINI_API_KEY=key1,key2,key3) so a quota-exhausted key falls back to the next.
const GEMINI_KEYS = (process.env.GEMINI_API_KEY || "")
  .split(",")
  .map(k => k.trim())
  .filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_PAGES = Number(process.env.MAX_PDF_PAGES || 25);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 15);

if (!GEMINI_KEYS.length) {
  console.error("[fatal] GEMINI_API_KEY is not set. Add it to your environment variables.");
  process.exit(1);
}
console.log(`[boot] ${GEMINI_KEYS.length} Gemini key(s) configured`);

// Remember which keys are known-exhausted today so we skip them without retrying.
// Resets naturally on the next deploy/restart, and Google's own RPD resets at
// midnight Pacific — we also self-clear each entry after 20 minutes.
const exhaustedUntil = new Map(); // key -> timestamp
function isExhausted(key) {
  const until = exhaustedUntil.get(key);
  return until && Date.now() < until;
}
function markExhausted(key) {
  exhaustedUntil.set(key, Date.now() + 20 * 60 * 1000);
}

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use(morgan(":date[iso] :method :url :status :response-time ms"));

app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many imports from this device — try again in a few minutes." }
  })
);

const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only PDF, PNG, JPEG or WEBP files are allowed"));
  }
});

const PROMPT = `You are extracting a restaurant menu for upload to a food-delivery catalogue (Zomato, India).
Read the attached menu pages carefully and return every orderable item.

For each row return: item_name, category, variant_name, price, veg_nonveg, description, confidence.

Rules:
- item_name: clean English name. Transliterate non-English (Hindi/Gujarati) names. Fix OCR-style noise into the most likely real dish. Never include the price OR the variant/size in the name.
- VARIANTS ARE IMPORTANT: when one dish has multiple prices under column headers or size labels (e.g. "Regular / With Ice-Cream", "2 Pcs / 4 Pcs", "Half / Full", "250 g / 500 g", "Regular(brown) / Jumbo(white)", "Small / Large"), output ONE row PER price, all sharing the SAME item_name, and put the column/size label in variant_name. Example: a "Classic" cold coffee priced 100 (Regular) and 130 (With Ice-Cream) becomes two rows: {item_name:"Classic Cold Coffee", variant_name:"Regular", price:100} and {item_name:"Classic Cold Coffee", variant_name:"With Ice-Cream", price:130}. Do NOT bake the variant into item_name and do NOT invent separate dish names.
- variant_name: the size/option label exactly as the menu groups it (e.g. "Regular", "With Ice-Cream", "2 Pcs", "500 g", "Jumbo"). If the item has only a single price, set variant_name to "".
- price: integer rupees. Understand ₹149, 149, Rs149, 149/-, 149.00.
- veg_nonveg: "veg", "egg" or "non-veg". Use dish names, green/red dot marks and menu icons. Chicken/mutton/fish/prawn => non-veg.
- description: if the menu prints one, use it (max 25 words). Otherwise write a short appetising line (max 25 words). Keep the description the SAME for all variants of one dish.
- confidence: "High" when name+price are clearly printed; "Medium" if you corrected or inferred something; "Low" if you guessed.
- Skip and never return: restaurant name, phone numbers, GST/FSSAI lines, addresses, QR codes, offers/discount banners, opening hours, Instagram/website, footers, page numbers, watermarks, combos with no printed price.`;


const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      item_name: { type: "STRING" },
      category: { type: "STRING" },
      variant_name: { type: "STRING" },
      price: { type: "NUMBER" },
      veg_nonveg: { type: "STRING", enum: ["veg", "non-veg", "egg"] },
      description: { type: "STRING" },
      confidence: { type: "STRING", enum: ["High", "Medium", "Low"] }
    },
    required: ["item_name", "category", "price", "veg_nonveg", "confidence"]
  }
};

async function callGeminiWithKey(parts, key, attempt = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: "user", parts: [...parts, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA }
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const keyTag = key.slice(-6);
    console.error(`[gemini] key=...${keyTag} status=${resp.status} attempt=${attempt} body=${text.slice(0, 300)}`);
    if (resp.status === 429) { markExhausted(key); throw new QuotaError(); }
    if (resp.status === 400 && /API key/i.test(text)) { markExhausted(key); throw new BadKeyError(); }
    if (attempt < 2 && resp.status >= 500) {
      await new Promise(r => setTimeout(r, 1500));
      return callGeminiWithKey(parts, key, attempt + 1);
    }
    throw new HttpError(502, "The AI service failed to process this menu. Try again.");
  }
  const data = await resp.json();
  const textOut = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("")
    .trim();
  try {
    const arr = JSON.parse(textOut);
    if (!Array.isArray(arr)) throw new Error("not an array");
    return arr;
  } catch (e) {
    console.error(`[gemini] JSON parse failed attempt=${attempt}: ${e.message}`);
    if (attempt < 2) return callGeminiWithKey(parts, key, attempt + 1);
    throw new HttpError(502, "The AI returned an unreadable result. Try again.");
  }
}

// Tries each configured key in turn. Quota/invalid-key errors move to the next
// key automatically; any other error stops immediately (no point retrying that
// on a different key).
async function callGemini(parts) {
  const candidates = GEMINI_KEYS.filter(k => !isExhausted(k));
  const tryOrder = candidates.length ? candidates : GEMINI_KEYS; // if all marked exhausted, try anyway (limits may have reset)
  let lastErr = null;
  for (const key of tryOrder) {
    try {
      return await callGeminiWithKey(parts, key);
    } catch (e) {
      lastErr = e;
      if (e instanceof QuotaError || e instanceof BadKeyError) continue; // fall through to next key
      throw e; // other errors: don't burn through every key for nothing
    }
  }
  if (lastErr instanceof QuotaError) throw new HttpError(429, "All configured AI keys have hit today's quota — try again later or add another key.");
  if (lastErr instanceof BadKeyError) throw new HttpError(500, "Server misconfigured (no valid AI key). Contact the admin.");
  throw new HttpError(502, "The AI service failed to process this menu. Try again.");
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class QuotaError extends Error {}
class BadKeyError extends Error {}

function sanitizeItems(arr) {
  const out = [];
  for (const it of arr) {
    const name = String(it.item_name || "").replace(/\s{2,}/g, " ").trim();
    if (!name || name.length < 2) continue;
    const price = Math.max(0, Math.round(Number(it.price) || 0));
    out.push({
      item_name: name.slice(0, 120),
      category: String(it.category || "Others").trim().slice(0, 60) || "Others",
      variant_name: String(it.variant_name || "").trim().slice(0, 60),
      price,
      veg_nonveg: ["veg", "non-veg", "egg"].includes(it.veg_nonveg) ? it.veg_nonveg : "veg",
      description: String(it.description || "").trim().slice(0, 200),
      confidence: ["High", "Medium", "Low"].includes(it.confidence) ? it.confidence : "Medium"
    });
  }
  return out;
}

app.get("/healthz", (req, res) => {
  const active = GEMINI_KEYS.filter(k => !isExhausted(k)).length;
  res.json({ ok: true, model: GEMINI_MODEL, keys_total: GEMINI_KEYS.length, keys_available: active });
});

app.post("/api/import-menu", (req, res) => {
  upload.array("files", 10)(req, res, async err => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? `Each file must be under ${MAX_FILE_MB} MB` : err.message;
      return res.status(400).json({ error: msg });
    }
    try {
      const files = req.files || [];
      if (!files.length) throw new HttpError(400, "No files uploaded");

      const pdfs = files.filter(f => f.mimetype === "application/pdf");
      if (pdfs.length > 1) throw new HttpError(400, "Upload one PDF at a time (or up to 10 images)");
      for (const pdf of pdfs) {
        const doc = await PDFDocument.load(pdf.buffer, { ignoreEncryption: true }).catch(() => null);
        if (!doc) throw new HttpError(400, "That PDF could not be read — it may be corrupted");
        const pages = doc.getPageCount();
        if (pages > MAX_PAGES) throw new HttpError(400, `PDF has ${pages} pages — the limit is ${MAX_PAGES}`);
      }

      const totalBytes = files.reduce((a, f) => a + f.size, 0);
      if (totalBytes > MAX_FILE_MB * 1024 * 1024) {
        throw new HttpError(400, `Total upload must be under ${MAX_FILE_MB} MB`);
      }

      const parts = files.map(f => ({
        inlineData: { mimeType: f.mimetype, data: f.buffer.toString("base64") }
      }));

      console.log(`[import] files=${files.length} bytes=${totalBytes}`);
      const t0 = Date.now();
      const raw = await callGemini(parts);
      const items = sanitizeItems(raw);
      console.log(`[import] done items=${items.length} in ${Date.now() - t0}ms`);

      if (!items.length) throw new HttpError(422, "No menu items were found in those pages");
      res.json({ items, model: GEMINI_MODEL });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error("[import] error:", e);
      res.status(status).json({ error: e.message || "Import failed" });
    }
  });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => console.log(`Menu Studio import server on :${PORT} (model=${GEMINI_MODEL})`));
