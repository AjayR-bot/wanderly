# Wanderly — Tour Planner

Enter a few trip details; get a full itinerary: flights, hotels, a day-wise plan, restaurants matched to your food preference, and public transport (Budget/Moderate) or private transfers (Premium), with booking links, a trip map, PDF export and a cost estimate in INR converted to your currency.

**Free to run:** no AI and no paid APIs. Places come from OpenStreetMap (via Geoapify's free plan), descriptions from Wikipedia, destination overviews from Wikivoyage, exchange rates from the European Central Bank.

## Run locally

```bash
npm install
cp .env.example .env    # add GEOAPIFY_API_KEY (free, no credit card) and CONTACT_EMAIL
npm start               # http://127.0.0.1:3000
```

Get the key at https://myprojects.geoapify.com: sign up, create a project, copy its API key.

## How it plans

1. Geocodes the departure city and destination. A country or state is split into 1–4 cities (by trip length), picked by where the most notable sights are.
2. For each city, fetches sights, restaurants (vegetarian-filtered when chosen), hotels and metro/rail/ferry stops.
3. Ranks sights (UNESCO, Wikipedia-linked, museums, forts, temples rank higher; statues and minor memorials lower).
4. Groups each day's sights by distance from the best remaining one and orders them from the hotel; viewpoints go to the evening.
5. Picks hotels by expense level (hostels and guest houses / 3★ / 4–5★) near the main sights, lunch and dinner near the day's stops, and the nearest station to each sight.
6. Flights are suggested when cities are more than about 250 km apart (nearest international airports); otherwise a train/bus/car comparison link.
7. Costs come from typical-price tables by expense level and the destination country's cost level (rough estimates, not quotes).

## Files

- `server.js`: web server, input validation, rate limits, exchange rates.
- `planner.js`: data fetching, planning rules, booking links, costs.
- `public/`: form and results page (no framework); Leaflet map served from `node_modules`.

## Free-plan budget

Geoapify's free plan gives 3,000 credits/day; one new plan uses about 15–30 credits (1 credit per 20 places), and repeat destinations are cached for 24 h. `DAILY_PLAN_CAP` (default 100) stops the site before the quota runs out. Per visitor: 5 plans/minute, 30/day.

## Affiliate links

Once a programme approves you, paste its deep-link format into `.env` (no code change):

| Variable | Wraps |
|---|---|
| `BOOKING_LINK_TEMPLATE` | Booking.com hotel links, e.g. `{rawurl}&aid=1234567` |
| `KLOOK_LINK_TEMPLATE` | Klook activity links |
| `SKYSCANNER_LINK_TEMPLATE` | Skyscanner flight links |
| `MAKEMYTRIP_LINK_TEMPLATE` | MakeMyTrip flight links |

`{url}` is replaced with the URL-encoded target, `{rawurl}` with the target as-is. Wrapped links get `rel="sponsored"`.

## Attribution (required)

The results page credits OpenStreetMap contributors (ODbL), Geoapify, and Wikipedia/Wikivoyage (CC BY-SA). Keep these credits if you change the page.

## Going public

Keep `HOST=127.0.0.1` and put a reverse proxy (HTTPS on 443) in front; set `TRUST_PROXY=1` so rate limits see real client IPs. Switch `MAP_TILE_URL` to a tile provider before heavy traffic. The site is public and anonymous by design (no login).
