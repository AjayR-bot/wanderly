// Wanderly backend: validates trip requests and returns a full itinerary built from free
// data (OpenStreetMap via Geoapify, Wikipedia, Wikivoyage). No AI and no paid APIs.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import { buildPlan, hasDataKey, EXPENSE } from "./planner.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
// Loopback by default. On a public host keep this on loopback (or the private network)
// and let a reverse proxy own the public HTTPS listener.
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
// Geoapify free plan = 3,000 credits/day; one plan uses roughly 15–30 credits (less when cached).
const DAILY_PLAN_CAP = Number(process.env.DAILY_PLAN_CAP || 100);
const TRUST_PROXY = process.env.TRUST_PROXY || ""; // e.g. "1" when behind one proxy
const MAX_DAYS = 21;

// Map tiles. OpenStreetMap's own tile servers are fine for development and light use;
// for a busy public site switch to a tile provider.
const TILE_URL = process.env.MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = process.env.MAP_TILE_ATTRIBUTION || "&copy; OpenStreetMap contributors";
const TILE_ORIGIN = new URL(TILE_URL.replace(/\{[a-z]\}/g, "a")).origin;

const FOOD = ["Vegetarian", "Non-Vegetarian", "Both"];

// ---------- Validation ----------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanText = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, "").trim() : "");

function validate(body) {
  const b = body || {};
  const origin = cleanText(b.origin);
  const destination = cleanText(b.destination);
  const { startDate, endDate, expense, food } = b;
  const adults = Number(b.adults);
  const children = Number(b.children ?? 0);

  if (origin.length < 2 || origin.length > 80) return { error: "Enter a valid departure city." };
  if (destination.length < 2 || destination.length > 80) return { error: "Enter a valid destination." };
  if (!ISO.test(startDate || "") || !ISO.test(endDate || "")) return { error: "Invalid dates." };
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  if (isNaN(start) || isNaN(end)) return { error: "Invalid dates." };
  const yesterday = new Date(Date.now() - 36 * 3600e3); // tolerate visitor time zones
  if (start < yesterday) return { error: "Start date can't be in the past." };
  const days = Math.round((end - start) / 86400e3) + 1;
  if (days < 1) return { error: "End date must be on or after start date." };
  if (days > MAX_DAYS) return { error: `Trips up to ${MAX_DAYS} days are supported.` };
  if (!EXPENSE[expense]) return { error: "Choose an expense level." };
  if (!FOOD.includes(food)) return { error: "Choose a food preference." };
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) return { error: "Adults must be 1–9." };
  if (!Number.isInteger(children) || children < 0 || children > 8) return { error: "Children must be 0–8." };

  return { trip: { origin, destination, startDate, endDate, days, nights: days - 1, expense, food, adults, children } };
}

// ---------- Currency (INR base, ECB rates via Frankfurter) ----------
let ratesCache = { at: 0, data: null };
async function getRates() {
  if (ratesCache.data && Date.now() - ratesCache.at < 6 * 3600e3) return ratesCache.data;
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=INR", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`rates ${res.status}`);
  const json = await res.json();
  ratesCache = { at: Date.now(), data: { date: json.date, rates: { INR: 1, ...json.rates } } };
  return ratesCache.data;
}

// ---------- App ----------
const app = express();
if (TRUST_PROXY) app.set("trust proxy", Number(TRUST_PROXY) || TRUST_PROXY);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://images.unsplash.com ${TILE_ORIGIN} data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/leaflet", express.static(path.join(here, "node_modules/leaflet/dist")));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.get("/api/config", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600").json({ tileUrl: TILE_URL, tileAttribution: TILE_ATTRIBUTION });
});

const planLimiter = [
  rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Please wait a minute." } }),
  rateLimit({ windowMs: 24 * 3600e3, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Daily limit reached. Please come back tomorrow." } }),
];

let daily = { day: "", count: 0 };
function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  return daily.count < DAILY_PLAN_CAP;
}

app.post("/api/plan", planLimiter, async (req, res) => {
  const { trip, error } = validate(req.body);
  if (error) return res.status(400).json({ error });
  if (!underDailyCap()) return res.status(503).json({ error: "Wanderly is very busy today. Please try again tomorrow." });
  daily.count++;

  try {
    res.json(await buildPlan(trip));
  } catch (e) {
    console.error("plan failed:", e.message);
    res.status(e.publicMessage ? 422 : 502).json({ error: e.publicMessage || "Couldn't build your itinerary right now. Please try again." });
  }
});

app.get("/api/rates", async (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=3600").json(await getRates());
  } catch (e) {
    console.warn("rates failed:", e.message);
    res.status(502).json({ error: "Rates unavailable" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Wanderly running at http://${HOST}:${PORT}`);
  if (!hasDataKey()) console.warn("GEOAPIFY_API_KEY is not set: plans will fail. Get a free key at https://myprojects.geoapify.com and add it to .env.");
});
