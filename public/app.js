"use strict";

const $ = (id) => document.getElementById(id);

// ---------- Small DOM helper (all text goes through textContent) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "href") {
      if (/^https:\/\//.test(v)) { el.href = v; el.target = "_blank"; el.rel = "noopener noreferrer"; }
    } else if (k === "sponsored") {
      el.rel = (el.rel ? el.rel + " " : "") + "sponsored";
    } else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- Dates (DD/MM/YYYY text + hidden native picker) ----------
const start = $("startDate"), end = $("endDate"), startText = $("startText"), endText = $("endText"), daysBox = $("days");
const toISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = toISO(new Date());
start.min = today;
end.min = today;

const fmtDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
function parseDMY(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(+y, +mo - 1, +d);
  if (dt.getFullYear() !== +y || dt.getMonth() !== +mo - 1 || dt.getDate() !== +d) return null;
  return `${y}-${mo}-${d}`;
}

function setDays(n) {
  daysBox.textContent = n ? `${n} Day${n > 1 ? "s" : ""}` : "Select dates";
  daysBox.classList.toggle("empty", !n);
}

function calcDays() {
  $("err-end").textContent = "";
  endText.classList.remove("invalid");
  if (start.value) end.min = start.value;
  if (!start.value || !end.value) { setDays(null); return null; }
  const diff = Math.round((new Date(end.value) - new Date(start.value)) / 86400000);
  if (diff < 0) {
    setDays(null);
    $("err-end").textContent = "End date must be on or after start date.";
    endText.classList.add("invalid");
    return null;
  }
  setDays(diff + 1);
  return diff + 1;
}

function onStartChange() {
  $("err-start").textContent = "";
  startText.classList.remove("invalid");
  if (start.value && end.value && end.value < start.value) {
    end.value = start.value;
    endText.value = fmtDate(end.value);
  }
  calcDays();
}

function bindDate(text, native, errId, onChange) {
  text.addEventListener("input", () => {
    let v = text.value.replace(/\D/g, "").slice(0, 8);
    if (v.length > 4) v = `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4)}`;
    else if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
    text.value = v;
    native.value = parseDMY(v) || "";
    onChange();
    if (v.length === 10 && !native.value) {
      $(errId).textContent = "Enter a valid date (DD/MM/YYYY).";
      text.classList.add("invalid");
    }
  });
  native.addEventListener("change", () => { text.value = fmtDate(native.value); onChange(); });
}
bindDate(startText, start, "err-start", onStartChange);
bindDate(endText, end, "err-end", calcDays);

document.querySelectorAll(".cal-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const native = $(btn.dataset.for);
    try { native.showPicker(); } catch { native.focus(); native.click(); }
  })
);

// ---------- Travellers steppers ----------
const travellers = { adults: 2, children: 0 };
document.querySelectorAll(".stepper").forEach((st) => {
  const field = st.dataset.field, min = +st.dataset.min, max = +st.dataset.max;
  const out = st.querySelector("output");
  const [minus, plus] = st.querySelectorAll("button");
  const sync = () => { out.textContent = travellers[field]; minus.disabled = travellers[field] <= min; plus.disabled = travellers[field] >= max; };
  st.addEventListener("click", (e) => {
    const step = +e.target.dataset.step;
    if (!step) return;
    travellers[field] = Math.min(max, Math.max(min, travellers[field] + step));
    sync();
  });
  sync();
});

// ---------- Text field errors ----------
const origin = $("origin"), dest = $("destination");
for (const [el, err] of [[origin, "err-origin"], [dest, "err-destination"]]) {
  el.addEventListener("input", () => { $(err).textContent = ""; el.classList.remove("invalid"); });
}
function fail(input, errId, msg) { $(errId).textContent = msg; input.classList.add("invalid"); return false; }

