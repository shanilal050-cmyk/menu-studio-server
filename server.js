import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { PDFDocument } from "pdf-lib";

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_PAGES = Number(process.env.MAX_PDF_PAGES || 25);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 15);

if (!GEMINI_API_KEY) {
  console.error("[fatal] GEMINI_API_KEY is not set. Add it to your environment variables.");
  process.exit(1);
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

For each item return: item_name, category, price, veg_nonveg, description, confidence.

Rules:
- item_name: clean English name. Transliterate non-English (Hindi/Gujarati) names. Fix OCR-style noise into the most likely real dish. Never include the price in the name.
- category: use the menu's own section headings (e.g. Chinese, Pizza, Punjabi, Tandoor, Sweets, Beverages). If a page has no headings, infer the category from dish knowledge.
- price: integer rupees. Understand ₹149, 149, Rs149, 149/-, 149.00.
- Multiple prices for one item (Half/Full, 250gm/500gm, Small/Large, 249/399): return a SEPARATE item per price with the size appended to item_name in brackets, e.g. "Paneer Handi (250 g)", "Margherita (Large)".
- veg_nonveg: "veg", "egg" or "non-veg". Use dish names, green/red dot marks and menu icons. Chicken/mutton/fish/prawn => non-veg.
- description: if the menu prints one, use it (max 25 words). Otherwise write a short appetising line (max 25 words), different for every item.
- confidence: "High" when name+price are clearly printed; "Medium" if you corrected or inferred something; "Low" if you guessed.
- Skip and never return: restaurant name, phone numbers, GST/FSSAI lines, addresses, QR codes, offers/discount banners, opening hours, Instagram/website, footers, page numbers, watermarks, combos with no printed price.`;

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      item_name: { type: "STRING" },
      category: { type: "STRING" },
      price: { type: "NUMBER" },
      veg_nonveg: { type: "STRING", enum: ["veg", "non-veg", "egg"] },
      description: { type: "STRING" },
      confidence: { type: "STRING", enum: ["High", "Medium", "Low"] }
    },
    required: ["item_name", "category", "price", "veg_nonveg", "confidence"]
  }
};

async function callGemini(parts, attempt = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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
    console.error(`[gemini] status=${resp.status} attempt=${attempt} body=${text.slice(0, 300)}`);
    if (resp.status === 429) throw new HttpError(429, "AI quota exhausted for today — try again later.");
    if (resp.status === 400 && /API key/i.test(text)) throw new HttpError(500, "Server misconfigured (invalid AI key). Contact the admin.");
    if (attempt < 2 && resp.status >= 500) {
      await new Promise(r => setTimeout(r, 1500));
      return callGemini(parts, attempt + 1);
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
    if (attempt < 2) return callGemini(parts, attempt + 1);
    throw new HttpError(502, "The AI returned an unreadable result. Try again.");
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sanitizeItems(arr) {
  const out = [];
  for (const it of arr) {
    const name = String(it.item_name || "").replace(/\s{2,}/g, " ").trim();
    if (!name || name.length < 2) continue;
    const price = Math.max(0, Math.round(Number(it.price) || 0));
    out.push({
      item_name: name.slice(0, 120),
      category: String(it.category || "Others").trim().slice(0, 60) || "Others",
      price,
      veg_nonveg: ["veg", "non-veg", "egg"].includes(it.veg_nonveg) ? it.veg_nonveg : "veg",
      description: String(it.description || "").trim().slice(0, 200),
      confidence: ["High", "Medium", "Low"].includes(it.confidence) ? it.confidence : "Medium"
    });
  }
  return out;
}

app.get("/healthz", (req, res) => res.json({ ok: true, model: GEMINI_MODEL }));

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
