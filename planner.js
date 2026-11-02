// Wanderly itinerary planner: free data only, no AI.
// Places come from OpenStreetMap through Geoapify's free plan; descriptions from Wikipedia;
// destination overviews from Wikivoyage. Days are planned by simple, explainable rules.

const GEO_KEY = process.env.GEOAPIFY_API_KEY || "";
// Optional: Google ratings. Needs a Google Cloud billing account (card); leave blank to stay free.
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
export const hasGoogle = () => Boolean(GOOGLE_KEY);
// Wikimedia asks API clients to identify themselves with contact details.
const UA = `Wanderly/1.0 (trip planner; ${process.env.CONTACT_EMAIL || "contact not set"})`;
export const hasDataKey = () => Boolean(GEO_KEY);

export const EXPENSE = {
  budget:   { label: "Budget",   transport: "public" },
  moderate: { label: "Moderate", transport: "public" },
  premium:  { label: "Premium",  transport: "private" },
};

const publicError = (msg, log) => Object.assign(new Error(log || msg), { publicMessage: msg });

// ---------- HTTP with a small 24 h cache (keeps us well inside the free quota) ----------
import fs from "node:fs";
const CACHE_FILE = process.env.CACHE_FILE || new URL("./.cache.json", import.meta.url).pathname;
const TTL = 24 * 3600e3;
const cache = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")))) if (Date.now() - v.at < TTL) cache.set(k, v);
} catch { /* no cache yet */ }
let saveTimer = null;
function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj = {};
    for (const [k, v] of cache) if (Date.now() - v.at < TTL && !k.includes("apiKey=")) obj[k] = v;
    fs.writeFile(CACHE_FILE, JSON.stringify(obj), () => {});
  }, 2000);
}

// Wikimedia asks API clients to send requests one at a time; queue them with a short gap.
let wikiQueue = Promise.resolve();
let releaseWiki = null;
function wikiTurn() {
  const prev = wikiQueue;
  let release;
  wikiQueue = new Promise((r) => (release = r));
  return prev.then(() => { releaseWiki = release; });
}
function wikiDone() { const r = releaseWiki; releaseWiki = null; setTimeout(() => r && r(), 150); }

async function getJSON(url, { headers = {}, timeout = 15000, cacheKey = url, attempt = 1, maxWait = 12000 } = {}) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const wiki = /wiki(pedia|voyage|data)\.org$/.test(new URL(url).host);
  if (wiki) await wikiTurn();
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  } finally { if (wiki) wikiDone(); }
  // Wikimedia and Geoapify answer 429 when we're too quick: back off and retry.
  if (res.status === 429 && attempt < 3) {
    const wait = (Number(res.headers.get("retry-after")) || attempt * 2) * 1000;
    if (wait > maxWait) throw Object.assign(new Error(`${new URL(url).host} 429`), { status: 429 });
    await new Promise((r) => setTimeout(r, wait));
    return getJSON(url, { headers, timeout, cacheKey, attempt: attempt + 1, maxWait });
  }
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: res.status });
  const data = await res.json();
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), data });
  saveCacheSoon();
  return data;
}

let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 220;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function geoapify(path, params, attempt = 1) {
  const url = new URL(`https://api.geoapify.com${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  const cacheKey = url.toString();
  url.searchParams.set("apiKey", GEO_KEY);
  try {
    if (!cache.has(cacheKey)) await throttle();
    return await getJSON(url.toString(), { cacheKey });
  } catch (e) {
    if (e.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1200 * attempt)); return geoapify(path, params, attempt + 1); }
    if (e.status === 401 || e.status === 403) throw publicError("The trip planner isn't set up correctly. Please try again later.", "Geoapify key missing or invalid. Set GEOAPIFY_API_KEY in .env and restart.");
    if (e.status === 429) throw publicError("The planner is busy right now. Please try again in a minute.", "Geoapify rate limit or daily quota reached.");
    throw e;
  }
}

// ---------- Geo helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}
const centroid = (pts) => ({ lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length });

// Ambiguous names ("Kochi": Kerala or Japan?) are resolved by comparing candidates from a
// general search and a city-only search, preferring well-known cities, states and countries,
// with a small nudge towards the traveller's own country.
const TYPE_BONUS = { country: 0.35, state: 0.3, city: 0.3, suburb: 0.1, county: 0.05, district: 0.05 };
async function geocode(text, preferCountry = "", { citiesOnly = false } = {}) {
  const filter = citiesOnly && preferCountry ? `countrycode:${preferCountry.toLowerCase()}` : null;
  const [general, cities] = await Promise.all([
    citiesOnly ? { results: [] } : geoapify("/v1/geocode/search", { text, format: "json", limit: 5, lang: "en" }),
    geoapify("/v1/geocode/search", { text, type: "city", filter, format: "json", limit: 5, lang: "en" }),
  ]);
  const candidates = [...(general.results || []), ...(cities.results || [])]
    .filter((r) => (r.rank?.confidence ?? 1) >= 0.8 && r.result_type in TYPE_BONUS);
  if (!candidates.length) return null;
  const score = (r) =>
    (r.rank?.importance ?? (r.rank?.popularity || 0) / 3) +
    TYPE_BONUS[r.result_type] +
    (preferCountry && (r.country_code || "").toUpperCase() === preferCountry ? 0.15 : 0);
  const r = candidates.sort((a, b) => score(b) - score(a))[0];
  return {
    name: r.city || r.name || r.state || r.country || text,
    type: r.result_type,
    lat: r.lat, lon: r.lon,
    placeId: r.place_id,
    countryCode: (r.country_code || "").toUpperCase(),
    country: r.country,
    importance: r.rank?.importance ?? (r.rank?.popularity || 0) / 3,
  };
}

// Placeholder names mappers sometimes leave ("mosque", "restaurent", "Fast food").
const GENERIC = /^(the )?(mosque|masjid|temple|pura|wat|kuil|mandir|gurudwara|church|chapel|shrine|restaurant|restaurent|restaaurent|hotel|cafe|café|fast ?food|food|bakery|lodge|museum|park|garden|statue|memorial|monument|attraction|viewpoint|beach|tea shop|tea stall|canteen|mess|dhaba|bar|pub)s?$/i;
const isJunkName = (n) => n.length < 3 || GENERIC.test(n.trim()) || (/^[a-z0-9 .'-]+$/.test(n) && !/[A-Z]/.test(n) && n.split(" ").length <= 2);
const BAD_STAY = /rest(ing)? ?ro+m|retiring room|dormitory|girls only|ladies only|boys only|gents only|paying guest|\bpg\b|hostel for (men|women|boys|girls)|working (women|men)/i;

async function places({ categories, conditions, filter, bias, limit }) {
  const data = await geoapify("/v2/places", { categories, conditions, filter, bias, limit, lang: "en" });
  const seen = new Set();
  return (data.features || [])
    .map((f) => {
      const p = f.properties || {};
      const raw = p.datasource?.raw || {};
      const pick = raw["name:en"] || p.name;
      return { ...p, name: typeof pick === "string" ? pick.trim() : pick != null ? String(pick) : "" };
    })
    .filter((p) => p.name && !isJunkName(p.name) && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()))
    .map((p) => ({
      id: p.place_id,
      name: p.name,
      lat: p.lat, lon: p.lon,
      cats: p.categories || [],
      raw: p.datasource?.raw || {},
      address: p.address_line2 || p.formatted || "",
      city: p.city || null,
      countryCode: (p.country_code || "").toUpperCase(),
      area: p.suburb || p.district || p.quarter || p.city || null,
    }));
}

const STOP = new Set(["the", "and", "palace", "museum", "temple", "church", "complex", "fort", "park", "of", "st", "saint", "old", "new"]);
const words = (n) => new Set(n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
// ---------- Free text sources ----------
const firstSentences = (text, n = 2) => (text || "").split(/(?<=[.!?])\s+/).slice(0, n).join(" ");

// Short intros for many articles at once (20 per request, the API's limit for extracts).
async function wikiSummaries(tags) {
  const out = new Map();
  const byLang = new Map();
  for (const t of new Set(tags)) {
    const m = /^([a-z-]{2,12}):(.+)$/.exec(t || "");
    if (m) { if (!byLang.has(m[1])) byLang.set(m[1], []); byLang.get(m[1]).push(m[2]); }
  }
  for (const [lang, titles] of byLang) {
    for (let i = 0; i < titles.length; i += 20) {
      try {
        const chunk = titles.slice(i, i + 20);
        const d = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exsentences=2&exlimit=20&titles=${encodeURIComponent(chunk.join("|"))}`, { timeout: 10000, maxWait: 3000 });
        const back = new Map();
        for (const x of d.query?.normalized || []) back.set(x.to, x.from);
        for (const r of d.query?.redirects || []) back.set(r.to, back.get(r.from) || r.from);
        for (const pg of d.query?.pages || []) {
          if (!pg.extract) continue;
          const v = { text: firstSentences(pg.extract), url: pg.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pg.title)}` };
          out.set(`${lang}:${back.get(pg.title) || pg.title}`, v);
          out.set(`${lang}:${pg.title}`, v);
        }
      } catch { /* descriptions are optional */ }
    }
  }
  return out;
}

async function wikivoyageSummary(name) {
  try {
    const d = await getJSON(`https://en.wikivoyage.org/api/rest_v1/page/summary/${encodeURIComponent(name.replaceAll(" ", "_"))}`, { timeout: 6000 });
    return d.type === "standard" ? firstSentences(d.extract, 2) : null;
  } catch { return null; }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

