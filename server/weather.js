// Current weather from Open-Meteo (free, no API key; weather data by Open-Meteo.com, CC BY 4.0).
// Used for one thing: a tip like "lovely weather, outdoor seating is worth a look".

const BASE = () => process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast'; // overridable for tests

// WMO weather codes -> an icon and a short description
function wmo(code, isDay) {
  if (code === 0) return isDay ? ['☀️', 'Clear'] : ['🌙', 'Clear'];
  if (code === 1) return isDay ? ['🌤️', 'Mostly clear'] : ['🌙', 'Mostly clear'];
  if (code === 2) return ['⛅', 'Partly cloudy'];
  if (code === 3) return ['☁️', 'Overcast'];
  if (code === 45 || code === 48) return ['🌫️', 'Fog'];
  if (code >= 51 && code <= 57) return ['🌦️', 'Drizzle'];
  if (code >= 61 && code <= 67) return ['🌧️', 'Rain'];
  if (code >= 71 && code <= 77) return ['❄️', 'Snow'];
  if (code >= 80 && code <= 82) return ['🌦️', 'Showers'];
  if (code === 85 || code === 86) return ['🌨️', 'Snow showers'];
  if (code >= 95) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', 'Unknown'];
}

const WET = (code) => (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;

/**
 * @param {{temperature_2m:number, apparent_temperature:number, precipitation:number, weather_code:number, is_day:number, wind_speed_10m:number}} c
 * @returns {{temp:number, feelsLike:number, icon:string, text:string, isDay:boolean, tip:{kind:'outdoor'|'indoor'|'aircon', message:string}|null}}
 */
export function describeWeather(c) {
  const temp = Math.round(c.temperature_2m), feels = Math.round(c.apparent_temperature);
  const isDay = c.is_day === 1;
  const [icon, text] = wmo(c.weather_code, isDay);
  let tip = null;
  if (c.precipitation > 0 || WET(c.weather_code)) tip = { kind: 'indoor', message: 'It’s wet out. Cafes with indoor seating are the safer bet.' };
  else if (feels >= 33) tip = { kind: 'aircon', message: `Hot out there (feels like ${feels}°). Air-conditioned cafes will be more comfortable.` };
  else if (feels <= 8) tip = { kind: 'indoor', message: `Chilly (feels like ${feels}°). Cosy indoor seating will feel better.` };
  else if (isDay && c.weather_code <= 2 && feels >= 16 && feels <= 31 && c.wind_speed_10m < 30) tip = { kind: 'outdoor', message: `Lovely weather (${temp}°). Cafes with outdoor seating are worth a look.` };
  return { temp, feelsLike: feels, icon, text, isDay, tip };
}

const TTL_MS = 15 * 60e3;
const cache = new Map();

/** Weather near a point. Coordinates are rounded to ~1 km before being sent (no need to share your exact position). */
export async function fetchWeather(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = `${BASE()}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,apparent_temperature,precipitation,weather_code,is_day,wind_speed_10m&timezone=auto`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`Weather service returned ${r.status}`);
  const c = (await r.json()).current;
  const needed = ['temperature_2m', 'apparent_temperature', 'precipitation', 'weather_code', 'is_day', 'wind_speed_10m'];
  if (!c || needed.some((k) => typeof c[k] !== 'number')) throw new Error('Weather service returned unexpected data');
  const data = describeWeather(c);
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}
