// Security tests: the website reader must never be usable to reach private/internal addresses.
// (ENRICH_ALLOW_PRIVATE is deliberately NOT set in this file.)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateAddress, safeLookup, fetchText, enrichWebsite } from './enrich.js';

delete process.env.ENRICH_ALLOW_PRIVATE;

test('private, loopback, link-local and reserved IPv4 addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '100.63.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('private IPv6 addresses, including IPv4-mapped forms, are rejected', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', 'fec0::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('the DNS lookup used for connecting refuses names that resolve to private addresses', async () => {
  const err = await new Promise((resolve) => safeLookup('localhost', { all: true }, (e) => resolve(e)));
  assert.match(String(err?.message), /blocked/);
});

test('fetchText refuses private targets, odd schemes, credentials and unusual ports', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3/', 'file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/', 'http://example.com:6379/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://intranet.local/']) {
    await assert.rejects(fetchText(url), /blocked/, url);
  }
});

test('a real local server is never contacted, even when the page address looks innocent', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('<html>secret</html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const r = await enrichWebsite(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 'none'); // normalizeWebsite refuses it before any request is made
    await assert.rejects(fetchText(`http://localhost:${port}/`), /blocked/);
    assert.equal(hits, 0, 'the local server must not receive any request');
  } finally { srv.close(); }
});