// Wikipedia articles geotagged near a point, with their short descriptions
// ("Nature park in Singapore"): a free "is this place famous, and what is it?" signal.
async function wikiNearby(pt) {
  const base = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=geosearch&ggscoord=${pt.lat.toFixed(4)}|${pt.lon.toFixed(4)}&ggsradius=10000&ggslimit=500&prop=description|coordinates&colimit=500`;
  const out = new Map();
  let cont = "";
  try {
    for (let n = 0; n < 4; n++) {
      const d = await getJSON(base + cont, { timeout: 10000 });
      for (const pg of d.query?.pages || []) {
        const cur = out.get(pg.pageid) || { title: pg.title };
        if (pg.description) cur.desc = pg.description;
        if (pg.coordinates?.[0]) { cur.lat = pg.coordinates[0].lat; cur.lon = pg.coordinates[0].lon; }
        out.set(pg.pageid, cur);
      }
      if (!d.continue) break;
      cont = "&" + new URLSearchParams(d.continue).toString();
    }
  } catch { /* optional */ }
  return [...out.values()].filter((a) => a.lat != null);
}

// Which nearby articles are visitor landmarks, judged by their description.
const LANDMARK = /\b(park|garden|gardens|museum|gallery|tower|temple|church|cathedral|basilica|mosque|synagogue|shrine|palace|fort|fortress|castle|monument|landmark|attraction|zoo|aquarium|beach|bridge|square|market|food centre|hawker|observation|ferris|wheel|resort|island|statue|theatre|theater|opera|arts cent(er|re)|ruins|archaeological|heritage|viewpoint|waterfront|promenade|lake|waterfall|hill|nature reserve|sanctuary|amusement|theme park|cable car|lighthouse|mausoleum|tomb|monastery|abbey|neighbou?rhood|historic district|shopping district|old town|quarter|convent|boulevard|esplanade)\b/i;
const NOT_LANDMARK = /\b(station|school|college|university|hospital|company|office|agency|authority|ministry|bank|embassy|hotel|condominium|apartment|residential|skyscraper|highway|expressway|airport|constituency|planning area|subzone|ward|electoral|riot|bombing|accident|collapse|attack|season|grand prix|race|election|list of|colony|history of|future|stadium|headquarters|cemetery|prison|barracks|depot|power station|reservoir|dam|parish|diocese|former)\b/i;
const isLandmark = (a) => Boolean(a.desc) && LANDMARK.test(a.desc) && !NOT_LANDMARK.test(a.desc);

// Pseudo-categories for Wikipedia-only landmarks, so labels and scheduling rules still apply.
function catsFromDesc(desc) {
  const d = desc.toLowerCase(), c = ["wikipedia"];
  if (/theme park|amusement park/.test(d)) c.push("entertainment.theme_park");
  else if (/water park/.test(d)) c.push("entertainment.water_park");
  if (/museum/.test(d)) c.push("entertainment.museum");
  if (/gallery|arts cent/.test(d)) c.push("entertainment.culture.gallery");
  if (/zoo/.test(d)) c.push("entertainment.zoo");
  if (/aquarium/.test(d)) c.push("entertainment.aquarium");
  if (/temple/.test(d)) c.push("religion.place_of_worship.temple");
  if (/cathedral|basilica/.test(d)) c.push("religion.place_of_worship.cathedral");
  if (/church|convent/.test(d)) c.push("religion.place_of_worship.church");
  if (/mosque/.test(d)) c.push("religion.place_of_worship.mosque");
  if (/fort|castle|palace|fortress/.test(d)) c.push("tourism.sights.castle");
  if (/tower|observation|ferris|wheel|viewpoint|hill/.test(d)) c.push("tourism.attraction.viewpoint");
  if (/beach/.test(d)) c.push("beach");
  if (/market|food centre|hawker/.test(d)) c.push("commercial.marketplace");
  if (/park|garden|nature|sanctuary/.test(d)) c.push("leisure.park");
  if (/ruins|archaeological/.test(d)) c.push("tourism.sights.ruines");
  if (c.length === 1) c.push("tourism.attraction");
  return c;
}
const cleanTitle = (t, city) => t.replace(/\s*\([^)]*\)\s*$/, "").replace(new RegExp(`,\\s*(${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`, "i"), "").trim();

function markFamous(sights, articles, cityName) {
  const cityWords = words(cityName);
  const arts = articles.map((a) => ({ ...a, ws: new Set([...words(a.title.replace(/\(.*?\)/g, ""))].filter((w) => !cityWords.has(w))) }));
  for (const s of sights) {
    const sw = new Set([...words(s.name)].filter((w) => !cityWords.has(w)));
    if (!sw.size) continue;
    for (const a of arts) {
      if (!a.ws.size || km(s, a) > 1.5) continue;
      const shared = [...sw].filter((w) => a.ws.has(w)).length;
      // Most of the article's distinctive words must match too ("vue Marina Bay" ≠ "PARKROYAL COLLECTION Marina Bay").
      if (shared >= Math.min(2, sw.size, a.ws.size) && shared / a.ws.size >= 0.5) {
        s.famous = true;
        if (!s.raw.wikipedia) s.raw = { ...s.raw, wikipedia: `en:${a.title}` };
        break;
      }
    }
  }
  return sights;
}

// ---------- Popularity: Wikipedia readers in the last 30 days (free) ----------
async function wikiViews(tags) {
  const byLang = new Map();
  for (const t of new Set(tags)) {
    const m = /^([a-z-]{2,12}):(.+)$/.exec(t || "");
    if (!m) continue;
    if (!byLang.has(m[1])) byLang.set(m[1], []);
    byLang.get(m[1]).push(m[2]);
  }
  const out = new Map();
  for (const [lang, titles] of byLang) {
    for (let i = 0; i < titles.length; i += 50) {
      try {
        const chunk = titles.slice(i, i + 50);
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageviews&pvipdays=30&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(chunk.join("|"))}`;
        let cont = "";
        for (let n = 0; n < 4; n++) {
          const d = await getJSON(url + cont, { timeout: 10000 });
          // Map normalised / redirected titles back to the title we asked for.
          const back = new Map();
          for (const x of d.query?.normalized || []) back.set(x.to, x.from);
          for (const r of d.query?.redirects || []) back.set(r.to, back.get(r.from) || r.from);
          for (const pg of d.query?.pages || []) {
            if (!pg.pageviews) continue; // arrives in a later continuation batch
            const total = Object.values(pg.pageviews).reduce((a, b) => a + (b || 0), 0);
            out.set(`${lang}:${back.get(pg.title) || pg.title}`, total);
            out.set(`${lang}:${pg.title}`, total);
          }
          if (!d.continue) break;
          cont = "&" + new URLSearchParams(d.continue).toString();
        }
      } catch (e) {
        if (!titles._retried) { titles._retried = true; i -= 50; continue; } // one retry
        console.warn("Wikipedia pageviews failed:", e.message);
      }
    }
  }
  return out;
}

