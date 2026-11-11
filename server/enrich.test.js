import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, hoursFromLd, robotsAllowed, applyEnrichment, createEnricher, normalizeWebsite } from './enrich.js';

const page = (ld, extra = '') => `<html><head>${ld ? `<script type="application/ld+json">${typeof ld === 'string' ? ld : JSON.stringify(ld)}</script>` : ''}${extra}</head><body>hi</body></html>`;

test('reads hours, phone, price, cuisine, menu, reservations and Instagram from schema.org JSON-LD', () => {
  const d = extractFromHtml(page({
    '@context': 'https://schema.org', '@type': 'CafeOrCoffeeShop', name: 'Brew',
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '08:00:00', closes: '17:00:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'https://schema.org/Saturday', opens: '09:00', closes: '14:00' },
    ],
    telephone: '+91 98765 43210', priceRange: '₹₹', servesCuisine: ['Coffee', 'Bakery'], hasMenu: 'https://brew.example/menu.pdf',
    acceptsReservations: 'True', sameAs: ['https://www.facebook.com/brew', 'https://www.instagram.com/brew_cafe/'], description: 'Small-batch roasters &amp; brunch.',
  }), 'https://brew.example/');
  assert.equal(d.hours, 'Mo-Fr 08:00-17:00; Sa 09:00-14:00');
  assert.equal(d.phone, '+91 98765 43210'); assert.equal(d.priceRange, '₹₹'); assert.deepEqual(d.cuisine, ['Coffee', 'Bakery']);
  assert.equal(d.menuUrl, 'https://brew.example/menu.pdf'); assert.equal(d.reservations, true);
  assert.equal(d.instagram, 'https://instagram.com/brew_cafe'); assert.equal(d.description, 'Small-batch roasters & brunch.');
});

test('handles @graph, array types, and the compact openingHours text form', () => {
  const d = extractFromHtml(page({ '@graph': [{ '@type': 'WebSite', name: 'x' }, { '@type': ['Organization', 'Restaurant'], openingHours: ['Mo-Fr 09:00-18:00', 'Sa,Su 10:00-16:00'], telephone: '022 2345 6789' }] }), 'https://x.example/');
  assert.equal(d.hours, 'Mo-Fr 09:00-18:00; Sa-Su 10:00-16:00');
  assert.equal(d.phone, '022 2345 6789');
});

test('hours: split shifts, 12-hour times, midnight close, and days with no entry are left out', () => {
  assert.equal(hoursFromLd({ openingHours: 'Mo,Tu 09:00-12:00,13:00-17:00' }), 'Mo-Tu 09:00-12:00,13:00-17:00');
  assert.equal(hoursFromLd({ openingHoursSpecification: [{ dayOfWeek: 'Friday', opens: '5:30 PM', closes: '12:00 AM' }] }), 'Fr 17:30-24:00');
  assert.equal(hoursFromLd({ openingHoursSpecification: [{ dayOfWeek: ['Mon', 'Wed'], opens: '8am', closes: '4pm' }] }), 'Mo 08:00-16:00; We 08:00-16:00');
  const all = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  assert.equal(hoursFromLd({ openingHoursSpecification: [{ dayOfWeek: all, opens: '07:00', closes: '23:00' }] }), 'Mo-Su 07:00-23:00');
});

test('hours: unusable or seasonal data yields nothing rather than something wrong', () => {
  assert.equal(hoursFromLd({ openingHours: 'Open daily from morning till late' }), null);
  assert.equal(hoursFromLd({ openingHoursSpecification: [{ dayOfWeek: 'Monday', opens: '25:99', closes: 'soon' }] }), null);
  assert.equal(hoursFromLd({ openingHoursSpecification: [{ dayOfWeek: 'Monday', opens: '09:00', closes: '17:00', validFrom: '2026-12-24', validThrough: '2026-12-26' }] }), null); // holiday rule
  assert.equal(hoursFromLd({}), null);
});

test('falls back to page markup when there is no structured data', () => {
  const d = extractFromHtml(page(null,
    `<meta property="og:description" content="Third-wave coffee, house-made pastries and a sunny courtyard in the old town.">
     <a href="tel:+91-80-1234-5678">Call</a><a href="mailto:hello@bean.example?subject=hi">Mail</a>
     <a href="https://www.instagram.com/p/ABC123/">post</a><a href="https://instagram.com/bean.house">IG</a>
     <a href="/our-menu">Our Menu</a>`), 'https://bean.example/');
  assert.equal(d.phone, '+91-80-1234-5678'); assert.equal(d.email, 'hello@bean.example');
  assert.equal(d.instagram, 'https://instagram.com/bean.house'); // not the /p/ post link
  assert.equal(d.menuUrl, 'https://bean.example/our-menu');
  assert.match(d.description, /Third-wave coffee/);
});

test('ignores junk: bad JSON, non-business types, javascript: links, tiny descriptions, odd phones', () => {
  assert.deepEqual(extractFromHtml(page('{ this is not json'), 'https://x.example/'), {});
  assert.deepEqual(extractFromHtml(page({ '@type': 'Person', telephone: '+1 555 123 4567' }), 'https://x.example/'), {});
  const d = extractFromHtml(page(null, '<a href="javascript:alert(1)">Menu</a><meta name="description" content="short"><a href="tel:12">x</a>'), 'https://x.example/');
  assert.deepEqual(d, {});
  assert.equal(extractFromHtml(page({ '@type': 'Cafe', telephone: '<script>alert(1)</script>' }), 'https://x.example/').phone, undefined);
});