// ---------- Currency ----------
const REGION_CURRENCY = {
  IN: "INR", US: "USD", GB: "GBP", AU: "AUD", CA: "CAD", NZ: "NZD", SG: "SGD", JP: "JPY", CN: "CNY", HK: "HKD",
  KR: "KRW", MY: "MYR", TH: "THB", ID: "IDR", PH: "PHP", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN",
  CZ: "CZK", HU: "HUF", TR: "TRY", ZA: "ZAR", BR: "BRL", MX: "MXN", IL: "ILS", IS: "ISK", RO: "RON",
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", IE: "EUR", PT: "EUR", FI: "EUR", GR: "EUR",
};
const locale = navigator.language || "en-IN";
const region = (() => { try { return new Intl.Locale(locale).maximize().region; } catch { return "IN"; } })();
let rates = { INR: 1 };
let currency = localStorage.getItem("wanderly-currency") || REGION_CURRENCY[region] || "INR";
const ratesReady = fetch("/api/rates")
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d?.rates) rates = d.rates; if (!rates[currency]) currency = "INR"; })
  .catch(() => { currency = "INR"; });

const money = (amount, cur) =>
  new Intl.NumberFormat(cur === "INR" ? "en-IN" : locale, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount);
const inr = (n) => money(n, "INR");
const local = (n) => money(n * (rates[currency] || 1), currency);
// "₹1,50,000 (≈ $1,790)" when visitor currency isn't INR
function priceText(n) { return currency === "INR" ? inr(n) : `${inr(n)} (≈ ${local(n)})`; }

// ---------- Submit ----------
let lastPlan = null;

$("planner").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("formError").textContent = "";
  let ok = true;
  if (!origin.value.trim()) ok = fail(origin, "err-origin", "Where are you starting from?");
  if (!dest.value.trim()) ok = fail(dest, "err-destination", "Please enter a destination.");
  if (!start.value) ok = fail(startText, "err-start", startText.value ? "Enter a valid date (DD/MM/YYYY)." : "Pick a start date.");
  else if (start.value < today) ok = fail(startText, "err-start", "Start date can't be in the past.");
  if (!end.value) ok = fail(endText, "err-end", endText.value ? "Enter a valid date (DD/MM/YYYY)." : "Pick an end date.");
  const n = ok ? calcDays() : null;
  if (!n) return;
  if (n > 21) { fail(endText, "err-end", "Trips up to 21 days are supported."); return; }

  const body = {
    origin: origin.value.trim(),
    destination: dest.value.trim(),
    startDate: start.value,
    endDate: end.value,
    adults: travellers.adults,
    children: travellers.children,
    expense: document.querySelector('input[name="expense"]:checked').value,
    food: document.querySelector('input[name="food"]:checked').value,
  };

  setLoading(true);
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    await Promise.all([ratesReady, mapConfigReady]);
    lastPlan = data;
    renderPlan(data);
  } catch (err) {
    $("formError").textContent = err.message;
  } finally {
    setLoading(false);
  }
});

let loadingTimer;
function setLoading(on) {
  $("submitBtn").disabled = on;
  $("loading").classList.toggle("show", on);
  clearInterval(loadingTimer);
  if (on) {
    $("results").classList.remove("show");
    const steps = ["Planning your trip…", "Finding things to do…", "Picking restaurants…", "Choosing hotels…", "Mapping out each day…"];
    let i = 0;
    $("loadingMsg").textContent = steps[0];
    loadingTimer = setInterval(() => { i = (i + 1) % steps.length; $("loadingMsg").textContent = steps[i]; }, 6000);
  }
}

// ---------- Render ----------
const ICON = { "Full day": "🎢", Morning: "🌅", Afternoon: "☀️", Evening: "🌙", Breakfast: "🥐", Lunch: "🍛", Dinner: "🍽️" };
const ORDER = { "Full day": 0, Morning: 0, Afternoon: 1, Evening: 2, Breakfast: 0, Lunch: 1, Dinner: 2 };
const byOrder = (key) => (a, b) => (ORDER[a[key]] ?? 9) - (ORDER[b[key]] ?? 9);
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const popBadge = (v) => (v >= 100 ? h("span", { class: "pop", title: "Wikipedia readers in the last 30 days: a measure of how popular this place is" }, `🔥 ${compact(v)} readers/month`) : null);
const stars = (r) => (r == null ? null : `★ ${Number(r).toFixed(1)}`);
const shortDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

function sectionTitle(text) { return h("div", { class: "section-title" }, text); }