// Places tagged only with a Wikidata id (e.g. Universal Studios Singapore): look up the article.
async function wikidataTitles(ids) {
  const out = new Map();
  const list = [...new Set(ids)].filter((q) => /^Q\d+$/.test(q));
  for (let i = 0; i < list.length; i += 50) {
    try {
      const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${list.slice(i, i + 50).join("|")}&props=sitelinks&sitefilter=enwiki&format=json`, { timeout: 10000 });
      for (const [q, e] of Object.entries(d.entities || {})) if (e.sitelinks?.enwiki?.title) out.set(q, `en:${e.sitelinks.enwiki.title}`);
    } catch { /* optional */ }
  }
  return out;
}

// ---------- Optional Google ratings (only when GOOGLE_PLACES_API_KEY is set) ----------
async function googleRating(name, pt) {
  const cacheKey = `google:${name}:${pt.lat.toFixed(3)},${pt.lon.toFixed(3)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let data = null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "places.rating,places.userRatingCount,places.googleMapsUri,places.location" },
      body: JSON.stringify({ textQuery: name, maxResultCount: 1, locationBias: { circle: { center: { latitude: pt.lat, longitude: pt.lon }, radius: 1500 } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const g = (await res.json()).places?.[0];
      if (g?.location && km(pt, { lat: g.location.latitude, lon: g.location.longitude }) < 1 && g.rating)
        data = { rating: g.rating, reviews: g.userRatingCount || 0, url: g.googleMapsUri || null };
    } else console.warn("Google Places", res.status);
  } catch (e) { console.warn("Google Places failed:", e.message); }
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}
// Rating weighted by review count, so 4.6★ from 20k reviews beats 5★ from 3.
const googleBonus = (g) => (g ? ((g.reviews * g.rating + 200 * 4.2) / (g.reviews + 200) - 4.2) * 6 + Math.log10(g.reviews + 1) : 0);

// ---------- Scoring rules ----------
const SIGHT_CATS = "tourism.sights,tourism.attraction,heritage,building.historic,religion.place_of_worship,beach,national_park,entertainment.museum,entertainment.culture.gallery,entertainment.zoo,entertainment.aquarium,entertainment.theme_park";
// Big-ticket attractions are fetched city-wide so central clutter can't crowd them out.
const HEADLINE_CATS = "entertainment.theme_park,entertainment.water_park,entertainment.zoo,entertainment.aquarium,heritage.unesco,national_park";
const isFullDay = (s) => /theme_park|water_park/.test(s.cats.join(" ")) && Boolean(s.raw.wikidata || s.raw.wikipedia || s.famous) && (s.views || 0) >= (s.withKids ? 2000 : 5000);
const TRANSIT_CATS = "public_transport.subway,public_transport.train,public_transport.light_rail,public_transport.tram,public_transport.ferry";
const STAY_CATS = "accommodation.hotel,accommodation.hostel,accommodation.guest_house,accommodation.motel";
const FOOD_CATS = {
  budget: "catering.restaurant,catering.fast_food,catering.cafe,catering.food_court",
  moderate: "catering.restaurant,catering.cafe",
  premium: "catering.restaurant",
};

// Priority = popularity first. Score is mostly log(Wikipedia readers in 30 days); the place type
// only breaks ties. Unknown readership: assume a modest default (300 with an article, 20 without).
function sightScore(s, withKids = false) {
  const c = s.cats.join(" "), r = s.raw;
  const hasArticle = Boolean(r.wikipedia || r.wikidata || s.famous);
  const borrowed = /memorial|artwork|plaque|statue|bust|boundary_stone/.test(c) || s.name.length > 60;
  const V = s.views > 0 && !borrowed ? s.views : hasArticle ? 300 : 20;
  let sc = 3 * Math.log10(V + 1);
  if (c.includes("heritage.unesco")) sc += 2;
  if (/entertainment\.(museum|zoo|aquarium|theme_park)|sights\.(castle|fort|monastery|archaeological_site|ruines|tower|lighthouse|manor|city_gate)|place_of_worship\.(cathedral|temple|mosque|synagogue)|viewpoint|national_park/.test(c)) sc += 1;
  if (withKids && /theme_park|water_park|zoo|aquarium/.test(c)) sc += 1.5;
  if (/artwork|clock|fountain|milestone|boundary_stone|wayside_cross|pillory|information|subway|platform/.test(c)) sc -= 4;
  if (/religion\.place_of_worship/.test(c) && !hasArticle && !/building\.historic|heritage/.test(c)) sc -= 3;
  if (/building\.historic/.test(c) && !/tourism\.|heritage|entertainment\.|religion\./.test(c)) sc -= 3;
  if (/sights\.manor/.test(c)) sc -= 4; // townhouses/mansions: listed buildings, rarely worth a visit slot
  if (s.google) sc += googleBonus(s.google);
  return sc;
}

function hotelInfo(h, tier) {
  const c = h.cats.join(" ");
  const stars = parseFloat(h.raw.stars) || null;
  let sc = 0;
  if (tier === "budget") { if (/hostel|guest_house/.test(c)) sc += 3; if (stars && stars <= 2) sc += 2; if (stars >= 4) sc -= 4; }
  if (tier === "moderate") { if (/accommodation\.hotel/.test(c)) sc += 1; if (stars === 3) sc += 3; if (stars >= 5) sc -= 2; if (/hostel/.test(c)) sc -= 3; }
  if (tier === "premium") { if (stars >= 4) sc += 4 + (stars - 4); if (/hostel|guest_house|motel/.test(c)) sc -= 5; if (!stars) sc -= 1; }
  if (h.raw.website) sc += 1;
  if (h.raw.wikidata) sc += 1;
  const type = /hostel/.test(c) ? "Hostel" : /guest_house/.test(c) ? "Guest house" : /motel/.test(c) ? "Motel" : "Hotel";
  return { sc, stars, type };
}

function foodInfo(f) {
  const r = f.raw;
  let sc = 0;
  if (r.wikidata) sc += 2;
  if (r.website) sc += 1;
  if (r.cuisine) sc += 1;
  if (r.opening_hours) sc += 0.5;
  const catCuisine = f.cats.find((c) => c.startsWith("catering.restaurant."))?.split(".").pop();
  const cuisine = (r.cuisine || catCuisine || (f.cats.some((c) => c.startsWith("catering.cafe")) ? "cafe" : f.cats.some((c) => c.startsWith("catering.fast_food")) ? "quick bites" : "restaurant"))
    .split(";").slice(0, 2).join(", ").replaceAll("_", " ");
  const veg = r["diet:vegetarian"] === "yes" || r["diet:vegetarian"] === "only" || f.cats.some((c) => c.startsWith("vegetarian"));
  return { sc, cuisine: cuisine[0].toUpperCase() + cuisine.slice(1), veg, vegOnly: r["diet:vegetarian"] === "only" || f.cats.includes("vegetarian.only") };
}

const CAT_LABEL = [
  [/heritage\.unesco/, "UNESCO World Heritage site"], [/entertainment\.museum/, "Museum"], [/culture\.gallery/, "Art gallery"],
  [/sights\.fort/, "Historic fort"], [/sights\.castle/, "Castle"], [/sights\.monastery/, "Monastery"],
  [/place_of_worship\.temple/, "Temple"], [/place_of_worship\.cathedral/, "Cathedral"], [/place_of_worship\.mosque/, "Mosque"],
  [/place_of_worship\.church/, "Church"], [/place_of_worship\.synagogue/, "Synagogue"], [/place_of_worship/, "Place of worship"],
  [/sights\.archaeological_site|sights\.ruines/, "Historic ruins"], [/sights\.memorial/, "Memorial"], [/sights\.lighthouse/, "Lighthouse"],
  [/sights\.tower/, "Tower"], [/viewpoint/, "Viewpoint"], [/entertainment\.zoo/, "Zoo"], [/entertainment\.aquarium/, "Aquarium"],
  [/theme_park/, "Theme park"], [/sights\.bridge/, "Landmark bridge"], [/tourism\.sights/, "Landmark"], [/tourism\.attraction/, "Attraction"],
];
const labelFor = (cats) => CAT_LABEL.find(([re]) => re.test(cats.join(" ")))?.[1] || "Attraction";
const isEvening = (s) => /\bnight\b/i.test(s.name) || /viewpoint|marketplace|sights\.bridge|lighthouse/.test(s.cats.join(" "));

function transitLabel(t) {
  const c = t.cats.join(" ");
  if (/subway/.test(c)) return "Metro";
  if (/light_rail|tram/.test(c)) return "Tram/light rail";
  if (/ferry/.test(c)) return "Ferry";
  return "Train";
}

// ---------- Cost tables (INR, rough) ----------
const HIGH_COST = new Set("CH NO IS DK SE FI US GB IE AU NZ SG JP FR DE NL BE LU AT IL CA HK QA".split(" "));
const LOW_COST = new Set("IN NP LK BD PK TH VN ID KH LA MM PH EG MA KE TZ BT".split(" "));
const levelOf = (cc) => (HIGH_COST.has(cc) ? "high" : LOW_COST.has(cc) ? "low" : "mid");
const COST = {
  hotel:      { low: { budget: 1200, moderate: 3500, premium: 12000 }, mid: { budget: 2500, moderate: 7000, premium: 20000 }, high: { budget: 4500, moderate: 12000, premium: 32000 } },
  food:       { low: { budget: 600,  moderate: 1500, premium: 4000 },  mid: { budget: 1500, moderate: 3000, premium: 8000 },  high: { budget: 2500, moderate: 5000, premium: 12000 } },
  activities: { low: { budget: 300,  moderate: 800,  premium: 2500 },  mid: { budget: 800,  moderate: 1600, premium: 4500 },  high: { budget: 1500, moderate: 2800, premium: 7000 } },
  transit:    { low: { budget: 200,  moderate: 400,  premium: 3000 },  mid: { budget: 500,  moderate: 900,  premium: 6000 },  high: { budget: 900,  moderate: 1500, premium: 9000 } },
  fare:       { low: "₹20–60", mid: "₹80–250", high: "₹250–600" },
};
function flightEstimate(distKm, sameCountry) {
  const oneWay = sameCountry ? 1800 + 4.2 * distKm : 3500 + 5.2 * distKm;
  return Math.round((2 * oneWay) / 100) * 100;
}

// ---------- Links (pre-filled searches; affiliate templates applied if configured) ----------
const enc = encodeURIComponent;
const AFFILIATE = {
  skyscanner: process.env.SKYSCANNER_LINK_TEMPLATE || "",
  makemytrip: process.env.MAKEMYTRIP_LINK_TEMPLATE || "",
  booking: process.env.BOOKING_LINK_TEMPLATE || "",
  klook: process.env.KLOOK_LINK_TEMPLATE || "",
};
function partnerLink(partner, url) {
  const tpl = AFFILIATE[partner];
  if (!tpl) return { url, sponsored: false };
  return { url: tpl.replaceAll("{url}", enc(url)).replaceAll("{rawurl}", url), sponsored: true };
}
const yymmdd = (iso) => iso.slice(2).replaceAll("-", "");
const ddmmyyyy = (iso) => iso.split("-").reverse().join("/");
const bookingSearch = (trip, query, rooms, checkin = trip.startDate, checkout = trip.endDate) =>
  partnerLink("booking", `https://www.booking.com/searchresults.html?ss=${enc(query)}&checkin=${checkin}&checkout=${checkout}&group_adults=${trip.adults}&group_children=${trip.children}&no_rooms=${rooms}`);
const klookSearch = (q) => partnerLink("klook", `https://www.klook.com/en-IN/search/result/?query=${enc(q)}`);
const mapsLink = (p) => `https://www.google.com/maps/search/?api=1&query=${enc(`${p.name}, ${p.lat},${p.lon}`)}`;
const rome2rio = (from, to) => `https://www.rome2rio.com/map/${enc(from)}/${enc(to)}`;
const IATA = /^[A-Z]{3}$/;

function flightLinks(trip, o, d) {
  const pax = trip.adults + trip.children;
  const links = [];
  if (IATA.test(o.code || "") && IATA.test(d.code || "")) {
    links.push(
      { label: "Skyscanner", ...partnerLink("skyscanner", `https://www.skyscanner.co.in/transport/flights/${o.code.toLowerCase()}/${d.code.toLowerCase()}/${yymmdd(trip.startDate)}/${yymmdd(trip.endDate)}/?adultsv2=${trip.adults}`) },
      { label: "MakeMyTrip", ...partnerLink("makemytrip", `https://www.makemytrip.com/flight/search?itinerary=${o.code}-${d.code}-${ddmmyyyy(trip.startDate)}_${d.code}-${o.code}-${ddmmyyyy(trip.endDate)}&tripType=R&paxType=A-${trip.adults}_C-${trip.children}_I-0&cabinClass=E`) },
    );
  }
  links.push({ label: "Google Flights", url: `https://www.google.com/travel/flights?q=${enc(`Flights from ${o.code || o.city} to ${d.code || d.city} on ${trip.startDate} returning ${trip.endDate} for ${pax} passengers`)}`, sponsored: false });
  return links;
}

async function nearestAirport(pt) {
  const list = await places({ categories: "airport.international", filter: `circle:${pt.lon},${pt.lat},150000`, bias: `proximity:${pt.lon},${pt.lat}`, limit: 5 });
  const withCode = list.filter((a) => IATA.test(a.raw.iata || ""));
  // Prefer airports OpenStreetMap marks as international/public (CDG/Orly over Le Bourget),
  // then the longest-established one (lowest Wikidata number) within 60 km.
  const qnum = (a) => Number((a.raw.wikidata || "Q999999999").slice(1));
  const major = withCode.filter((a) => a.raw.aerodrome === "international" || ["international", "public"].includes(a.raw["aerodrome:type"]));
  const isMajor = (a) => major.includes(a);
  const near = withCode.filter((a) => km(pt, a) <= 60).sort((x, y) => (isMajor(y) - isMajor(x)) || (qnum(x) - qnum(y)));
  const a = near[0] || withCode[0] || list[0];
  return a ? { code: a.raw.iata || "", name: a.name, lat: a.lat, lon: a.lon } : null;
}

// ---------- Destination → cities ----------
const REGION_TYPES = new Set(["country", "state"]);

async function chooseCities(dest, days) {
  if (!REGION_TYPES.has(dest.type)) {
    return [{ name: dest.name, lat: dest.lat, lon: dest.lon, countryCode: dest.countryCode, filter: dest.placeId ? `place:${dest.placeId}` : `circle:${dest.lon},${dest.lat},10000` }];
  }
  const want = days <= 3 ? 1 : days <= 6 ? 2 : days <= 10 ? 3 : 4;
  // 1) Wikivoyage's curated "Cities" list for the country/state, ranked by how well known each city is.
  const listed = await wikivoyageCities(dest.name);
  if (listed.length) {
    const found = (await mapLimit(listed.slice(0, 12), 4, (n) => geocode(n, dest.countryCode, { citiesOnly: true }).catch(() => null)))
      .filter((c) => c && c.countryCode === dest.countryCode && c.placeId)
      .sort((a, b) => b.importance - a.importance);
    // Greedy: best-known city first, then well-known cities that aren't too far from the others
    // (Kyoto beats far-off Sapporo for a Tokyo trip), at least 35 km apart.
    const chosen = [];
    const left = [...found];
    while (chosen.length < want && left.length) {
      const val = (c) => c.importance - (chosen.length ? 0.0001 * Math.min(...chosen.map((x) => km(x, c))) : 0);
      left.sort((a, b) => val(b) - val(a));
      const c = left.shift();
      if (chosen.every((x) => km(x, c) > 35)) chosen.push({ name: c.name, lat: c.lat, lon: c.lon, countryCode: dest.countryCode, filter: `place:${c.placeId}` });
    }
    if (chosen.length) return orderRoute(chosen);
  }
  // 2) Fallback: the cities with the most notable sights.
  const sights = await places({ categories: "heritage,tourism.sights,entertainment.museum,tourism.attraction", filter: `place:${dest.placeId}`, limit: 300 });
  const byCity = new Map();
  for (const s of sights) {
    if (!s.city || sightScore(s) < 7) continue; // needs a Wikipedia article
    if (!byCity.has(s.city)) byCity.set(s.city, []);
    byCity.get(s.city).push(s);
  }
  const ranked = [...byCity.entries()].map(([name, list]) => ({ name, list, score: list.reduce((a, s) => a + sightScore(s), 0) })).sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of ranked) {
    const ctr = centroid(c.list);
    if (chosen.every((x) => km(x, ctr) > 60)) chosen.push({ name: c.name, ...ctr, countryCode: dest.countryCode, filter: `circle:${ctr.lon},${ctr.lat},12000` });
    if (chosen.length === want) break;
  }
  if (!chosen.length) chosen.push({ name: dest.name, lat: dest.lat, lon: dest.lon, countryCode: dest.countryCode, filter: `circle:${dest.lon},${dest.lat},15000` });
  return orderRoute(chosen);
}

// Visit in a sensible order: start at the best-known city, then nearest-neighbour.
function orderRoute(chosen) {
  const left = [...chosen];
  const ordered = [left.shift()];
  while (left.length) {
    const last = ordered.at(-1);
    left.sort((a, b) => km(last, a) - km(last, b));
    ordered.push(left.shift());
  }
  return ordered;
}

async function wikivoyageCities(page, attempt = 1) {
  try {
    const api = "https://en.wikivoyage.org/w/api.php?format=json&redirects=1&action=parse&page=" + encodeURIComponent(page);
    const secs = (await getJSON(`${api}&prop=sections`, { timeout: 8000 })).parse?.sections || [];
    const sec = secs.find((x) => /^(cities|cities and towns|cities & towns|towns)$/i.test(x.line.trim()));
    if (!sec) return [];
    const wt = (await getJSON(`${api}&prop=wikitext&section=${sec.index}`, { timeout: 8000 })).parse?.wikitext?.["*"] || "";
    const fromMarkers = [...wt.matchAll(/\{\{\s*marker[^}]*?name\s*=\s*\[\[([^\]|#]+)/gi)].map((m) => m[1].trim());
    const fromList = [...wt.matchAll(/^\*\s*\[\[([^\]|#]+)/gm)].map((m) => m[1].trim());
    return [...new Set(fromMarkers.length ? fromMarkers : fromList)];
  } catch { return attempt < 2 ? wikivoyageCities(page, attempt + 1) : []; }
}

async function cityData(city, trip) {
  const bias = `proximity:${city.lon},${city.lat}`;
  const veg = trip.food === "Vegetarian";
  const [sights0, headline, food0, stays, transit, articles] = await Promise.all([
    places({ categories: SIGHT_CATS, filter: city.filter, bias, limit: 200 }),
    // City-wide radius, not the official boundary (Singapore's excludes Sentosa and the Zoo).
    places({ categories: HEADLINE_CATS, filter: `circle:${city.lon},${city.lat},25000`, bias, limit: 80 }),
    places({ categories: FOOD_CATS[trip.expense], conditions: veg ? "vegetarian" : null, filter: city.filter, bias, limit: 100 }),
    trip.nights > 0 ? places({ categories: STAY_CATS, filter: city.filter, bias, limit: 60 }) : [],
    EXPENSE[trip.expense].transport === "public" ? places({ categories: TRANSIT_CATS, filter: city.filter, bias, limit: 60 }) : [],
    wikiNearby(city).then(async (arts) => {
      if (arts.length < 450) return arts;
      // Dense city (Paris, Tokyo): the 500 nearest articles cover ~1–2 km, so sample 4 more points ~4 km out.
      const dLat = 0.036, dLon = 0.036 / Math.cos(toRad(city.lat));
      const more = await mapLimit([[dLat, 0], [-dLat, 0], [0, dLon], [0, -dLon]], 2, ([a, b]) => wikiNearby({ lat: city.lat + a, lon: city.lon + b }));
      const seen = new Set(arts.map((x) => x.title));
      return arts.concat(more.flat().filter((x) => !seen.has(x.title) && seen.add(x.title)));
    }),
  ]);
  // Merge, and stay inside the destination country (no Legoland Malaysia on a Singapore trip).
  const byName = new Map();
  for (const x of [...headline, ...sights0]) if (!byName.has(x.name.toLowerCase())) byName.set(x.name.toLowerCase(), x);
  const sights = [...byName.values()].filter((x) => !city.countryCode || !x.countryCode || x.countryCode === city.countryCode);
  markFamous(sights, articles, city.name);
  // Landmarks that OpenStreetMap search missed (Marina Bay Sands, Gardens by the Bay, the Louvre…).
  const have = new Set(sights.map((x) => x.raw.wikipedia).filter(Boolean));
  const extra = articles
    .filter((a) => isLandmark(a) && !have.has(`en:${a.title}`) && a.title.toLowerCase() !== city.name.toLowerCase())
    .slice(0, 300)
    .map((a) => ({
      id: `wp:${a.title}`, name: cleanTitle(a.title, city.name), lat: a.lat, lon: a.lon,
      cats: catsFromDesc(a.desc), raw: { wikipedia: `en:${a.title}`, description: a.desc }, famous: true,
      area_like: /neighbou?rhood|district|quarter|old town|boulevard/i.test(a.desc),
      address: "", city: city.name, countryCode: city.countryCode || "", area: null,
    }));
  sights.push(...extra);
  const wd = await wikidataTitles(sights.filter((x) => !x.raw.wikipedia && x.raw.wikidata).map((x) => x.raw.wikidata));
  for (const x of sights) if (!x.raw.wikipedia && wd.has(x.raw.wikidata)) x.raw = { ...x.raw, wikipedia: wd.get(x.raw.wikidata) };
  // Readership for the strongest ~60 mapped places plus ~60 Wikipedia-only landmarks (both kinds compete).
  const byScore = (a, b) => sightScore(b, trip.children > 0) - sightScore(a, trip.children > 0);
  const tagged = sights.filter((x) => x.raw.wikipedia);
  const strongest = [...tagged.filter((x) => !x.id.startsWith("wp:")).sort(byScore).slice(0, 60), ...tagged.filter((x) => x.id.startsWith("wp:")).slice(0, 60)];
  const views = await wikiViews(strongest.map((x) => x.raw.wikipedia));
  for (const x of sights) x.views = views.get(x.raw.wikipedia) || 0;
  // Closed/demolished parks ("Gay World Amusement Park") still have articles; check the intro.
  const parkCands = sights.filter((x) => /theme_park|water_park/.test(x.cats.join(" ")) && x.raw.wikipedia && (x.views || 0) >= 2000);
  if (parkCands.length) {
    const intros = await wikiSummaries(parkCands.map((x) => x.raw.wikipedia));
    for (const x of parkCands) {
      const t = intros.get(x.raw.wikipedia)?.text || "";
      if (/\b(was|were) (an?|the)\b/i.test(t.split(". ")[0]) || /\b(closed|demolished|defunct|ceased operations)\b/i.test(t)) x.closed = true;
    }
  }
  if (GOOGLE_KEY) {
    // Rate the 20 strongest candidates only, to stay inside Google's free monthly allowance.
    const top = sights.map((x) => ({ x, sc: sightScore(x, trip.children > 0) })).sort((a, b) => b.sc - a.sc).slice(0, 20).map((o) => o.x);
    await mapLimit(top, 4, async (x) => { x.google = await googleRating(`${x.name}, ${city.name}`, x); });
  }
  const local = (list, r = 30) => list.filter((x) => km(city, x) <= r);
  let food = local(food0), vegFallback = false;
  if (veg && food.length < 6) {
    food = food.concat(local(await places({ categories: FOOD_CATS[trip.expense], filter: city.filter, bias, limit: 60 })));
    vegFallback = true;
  }
  if (trip.food === "Non-Vegetarian") food = food.filter((f) => !foodInfo(f).vegOnly);
  return {
    sights: dropMinorParts(dropInsideParks(dedupeSights(local(sights).filter((x) => !x.closed && (!x.area_like || (x.views || 0) >= 3000) && !/\b(terminus|railway station|junction|bus stand|metro station)\b/i.test(x.name)).map((s) => ({ ...s, withKids: trip.children > 0, score: sightScore(s, trip.children > 0) })).filter((s) => s.score > 2).sort((a, b) => b.score - a.score)))),
    food, stays: local(stays).filter((h) => !BAD_STAY.test(h.name)),
    transit: local(transit).filter((t) => !t.cats.some((c) => /entrance|platform/.test(c))),
    vegFallback,
  };
}

function dedupeSights(sorted) {
  const kept = [];
  const titleMatch = (x) => { const t = words((x.raw.wikipedia || "").replace(/^[a-z-]+:/, "")); return [...words(x.name)].filter((w) => t.has(w)).length / Math.max(1, words(x.name).size); };
  for (const s of sorted) {
    const same = kept.findIndex((k) => s.raw.wikipedia && k.raw.wikipedia === s.raw.wikipedia);
    if (same >= 0) { if (titleMatch(s) > titleMatch(kept[same])) kept[same] = { ...s, score: kept[same].score }; continue; }
    const wiki = s.raw.wikipedia || s.raw.wikidata;
    const ws = words(s.name);
    const dup = kept.some((k) =>
      (wiki && (k.raw.wikipedia || k.raw.wikidata) === wiki) ||
      (km(k, s) < 0.25 && [...ws].some((w) => words(k.name).has(w))));
    if (!dup) kept.push(s);
  }
  return kept;
}

// "Lescot Wing" next to the Louvre: a far less-read article within 200 m of a famous one is part of it.
function dropMinorParts(list) {
  return list.filter((s) => !list.some((o) => o !== s && (o.views || 0) > 20 * Math.max(1, s.views || 0) && (o.views || 0) > 2000 && km(o, s) < 0.2));
}

// Zones inside a big park ("Jurassic World" inside Universal Studios) aren't separate visits.
function dropInsideParks(sorted) {
  const parks = sorted.filter(isFullDay);
  return sorted.filter((s) => isFullDay(s) || !parks.some((p) => km(p, s) < 0.6 && /theme_park|water_park|attraction/.test(s.cats.join(" ")) && !s.raw.wikidata));
}

// ---------- Day planning ----------
function slotsFor(i, D, firstInCity) {
  if (D === 1) return ["Morning", "Afternoon", "Evening"];
  if (i === 0) return ["Afternoon", "Evening"];
  if (i === D - 1) return ["Morning"];
  if (firstInCity) return ["Afternoon", "Evening"];
  return ["Morning", "Afternoon", "Evening"];
}

function nearestUnused(list, used, pt, scoreOf, weight) {
  let best = null, bestVal = Infinity;
  for (const x of list) {
    if (used.has(x.id)) continue;
    const v = km(pt, x) - weight * scoreOf(x);
    if (v < bestVal) { bestVal = v; best = x; }
  }
  return best;
}

export async function buildPlan(trip) {
  if (!GEO_KEY) throw publicError("The trip planner isn't set up yet. Please try again later.", "GEOAPIFY_API_KEY is not set. Add it to .env and restart.");

  const origin = await geocode(trip.origin);
  const dest = await geocode(trip.destination, origin?.countryCode);
  if (!dest) throw publicError("We couldn't find that destination. Try a city or country name.");
  if (!origin) throw publicError("We couldn't find your departure city. Try a nearby major city.");

  const tier = trip.expense;
  const mode = EXPENSE[tier].transport;
  const level = levelOf(dest.countryCode);
  const D = trip.days;
  const rooms = Math.max(1, Math.ceil(trip.adults / 2));

  const cities = (await chooseCities(dest, D)).slice(0, D);
  const data = await Promise.all(cities.map((c) => cityData(c, trip)));
  if (data.every((d) => !d.sights.length)) throw publicError(`We couldn't find enough places to visit in ${dest.name}. Try a nearby city.`);

  // Split days across cities (earlier cities get the extra day).
  const perCity = cities.map((_, i) => Math.floor(D / cities.length) + (i < D % cities.length ? 1 : 0));
  const startDate = new Date(trip.startDate + "T00:00:00Z");
  const isoOf = (i) => new Date(startDate.getTime() + i * 86400e3).toISOString().slice(0, 10);

  const hotels = [];
  const days = [];
  const usedFood = new Set();
  let dayIdx = 0;

  for (let ci = 0; ci < cities.length; ci++) {
    const city = cities[ci], cd = data[ci], n = perCity[ci];
    const slotPlan = Array.from({ length: n }, (_, k) => slotsFor(dayIdx + k, D, ci > 0 && k === 0));
    const need = slotPlan.reduce((a, s) => a + s.length, 0);
    const pool = cd.sights.slice(0, need + 6);
    const centre = pool.length ? centroid(pool.slice(0, Math.max(3, need))) : city;

    // Hotels near the main sights for this city's nights.
    const firstDay = dayIdx, lastDay = dayIdx + n - 1;
    const nightsHere = ci === cities.length - 1 ? n - 1 : n;
    let base = centre;
    if (nightsHere > 0 && cd.stays.length) {
      const ranked = cd.stays.map((h) => ({ h, info: hotelInfo(h, tier), d: km(centre, h) }))
        .sort((a, b) => (a.d - 0.6 * a.info.sc) - (b.d - 0.6 * b.info.sc)).slice(0, 2);
      base = ranked[0].h;
      for (const { h, info, d } of ranked) {
        hotels.push({
          name: h.name, city: city.name, area: h.area || city.name, lat: h.lat, lon: h.lon,
          stars: info.stars,
          whyChosen: [info.stars ? `${info.stars}★ ${info.type.toLowerCase()}` : info.type, `${d < 1 ? "under 1" : d.toFixed(1)} km from the main sights`, `${nightsHere} night${nightsHere > 1 ? "s" : ""} in ${city.name}`].join(" · "),
          pricePerNightINR: COST.hotel[level][info.stars ? (info.stars >= 4 ? "premium" : info.stars >= 3 ? "moderate" : "budget") : tier],
          website: /^https:\/\//.test(h.raw.website || "") ? h.raw.website : null,
          mapUrl: mapsLink(h),
          booking: bookingSearch(trip, `${h.name}, ${city.name}`, rooms, isoOf(firstDay), isoOf(firstDay + nightsHere)),
        });
      }
    }

    // Big theme parks get their own full day: one per city, two if there are 4+ full days.
    const fullSlotDays = slotPlan.map((sl, k) => (sl.length === 3 ? k : -1)).filter((k) => k >= 0);
    const parks = cd.sights.filter(isFullDay).slice(0, fullSlotDays.length >= 4 ? 2 : fullSlotDays.length ? 1 : 0);
    const parkDay = new Map(parks.map((p, j) => [fullSlotDays[Math.min(fullSlotDays.length - 1, 1 + j * 2)] ?? fullSlotDays[0], p]));

    // Group sights into days: seed = best remaining sight, then its nearest neighbours.
    const used = new Set();
    for (let k = 0; k < n; k++) {
      const i = dayIdx + k, slots = slotPlan[k];
      const park = parkDay.get(k);
      const seed = park ? null : pool.find((s) => !used.has(s.id) && !isFullDay(s));
      let picks = [];
      if (park) {
        used.add(park.id);
        picks = [park];
      } else if (seed) {
        picks = pool.filter((s) => !used.has(s.id) && !isFullDay(s)).sort((a, b) => km(seed, a) - km(seed, b)).slice(0, slots.length);
        picks.forEach((p) => used.add(p.id));
        // Order: nearest-neighbour from the hotel; scenic/evening-type places last.
        const ordered = [];
        let at = base;
        const left = [...picks];
        while (left.length) { left.sort((a, b) => km(at, a) - km(at, b)); at = left.shift(); ordered.push(at); }
        const ev = ordered.findIndex(isEvening);
        if (ev >= 0 && slots.at(-1) === "Evening") ordered.push(ordered.splice(ev, 1)[0]);
        picks = ordered;
      }

      const activities = park ? [{ ...park, time: "Full day" }] : picks.map((s, j) => ({ ...s, time: slots[j] }));
      const meals = [];
      const vegPref = trip.food === "Vegetarian";
      const usedToday = new Set();
      const pickFood = (pt) => {
        const score = (x) => foodInfo(x).sc + (vegPref && foodInfo(x).veg ? 3 : 0);
        // Prefer somewhere new; repeat a favourite only when the city has run out of options.
        // Vegetarian trips: a repeated veg place beats a new non-veg one.
        const vegOnly = cd.food.filter((x) => foodInfo(x).veg);
        const f = vegPref && vegOnly.length
          ? nearestUnused(vegOnly, usedFood, pt, score, 0.4) || nearestUnused(vegOnly, usedToday, pt, score, 0.4)
          : nearestUnused(cd.food, usedFood, pt, score, 0.4) || nearestUnused(cd.food, usedToday, pt, score, 0.4);
        if (f) { usedFood.add(f.id); usedToday.add(f.id); }
        return f;
      };
      const addMeal = (meal, f) => {
        if (!f) return;
        const info = foodInfo(f);
        meals.push({ meal, name: f.name, cuisine: info.cuisine, vegFriendly: info.veg, lat: f.lat, lon: f.lon, mapUrl: mapsLink(f) });
      };
      if (i > 0) meals.push({ meal: "Breakfast", name: "Breakfast at your hotel", cuisine: vegPref ? "Ask for vegetarian options" : "Hotel breakfast", vegFriendly: vegPref, lat: null, lon: null, mapUrl: null });
      const mid = activities.find((a) => a.time !== "Evening") || activities[0];
      if (mid && slots.some((s) => s !== "Evening")) addMeal("Lunch", pickFood(mid));
      if (i < D - 1 || D === 1) addMeal("Dinner", pickFood(activities.at(-1) || base));

      // Getting around
      const transport = [], links = [];
      const routeKm = activities.reduce((acc, a, j) => acc + km(j ? activities[j - 1] : base, a), 0);
      if (ci > 0 && k === 0) {
        const prev = cities[ci - 1], dist = Math.round(km(prev, city));
        transport.push(mode === "public"
          ? dist > 350
            ? `Travel ${prev.name} → ${city.name} (about ${dist} km): a long hop, so compare flights, fast trains and overnight buses.`
            : `Travel ${prev.name} → ${city.name} (about ${dist} km): take a train or intercity bus in the morning.`
          : `Private car transfer ${prev.name} → ${city.name} (about ${dist} km, roughly ${Math.max(1, Math.round(dist / 45))} h).`);
        links.push({ label: `${prev.name} → ${city.name} options`, url: rome2rio(prev.name, city.name) });
      }
      if (mode === "public") {
        const seenStations = new Set();
        for (const a of activities) {
          const st = cd.transit.map((t) => ({ t, d: km(a, t) })).sort((x, y) => x.d - y.d)[0];
          if (st && st.d <= 1.5 && !seenStations.has(st.t.id)) {
            seenStations.add(st.t.id);
            transport.push(`${a.name}: ${transitLabel(st.t)} — ${st.t.name} (about ${Math.max(100, Math.round(st.d * 1000 / 50) * 50)} m walk)`);
          }
        }
        if (activities.length && !seenStations.size) transport.push("No metro or rail stop close to today's sights: use local buses, shared autos or an app cab.");
        if (routeKm > 0.5) transport.push(`Today's route is about ${routeKm.toFixed(1)} km. Typical local fare ${COST.fare[level]} per ride.`);
      } else if (activities.length) {
        transport.push(`Private car or app cab between stops (about ${routeKm.toFixed(1)} km today).`);
      }

      // Tip: real opening hours where OpenStreetMap has them
      const withHours = activities.find((a) => a.raw.opening_hours);
      const tip = activities[0]?.time === "Full day"
        ? `${activities[0].name} needs the whole day. Book tickets online in advance; weekdays are less crowded.`
        : withHours
        ? `${withHours.name} opening hours: ${withHours.raw.opening_hours}. Check before you go.`
        : i === 0 && D > 1 ? "Keep the first day light so you can settle in."
        : i === D - 1 && D > 1 ? "Leave plenty of time to reach the airport or station."
        : "";

      const area = activities[0]?.area || city.name;
      days.push({
        day: i + 1,
        date: isoOf(i),
        city: city.name,
        title: D > 1 && i === 0 ? `Arrive in ${city.name}`
          : D > 1 && i === D - 1 ? `Last morning in ${city.name}`
          : ci > 0 && k === 0 ? `Travel to ${city.name}`
          : park ? `A day at ${park.name}`
          : activities[0] ? `${[...activities].sort((a, b) => (b.views || 0) - (a.views || 0))[0].name} & around` : `Free day in ${city.name}`,
        area,
        activities,
        meals,
        transport,
        links,
        tip,
      });
    }
    dayIdx += n;
  }

  // Descriptions: Wikipedia where OSM links an article, otherwise the place type.
  const allActs = days.flatMap((d) => d.activities);
  const wikis = await wikiSummaries(allActs.map((a) => a.raw.wikipedia).filter(Boolean));
  allActs.forEach((a) => {
    const w = wikis.get(a.raw.wikipedia);
    const parts = [labelFor(a.cats), a.raw.description, a.raw.fee === "yes" ? "Entry fee applies" : null].filter(Boolean).map((x) => x.replace(/\.\s*$/, ""));
    a.description = w?.text || `${parts.join(". ")}.`;
    a.wikiUrl = w?.url || null;
  });

  // Flights or ground travel
  const firstCity = cities[0];
  const distKm = km(origin, firstCity);
  let flights = { needed: false, from: { code: "", city: origin.name }, to: { code: "", city: firstCity.name }, pricePerPersonINR: 0, links: [], groundLink: null, distanceKm: Math.round(distKm) };
  if (distKm > 250) {
    const [oa, da] = await Promise.all([nearestAirport(origin), nearestAirport(firstCity)]);
    if (oa && da && (oa.code !== da.code || !oa.code)) {
      const from = { code: oa.code, city: origin.name }, to = { code: da.code, city: firstCity.name };
      flights = { ...flights, needed: true, from, to, pricePerPersonINR: flightEstimate(km(oa, da), origin.countryCode === dest.countryCode), links: flightLinks(trip, from, to) };
    }
  }
  if (!flights.needed) flights.groundLink = rome2rio(origin.name, firstCity.name);

  // Summary
  const overview = await wikivoyageSummary(dest.name);
  const cityList = cities.map((c) => c.name);
  const summary = [
    overview,
    `Your ${D}-day ${EXPENSE[tier].label.toLowerCase()} trip${cityList.length > 1 ? ` covers ${cityList.slice(0, -1).join(", ")} and ${cityList.at(-1)}` : ` is based in ${cityList[0]}`}${flights.needed ? "" : `, about ${Math.round(distKm)} km from ${origin.name}, so travel overland by train, bus or car`}.`,
    data.some((d) => d.vegFallback) ? "Few restaurants here are tagged vegetarian on OpenStreetMap, so some suggestions may need checking for veg options." : null,
  ].filter(Boolean).join(" ");

  // Costs
  const people = trip.adults + trip.children;
  const breakdown = {
    flights: flights.needed ? flights.pricePerPersonINR * people : 0,
    hotels: COST.hotel[level][tier] * rooms * trip.nights,
    food: COST.food[level][tier] * people * D,
    localTransport: (mode === "public" ? COST.transit[level][tier] * people : COST.transit[level][tier] * rooms) * D,
    activities: COST.activities[level][tier] * people * D,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const transportOverview = mode === "public"
    ? { passes: [], tips: [
        `Typical local fare in ${dest.country || dest.name}: ${COST.fare[level]} per ride.`,
        "Ask at the first metro or rail station whether a day pass or stored-value travel card is sold; it usually saves money.",
        "Google Maps and Moovit show live public transport routes and timings.",
      ] }
    : { passes: [], tips: ["Book airport transfers in advance through your hotel.", "App cabs are usually cheaper than street taxis; agree fares first where meters aren't used."] };

  // Strip internal fields before sending to the browser.
  const clean = (a) => ({
    time: a.time, name: a.name, description: a.description, wikiUrl: a.wikiUrl, lat: a.lat, lng: a.lon,
    popularity: a.views || 0,
    rating: a.google?.rating ?? null, reviews: a.google?.reviews ?? null,
    mapUrl: a.google?.url || mapsLink(a), klook: klookSearch(`${a.name} ${a.city || dest.name}`),
  });
  // Google ratings for the chosen restaurants and hotels (display only).
  if (GOOGLE_KEY) {
    const items = [...hotels, ...days.flatMap((d) => d.meals.filter((m) => m.lat != null))];
    await mapLimit(items, 4, async (it) => {
      const g = await googleRating(`${it.name}, ${it.city || dest.name}`, it);
      if (g) Object.assign(it, { rating: g.rating, reviews: g.reviews, mapUrl: g.url || it.mapUrl });
    });
  }
  return {
    trip: { ...trip, expenseLabel: EXPENSE[tier].label, transportMode: mode, rooms },
    source: "osm",
    googleRatings: Boolean(GOOGLE_KEY),
    grounded: true,
    summary,
    cities: cityList,
    flights,
    hotels: hotels.map(({ lon, ...h }) => ({ ...h, lng: lon })),
    hotelSearch: trip.nights > 0 ? bookingSearch(trip, cityList[0], rooms) : null,
    activitiesSearch: klookSearch(dest.name),
    days: days.map((d) => ({ ...d, activities: d.activities.map(clean), meals: d.meals.map(({ lon, ...m }) => ({ ...m, lng: lon })) })),
    transportOverview,
    cost: { breakdown, total, perPerson: Math.round(total / people), level },
  };
}
