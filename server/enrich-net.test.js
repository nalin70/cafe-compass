// Network behaviour of the website reader, against a fake website on localhost (ENRICH_ALLOW_PRIVATE=1 lets tests reach it).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

process.env.ENRICH_ALLOW_PRIVATE = '1';
const { enrichWebsite, fetchText } = await import('./enrich.js');

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const good = `<html><head>${ld({ '@type': 'CafeOrCoffeeShop', telephone: '+91 98765 43210', openingHours: 'Mo-Su 08:00-22:00', priceRange: '₹₹' })}</head><body>ok</body></html>`;
const hits = {};
const site = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  const html = (body, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
  switch (req.url) {
    case '/robots.txt': res.writeHead(404); return res.end();
    case '/': return html(good);
    case '/gzip': return html(zlib.gzipSync(good), { 'content-encoding': 'gzip' });
    case '/br': return html(zlib.brotliCompressSync(good), { 'content-encoding': 'br' });
    case '/redirect': res.writeHead(302, { location: '/' }); return res.end();
    case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
    case '/to-private': res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end();
    case '/pdf': res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF');
    case '/notfound': res.writeHead(404, { 'content-type': 'text/html' }); return res.end('nope');
    case '/huge': { res.writeHead(200, { 'content-type': 'text/html' }); res.write(good); for (let i = 0; i < 400; i++) res.write('x'.repeat(10000)); return res.end(); }
    case '/bomb': return html(zlib.gzipSync(good + ' '.repeat(40_000_000)), { 'content-encoding': 'gzip' }); // tiny download, 40 MB when unpacked
    case '/slow': return; // never answers
    default: res.writeHead(404); return res.end();
  }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
test.after(() => site.close());

test('reads a normal page (and its missing robots.txt means "allowed")', async () => {
  const r = await enrichWebsite(`${base}/`);
  assert.equal(r.status, 'ok');
  assert.deepEqual([r.data.hours, r.data.phone, r.data.priceRange], ['Mo-Su 08:00-22:00', '+91 98765 43210', '₹₹']);
});

test('handles gzip and brotli, and follows a redirect', async () => {
  for (const p of ['/gzip', '/br', '/redirect']) assert.equal((await enrichWebsite(`${base}${p}`)).status, 'ok', p);
});

test('refuses a redirect to a private address', async () => {
  await assert.rejects(fetchText(`${base}/to-private`), /blocked/); // 169.254.x is blocked even with the local-server test override
  assert.equal((await enrichWebsite(`${base}/to-private`)).status, 'error');
});

test('gives up on redirect loops, non-HTML, missing pages and unresponsive sites', async () => {
  assert.equal((await enrichWebsite(`${base}/loop`)).status, 'error');
  assert.equal((await enrichWebsite(`${base}/pdf`)).status, 'none');
  assert.equal((await enrichWebsite(`${base}/notfound`)).status, 'error');
});

test('caps the size read, including after decompression (no memory blow-up)', async () => {
  const big = await fetchText(`${base}/huge`);
  assert.equal(big.truncated, true); assert.ok(big.body.length <= 1_500_000);
  const bomb = await fetchText(`${base}/bomb`);
  assert.equal(bomb.truncated, true); assert.ok(bomb.body.length <= 1_500_000, `read ${bomb.body.length} bytes`);
  assert.equal((await enrichWebsite(`${base}/huge`)).status, 'ok'); // the useful part was at the top
});

test('sends an honest User-Agent and asks for HTML', async () => {
  let seen;
  const probe = http.createServer((req, res) => { seen = req.headers; res.writeHead(404); res.end(); });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  try { await fetchText(`http://127.0.0.1:${probe.address().port}/`); } finally { probe.close(); }
  assert.match(seen['user-agent'], /^cafe-finder\//); assert.match(seen.accept, /text\/html/);
});

test('respects robots.txt', async () => {
  const blocked = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
    hits.blockedPageFetched = true; res.writeHead(200, { 'content-type': 'text/html' }); res.end(good);
  });
  await new Promise((r) => blocked.listen(0, '127.0.0.1', r));
  try {
    const r = await enrichWebsite(`http://127.0.0.1:${blocked.address().port}/`);
    assert.equal(r.status, 'blocked'); assert.equal(hits.blockedPageFetched, undefined, 'the page itself must not be fetched');
  } finally { blocked.close(); }
});

test('a robots.txt server error means "try later", not "go ahead"', async () => {
  const flaky = http.createServer((req, res) => { if (req.url === '/robots.txt') { res.writeHead(503); return res.end(); } hits.flakyPageFetched = true; res.writeHead(200, { 'content-type': 'text/html' }); res.end(good); });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await enrichWebsite(`http://127.0.0.1:${flaky.address().port}/`)).status, 'error');
    assert.equal(hits.flakyPageFetched, undefined);
  } finally { flaky.close(); }
});