function renderPlan(p, keepScroll = false) {
  const t = p.trip;
  const root = $("results");
  root.replaceChildren();

  // Header (plus a brand line that only shows in the PDF)
  root.append(h("div", { class: "print-only", style: "font-weight:800;font-size:1.3rem;margin-bottom:.8rem" }, "🧭 Wanderly"));
  root.append(
    h("div", { class: "res-head" },
      h("small", null, "Your trip to"),
      h("h2", null, t.destination),
      h("div", { class: "chips" },
        h("span", { class: "chip" }, `🗓️ ${fmtDate(t.startDate)} → ${fmtDate(t.endDate)}`),
        h("span", { class: "chip" }, `${t.days} day${t.days > 1 ? "s" : ""} · ${t.nights} night${t.nights === 1 ? "" : "s"}`),
        h("span", { class: "chip" }, `👥 ${t.adults} adult${t.adults > 1 ? "s" : ""}${t.children ? `, ${t.children} child${t.children > 1 ? "ren" : ""}` : ""}`),
        h("span", { class: "chip" }, `💰 ${t.expenseLabel}`),
        h("span", { class: "chip" }, `🍽️ ${t.food}`),
      ),
      h("p", { class: "summary-text" }, p.summary),
    )
  );

  // Tools: data badge + currency selector
  const sel = h("select", { "aria-label": "Display currency" },
    Object.keys(rates).sort().map((c) => { const o = h("option", { value: c }, c); if (c === currency) o.selected = true; return o; })
  );
  sel.addEventListener("change", () => { currency = sel.value; localStorage.setItem("wanderly-currency", currency); renderPlan(lastPlan, true); });
  root.append(
    h("div", { class: "res-tools" },
      p.grounded
        ? h("span", { class: "badge ok" }, "✓ Real places from OpenStreetMap")
        : h("span", { class: "badge warn" }, "⚠ Suggested places. Check before booking."),
      h("div", { class: "tool-btns" },
        h("label", { class: "currency" }, "Show prices in", sel),
        (() => { const b = h("button", { type: "button", class: "tool-btn" }, "⬇️ Download PDF"); b.addEventListener("click", printPlan); return b; })(),
      ),
    )
  );

  // Total
  root.append(
    h("div", { class: "total-box" },
      h("div", null, h("div", { class: "k" }, "Estimated trip total"), h("div", { class: "v" }, inr(p.cost.total))),
      h("div", { class: "alt" }, currency !== "INR" ? `≈ ${local(p.cost.total)} · ` : "", `${inr(p.cost.perPerson)} per person`),
    )
  );

  // Flights
  const fl = h("div", { class: "section" }, sectionTitle("✈️ Flights"));
  if (p.flights.needed && p.flights.links.length) {
    fl.append(
      h("div", { class: "item" },
        h("div", { class: "main" },
          h("div", { class: "route" },
            h("div", null, p.flights.from.code, h("small", null, p.flights.from.city)),
            h("span", { class: "plane" }, "⇄"),
            h("div", null, p.flights.to.code, h("small", null, p.flights.to.city)),
          ),
          h("div", { class: "meta" }, `Round trip · ${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}`),
        ),
        h("div", { class: "side" },
          h("div", { class: "price" }, `~${priceText(p.flights.pricePerPersonINR)} `, h("small", null, "/ person")),
          h("div", { class: "links" }, p.flights.links.map((l, i) => h("a", { class: `link-btn${i === 0 ? " primary" : ""}`, href: l.url, sponsored: l.sponsored }, l.label, " ↗"))),
        ),
      )
    );
  } else {
    fl.append(
      h("div", { class: "item" },
        h("div", { class: "main" },
          h("h4", null, `${t.origin} → ${p.cities?.[0] || t.destination}`),
          h("div", { class: "meta" }, `About ${p.flights.distanceKm} km. No flight needed: go by train, bus or car.`),
        ),
        p.flights.groundLink ? h("div", { class: "side" }, h("div", { class: "links" }, h("a", { class: "link-btn primary", href: p.flights.groundLink }, "Compare train / bus / car ↗"))) : null,
      )
    );
  }
  root.append(fl);

  // Hotels
  if (p.hotels.length) {
    const ht = h("div", { class: "section" }, sectionTitle(`🏨 Where to stay · ${t.rooms} room${t.rooms > 1 ? "s" : ""}`));
    p.hotels.forEach((x) =>
      ht.append(
        h("div", { class: "item" },
          h("div", { class: "main" },
            h("h4", null, x.name),
            h("div", { class: "meta" }, [x.city && x.city !== x.area ? `${x.area}, ${x.city}` : x.area, x.rating ? `${stars(x.rating)}${x.reviews ? ` (${x.reviews.toLocaleString()})` : ""}` : null].filter(Boolean).join(" · ")),
            h("p", null, x.whyChosen),
          ),
          h("div", { class: "side" },
            h("div", { class: "price" }, `~${priceText(x.pricePerNightINR)} `, h("small", null, "/ night")),
            h("div", { class: "links" },
              h("a", { class: "link-btn primary", href: x.booking.url, sponsored: x.booking.sponsored }, "Booking.com ↗"),
              x.mapUrl ? h("a", { class: "link-btn", href: x.mapUrl }, "📍 Map") : null,
              x.website ? h("a", { class: "link-btn", href: x.website }, "Website ↗") : null,
            ),
          ),
        )
      )
    );
    if (p.hotelSearch) ht.append(h("div", { class: "links", style: "margin-top:.8rem" }, h("a", { class: "link-btn", href: p.hotelSearch.url, sponsored: p.hotelSearch.sponsored }, "See more stays on Booking.com ↗")));
    root.append(ht);
  }

  // Map (only when places have real coordinates)
  const mapSection = buildMapSection(p);
  if (mapSection) root.append(mapSection);

  // Day by day
  const dd = h("div", { class: "section" }, sectionTitle("📅 Day-by-day plan"));
  p.days.forEach((d, i) => {
    const body = h("div", { class: "day-body" });
    d = { ...d, activities: [...d.activities].sort(byOrder("time")), meals: [...d.meals].sort(byOrder("meal")) };

    if (d.activities.length) {
      body.append(h("div", { class: "sub-title" }, "Things to do"));
      body.append(
        h("div", { class: "timeline" },
          d.activities.map((a) =>
            h("div", { class: "tl-item" },
              h("div", { class: "tl-time" }, `${ICON[a.time] || ""} ${a.time}`),
              h("div", { class: "tl-name" }, a.name,
                a.rating ? h("span", { class: "star" }, `  ${stars(a.rating)}${a.reviews ? ` (${compact(a.reviews)})` : ""}`) : null,
                popBadge(a.popularity)),
              h("div", { class: "tl-desc" }, a.description),
              h("div", { class: "links" },
                a.mapUrl ? h("a", { class: "link-btn", href: a.mapUrl }, "📍 Map") : null,
                a.wikiUrl ? h("a", { class: "link-btn", href: a.wikiUrl }, "📖 Wikipedia") : null,
                h("a", { class: "link-btn", href: a.klook.url, sponsored: a.klook.sponsored }, "🎟️ Tickets & tours on Klook ↗"),
              ),
            )
          )
        )
      );
    }

    if (d.meals.length) {
      body.append(h("div", { class: "sub-title" }, "Where to eat"));
      d.meals.forEach((m) =>
        body.append(
          h("div", { class: "meal" },
            h("div", { class: "when" }, `${ICON[m.meal] || ""} ${m.meal}`),
            h("div", { class: "what" },
              h("b", null, m.name), m.vegFriendly ? h("span", { class: "veg" }, "VEG") : null,
              h("span", { class: "sub" }, [m.cuisine, m.rating ? `${stars(m.rating)}${m.reviews ? ` (${compact(m.reviews)})` : ""}` : null].filter(Boolean).join(" · ")),
            ),
            m.mapUrl ? h("a", { class: "link-btn", href: m.mapUrl }, "📍 Map") : null,
          )
        )
      );
    }

    if (d.transport.length) {
      body.append(h("div", { class: "sub-title" }, t.transportMode === "public" ? "Getting around (public transport)" : "Getting around"));
      body.append(h("ul", { class: "plain" }, d.transport.map((x) => h("li", { "data-ico": t.transportMode === "public" ? "🚇" : "🚕" }, x))));
    }

    if (d.links?.length) body.append(h("div", { class: "links", style: "margin-top:.6rem" }, d.links.map((l) => h("a", { class: "link-btn", href: l.url }, `🚆 ${l.label} ↗`))));
    if (d.tip) body.append(h("div", { class: "tip" }, "💡 ", d.tip));

    const det = h("details", { class: "day" },
      h("summary", null,
        h("div", { class: "day-num" }, h("small", null, "DAY"), d.day),
        h("div", null, h("div", { class: "day-title" }, d.title), h("div", { class: "day-sub" }, [shortDate(d.date), d.area].filter(Boolean).join(" · "))),
      ),
      body,
    );
    if (i === 0) det.open = true;
    dd.append(det);
  });
  root.append(dd);

  // Transport overview
  const to = p.transportOverview;
  if (to && (to.passes.length || to.tips.length)) {
    const sec = h("div", { class: "section" }, sectionTitle(t.transportMode === "public" ? "🚇 Public transport guide" : "🚕 Getting around"));
    sec.append(h("ul", { class: "plain" },
      to.passes.map((x) => h("li", { "data-ico": "🎫" }, x)),
      to.tips.map((x) => h("li", { "data-ico": "👉" }, x)),
    ));
    root.append(sec);
  }

  // Cost breakdown
  const b = p.cost.breakdown;
  const rows = [
    ["✈️ Flights (round trip)", b.flights],
    [`🏨 Hotels (${t.nights} night${t.nights === 1 ? "" : "s"} × ${t.rooms} room${t.rooms > 1 ? "s" : ""})`, b.hotels],
    ["🍽️ Food", b.food],
    [t.transportMode === "public" ? "🚇 Local transport" : "🚕 Local transfers", b.localTransport],
    ["🎟️ Activities & entry fees", b.activities],
  ].filter(([, v]) => v > 0);
  root.append(
    h("div", { class: "section" },
      sectionTitle("💰 Cost estimate"),
      h("table", { class: "cost" },
        h("tbody", null,
          rows.map(([k, v]) => h("tr", null, h("td", null, k), h("td", null, priceText(v)))),
          h("tr", { class: "total" }, h("td", null, "Total"), h("td", null, priceText(p.cost.total))),
        )
      ),
    )
  );

  root.append(
    h("div", { class: "links" }, h("a", { class: "link-btn", href: p.activitiesSearch.url, sponsored: p.activitiesSearch.sponsored }, `🎟️ More things to do in ${t.destination} on Klook ↗`)),
    h("p", { class: "disclaimer" },
      "Places and maps: © ", h("a", { href: "https://www.openstreetmap.org/copyright" }, "OpenStreetMap contributors"),
      " (ODbL), powered by ", h("a", { href: "https://www.geoapify.com/" }, "Geoapify"),
      ". Descriptions from Wikipedia and Wikivoyage (CC BY-SA); sights are ranked by popularity (Wikipedia readers in the last 30 days). ",
      p.googleRatings ? "Ratings and review counts from Google Maps. " : "",
      "Prices are typical estimates, not quotes. Check prices, opening hours and availability on the booking site before you pay. ",
      "Booking links open partner sites; Wanderly may earn a commission at no extra cost to you. ",
      "Exchange rates are European Central Bank reference rates."
    ),
    h("div", { class: "again" }, (() => {
      const btn = h("button", { type: "button", class: "btn" }, "↺ Plan another trip");
      btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
      return btn;
    })()),
  );

  root.classList.add("show");
  if (mapSection) initMap(p);
  if (!keepScroll) root.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Map ----------
const DAY_COLORS = ["#ff6b4a", "#1e3a8a", "#0e9f6e", "#9333ea", "#d97706", "#0891b2", "#db2777", "#4d7c0f"];
let mapConfig = null;
const mapConfigReady = fetch("/api/config").then((r) => r.json()).then((c) => { mapConfig = c; }).catch(() => {});
let tripMap = null;

function mapPoints(p) {
  const pts = [];
  p.hotels.forEach((x) => x.lat != null && pts.push({ day: 0, kind: "hotel", name: x.name, sub: x.area, lat: x.lat, lng: x.lng }));
  p.days.forEach((d) => {
    [...d.activities].sort(byOrder("time")).forEach((a) => a.lat != null && pts.push({ day: d.day, kind: "activity", name: a.name, sub: `Day ${d.day} · ${a.time}`, lat: a.lat, lng: a.lng }));
    d.meals.forEach((m) => m.lat != null && pts.push({ day: d.day, kind: "meal", name: m.name, sub: `Day ${d.day} · ${m.meal}`, lat: m.lat, lng: m.lng }));
  });
  return pts;
}

function buildMapSection(p) {
  if (!window.L || !mapConfig || !mapPoints(p).length || p.googleRatings) return null;
  const filter = h("div", { class: "map-filter" });
  const sec = h("div", { class: "section map-section" },
    sectionTitle("🗺️ Trip map"),
    filter,
    h("div", { id: "tripMap", role: "region", "aria-label": "Map of your trip" }),
    h("div", { class: "map-note" }, "Numbers show the day. 🏨 = your hotel. Lines follow each day's activities in order."),
  );
  const days = [...new Set(p.days.map((d) => d.day))];
  [["All", null], ...days.map((d) => [`Day ${d}`, d])].forEach(([label, day], i) => {
    const b = h("button", { type: "button", class: i === 0 ? "active" : null }, label);
    b.addEventListener("click", () => {
      filter.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      showDay(day);
    });
    filter.append(b);
  });
  return sec;
}

let mapLayers = [];
function initMap(p) {
  if (tripMap) { tripMap.remove(); tripMap = null; }
  tripMap = L.map("tripMap", { scrollWheelZoom: false });
  L.tileLayer(mapConfig.tileUrl, { maxZoom: 19, attribution: mapConfig.tileAttribution }).addTo(tripMap);

  mapLayers = [];
  const pts = mapPoints(p);
  const byDay = new Map();
  for (const pt of pts) {
    const color = pt.day ? DAY_COLORS[(pt.day - 1) % DAY_COLORS.length] : "#14213d";
    const pin = document.createElement("div");
    pin.className = "map-pin";
    pin.style.background = color;
    const label = document.createElement("span");
    label.textContent = pt.kind === "hotel" ? "🏨" : pt.kind === "meal" ? "🍽" : String(pt.day);
    pin.append(label);
    const icon = L.divIcon({ html: pin, className: "", iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26] });
    const pop = h("div", { class: "map-pop" }, h("b", null, pt.name), h("span", null, pt.sub));
    const marker = L.marker([pt.lat, pt.lng], { icon, title: pt.name }).bindPopup(pop);
    mapLayers.push({ day: pt.day, layer: marker });
    if (pt.kind === "activity") { if (!byDay.has(pt.day)) byDay.set(pt.day, []); byDay.get(pt.day).push([pt.lat, pt.lng]); }
  }
  for (const [day, coords] of byDay) {
    if (coords.length > 1) {
      const color = DAY_COLORS[(day - 1) % DAY_COLORS.length];
      mapLayers.push({ day, layer: L.polyline(coords, { color, weight: 3, opacity: .7, dashArray: "6 6" }) });
    }
  }
  showDay(null);
}

function showDay(day) {
  if (!tripMap) return;
  const bounds = [];
  for (const { day: d, layer } of mapLayers) {
    const visible = day == null || d === day || d === 0;
    if (visible) { layer.addTo(tripMap); bounds.push(...(layer.getLatLngs ? layer.getLatLngs() : [layer.getLatLng()])); }
    else layer.remove();
  }
  if (bounds.length) tripMap.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 15 });
}

// ---------- PDF (browser print → Save as PDF) ----------
function printPlan() {
  const days = [...document.querySelectorAll("details.day")];
  const wasOpen = days.map((d) => d.open);
  const title = document.title;
  days.forEach((d) => (d.open = true));
  if (lastPlan) document.title = `Wanderly - ${lastPlan.trip.destination} itinerary`;
  window.addEventListener("afterprint", () => {
    days.forEach((d, i) => (d.open = wasOpen[i]));
    document.title = title;
  }, { once: true });
  window.print();
}