test('CDATA-wrapped JSON-LD still parses', () => {
  const d = extractFromHtml(page('/*<![CDATA[*/' + JSON.stringify({ '@type': 'Restaurant', telephone: '+44 20 7946 0958' }) + '/*]]>*/'), 'https://x.example/');
  assert.equal(d.phone, '+44 20 7946 0958');
});

test('robots.txt: specific agent beats *, longest rule wins, Allow beats Disallow on a tie, wildcards work', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\n\nUser-agent: cafe-finder\nDisallow: /nope\n`;
  assert.equal(robotsAllowed(txt, '/nope/page'), false);
  assert.equal(robotsAllowed(txt, '/private/x'), true); // our own group has no rule for it; the * group doesn't apply to us
  const star = `User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\n`;
  assert.equal(robotsAllowed(star, '/private/x'), false);
  assert.equal(robotsAllowed(star, '/private/public/x'), true);
  assert.equal(robotsAllowed(star, '/menu.pdf'), false); assert.equal(robotsAllowed(star, '/menu.pdf?x=1'), true);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /\n', '/'), false);
  assert.equal(robotsAllowed('User-agent: *\nDisallow:\n', '/'), true);
  assert.equal(robotsAllowed('', '/'), true);
  assert.equal(robotsAllowed('User-agent: googlebot\nDisallow: /\n', '/'), true);
});

test('normalizeWebsite adds https:// and rejects unsafe or private targets', () => {
  assert.equal(normalizeWebsite('www.example.com'), 'https://www.example.com/');
  assert.equal(normalizeWebsite('http://example.com/menu'), 'http://example.com/menu');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'http://127.0.0.1/', 'http://localhost:3000/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://user:pw@example.com/', 'http://example.com:8080/', '', null, 'x'.repeat(400)]) {
    assert.equal(normalizeWebsite(bad), null, String(bad).slice(0, 40));
  }
});

test('applyEnrichment fills gaps only, keeps OpenStreetMap values, and records what came from the website', () => {
  const cafe = { id: 'node/1', name: 'X', hours: null, details: { phone: '+1 111', cuisine: [] } };
  const out = applyEnrichment(cafe, { url: 'https://x.example/', fetchedAt: 5, data: { hours: 'Mo-Su 08:00-18:00', phone: '+2 222', priceRange: '$$', menuUrl: 'https://x.example/menu', instagram: 'https://instagram.com/x', cuisine: ['Coffee'] } });
  assert.equal(out.hours, 'Mo-Su 08:00-18:00');
  assert.equal(out.details.phone, '+1 111'); // OSM's phone kept
  assert.deepEqual([out.details.priceRange, out.details.menuUrl, out.details.instagram, out.details.cuisine], ['$$', 'https://x.example/menu', 'https://instagram.com/x', ['Coffee']]);
  assert.deepEqual(out.enriched.fields.sort(), ['cuisine', 'hours', 'instagram', 'menu', 'price range']);
  assert.equal(cafe.hours, null); // original untouched
  assert.equal(applyEnrichment(cafe, null), cafe);
  assert.equal(applyEnrichment(cafe, { data: {} }).enriched, undefined);
});

test('queue: dedupes, skips cafes already saved, never runs two on one host, respects concurrency, reports pending', async () => {
  const saved = new Map(), active = new Set(), hostActive = new Map();
  let maxRunning = 0, maxPerHost = 0;
  const run = async (url) => {
    const host = new URL(url).hostname;
    active.add(url); hostActive.set(host, (hostActive.get(host) || 0) + 1);
    maxRunning = Math.max(maxRunning, active.size); maxPerHost = Math.max(maxPerHost, hostActive.get(host));
    await new Promise((r) => setTimeout(r, 15));
    active.delete(url); hostActive.set(host, hostActive.get(host) - 1);
    return url.includes('bad') ? Promise.reject(new Error('boom')) : { status: 'ok', data: { phone: '123' }, url };
  };
  const q = createEnricher({ has: (id) => id === 'old', save: (id, status) => saved.set(id, status), run, concurrency: 3, hostDelayMs: 5 });
  const cafes = [
    { id: 'a', website: 'a.example' }, { id: 'a2', website: 'a.example/page2' }, { id: 'a3', website: 'a.example/page3' }, // same host
    { id: 'b', website: 'b.example' }, { id: 'c', website: 'c.example' }, { id: 'bad', website: 'bad.example' },
    { id: 'old', website: 'old.example' }, { id: 'none', website: null }, { id: 'evil', website: 'http://127.0.0.1/' }, { id: 'a', website: 'a.example' }, // duplicate
  ];
  assert.equal(q.enqueue(cafes), 6);
  assert.equal(q.pending(['a', 'b', 'old', 'none']), 2);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(q.pending(['a', 'a2', 'a3', 'b', 'c', 'bad']), 0);
  assert.deepEqual([...saved.keys()].sort(), ['a', 'a2', 'a3', 'b', 'bad', 'c']);
  assert.equal(saved.get('bad'), 'error'); assert.equal(saved.get('a'), 'ok');
  assert.ok(maxRunning <= 3, `concurrency ${maxRunning}`); assert.equal(maxPerHost, 1);
});

test('queue: stops accepting when full', () => {
  const q = createEnricher({ has: () => false, save() {}, run: () => new Promise(() => {}), concurrency: 1, maxQueue: 3 });
  assert.equal(q.enqueue(Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, website: `h${i}.example` }))), 3 + 0 || 3);
});
