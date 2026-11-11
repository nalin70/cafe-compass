# Cafe Finder

Finds cafes near you (or near any place you type) and ranks them for your taste.

```
npm install
npm start          # then open http://localhost:3000  (set PORT=… to change)
```

Needs Node 22+ (uses the built-in SQLite). **No API keys are needed** for the basics: cafes, hours, open-now,
filters, saving and rating all come from free OpenStreetMap data.

The app listens on this computer only (`127.0.0.1`). Set `HOST=0.0.0.0` in `.env` only if you deliberately want
other devices on your network to open it; it has your saved list (and optionally your Google key) behind it.

## Free extras that need no setup

- **Saved searches.** Search results are kept on disk and reused when you search the same area again, so repeat
  searches are instant. If the free OpenStreetMap servers are down (they're volunteer-run and often busy), the app
  shows your older saved results and says how old they are. Use **Refresh** to force a new search.
- **Weather tip** (from [Open-Meteo](https://open-meteo.com/), no key). Sunny: "outdoor seating is worth a look".
  Rain or cold: "indoor seating". Hot: "air-conditioned". Your position is rounded to about 1 km before it is sent.
- **Backup & export** (My list tab). Your list, ratings, notes and taste settings live in `cafes.db` on this
  computer, so download a backup now and then. You can restore it later, or export "Want to go" as KML to import into
  [Google My Maps](https://mymaps.google.com) (Create a new map, Import), or as CSV for a spreadsheet.
- **Details from cafes' own websites.** In the background, the server reads each cafe's website (when OpenStreetMap
  lists one) for opening hours, phone, price range, menu link, Instagram and a short description, mostly from the
  structured data many sites publish. Anything read this way is labelled "from the cafe's website". It is polite
  (honours `robots.txt`, a few requests at a time, one per site at once, small size cap, no scripts run) and only
  connects to public internet addresses. **It helps only cafes that have a website** (8–29% in the areas I tested),
  and few of those publish hours, so don't expect it to fill most gaps. Turn it off with `ENRICH_WEBSITES=false`.
- **Press & mentions** (button on each card). Always: one-tap search links for news, YouTube, Instagram and the web.
  Automatic news comes from [GDELT](https://www.gdeltproject.org/) (free, no key, only roughly the last 3 months, and
  it often rate-limits or times out, so treat it as a bonus). Matching is strict: a story is shown only if it names the
  cafe *and* its city (or the publisher is in the same country), generic names like "Coffee House" get search links
  only, and **Not about this cafe** hides a wrong result. Paste an Instagram reel/post, YouTube video or article link
  onto any cafe to keep it there (included in backups). Reels and videos load only after you click play, in a sandboxed
  frame. We show headlines and link to the original, never copy articles.
- **Pick one for me, visited log & notes, compare up to 3 cafes, open at a chosen time, closing-soon warnings.**

## Optional: Google reviews ("Show reviews" button)

OpenStreetMap has no reviews, so reviews come from Google Places. The key is used **only when you click
"Show reviews"** on a cafe. Searching never touches Google, so normal use costs nothing.

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project and enable billing
   (Google requires a card, even for the free allowance).
2. Enable **Places API (New)**.
3. Create an API key (APIs & Services → Credentials) and restrict it to *Places API (New)*.
4. **Set a budget alert** (Billing → Budgets & alerts). Alerts notify you but don't stop spending,
   so also keep the built-in cap below.
5. Copy `.env.example` to `.env` and set `GOOGLE_PLACES_API_KEY=your-key`, then restart `npm start`.

What you get per cafe: Google rating and review count, up to 5 review snippets (Google's limit, with author
credit), and the foods/drinks those reviews mention most. Each click is one or two Google requests; Google's
current pricing and free monthly allowance are on its
[pricing page](https://developers.google.com/maps/billing-and-pricing/pricing). Check it, as it changes.

Safeguards in the app:
- `REVIEWS_DAILY_LIMIT` (default 100) stops review lookups for the day once reached.
- Review text is never saved (Google's terms don't allow long-term storage), only kept in memory for 15 minutes.
  Only the cafe's Google place id is stored, so each cafe is looked up once.

## Other optional settings (`.env`)

| Variable | What it does |
|---|---|
| `GOOGLE_FULL_SEARCH=true` | Use Google for the main search too (20 results with ratings and photos). Costs more. |
| `ANTHROPIC_API_KEY` | Enables AI vibe summaries (needs the Google key too). Paid. |

## Tests

```
npm test
```

## Optional: YouTube videos in "Press & mentions"

Set `YOUTUBE_API_KEY` in `.env` (Google Cloud: enable **YouTube Data API v3**, create a key). Videos are searched only
when you click the button, only matches that name the cafe and its city are kept, results are cached for a week, and
`YOUTUBE_DAILY_LIMIT` (default 30) stops lookups for the day. Without a key everything else still works.
