import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const sunny = { temperature_2m: 24.4, apparent_temperature: 25.2, precipitation: 0, weather_code: 0, is_day: 1, wind_speed_10m: 8 };

// fake Open-Meteo
let hits = 0, lastUrl = '', payload = { current: sunny }, status = 200;
const srv = http.createServer((req, res) => { hits++; lastUrl = req.url; res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); });
await new Promise((r) => srv.listen(0, r));
process.env.OPEN_METEO_URL = `http://localhost:${srv.address().port}/v1/forecast`;
const { describeWeather, fetchWeather } = await import('./weather.js');
test.after(() => srv.close());

test('nice weather suggests outdoor seating', () => {
  const w = describeWeather(sunny);
  assert.deepEqual([w.temp, w.feelsLike, w.icon, w.text], [24, 25, '☀️', 'Clear']);
  assert.equal(w.tip.kind, 'outdoor'); assert.match(w.tip.message, /24°/);
});

test('rain, drizzle, snow and thunder all suggest indoor seating', () => {
  for (const weather_code of [61, 53, 73, 81, 95]) assert.equal(describeWeather({ ...sunny, weather_code }).tip.kind, 'indoor', `code ${weather_code}`);
  assert.equal(describeWeather({ ...sunny, precipitation: 0.4 }).tip.kind, 'indoor'); // measurable rain even if the code says cloudy
});

test('heat suggests air con; cold suggests indoor; wind, cloud and night suppress the outdoor tip', () => {
  assert.equal(describeWeather({ ...sunny, apparent_temperature: 36 }).tip.kind, 'aircon');
  assert.equal(describeWeather({ ...sunny, apparent_temperature: 4 }).tip.kind, 'indoor');
  assert.equal(describeWeather({ ...sunny, wind_speed_10m: 45 }).tip, null);
  assert.equal(describeWeather({ ...sunny, weather_code: 3 }).tip, null);
  const night = describeWeather({ ...sunny, is_day: 0 });
  assert.equal(night.tip, null); assert.equal(night.icon, '🌙'); // no sun at night
});

test('fetchWeather sends rounded coordinates, caches, and validates the response', async () => {
  hits = 0;
  const w = await fetchWeather(51.52346, -0.07891);
  assert.equal(w.tip.kind, 'outdoor');
  const q = new URL(lastUrl, 'http://x').searchParams;
  assert.equal(q.get('latitude'), '51.52'); assert.equal(q.get('longitude'), '-0.08'); // not the exact position
  await fetchWeather(51.5301, -0.0805); // same ~10 km cell -> cached
  assert.equal(hits, 1);
  payload = { current: { temperature_2m: 'hot' } };
  await assert.rejects(fetchWeather(10.5, 10.5), /unexpected data/);
  payload = {}; status = 500;
  await assert.rejects(fetchWeather(20.5, 20.5), /returned 500/);
});
