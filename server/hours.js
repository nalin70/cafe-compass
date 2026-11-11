import OpeningHours from 'opening_hours';
import tzLookup from 'tz-lookup';

// Works out "Open · closes 18:00" / "Closed · opens Mon 08:00" from an OpenStreetMap opening_hours string.
// The cafe's own timezone is used (found from its coordinates), so a cafe in Tokyo is judged by Tokyo time
// even if you're searching from India.

const tzCache = new Map();
function timezoneFor(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (!tzCache.has(key)) {
    try { tzCache.set(key, tzLookup(lat, lon)); } catch { tzCache.set(key, null); }
  }
  return tzCache.get(key);
}

// The library reads the *local* fields of a Date, so build a Date whose local fields show the cafe's wall-clock time.
function wallClock(now, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type) => +parts.find((p) => p.type === type).value;
  return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayName = (d) => d.toLocaleDateString('en-GB', { weekday: 'short' });

// "2026-11-07T20:00" (a time picked in the page) -> a Date whose local fields hold that wall-clock time, or null.
export function parseWall(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // reject values that merely roll over (month 13, hour 99, Feb 30 ...)
  const same = d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] && d.getHours() === +m[4] && d.getMinutes() === +m[5];
  return same ? d : null;
}

const SOON_MIN = 60;

/**
 * @returns {{state: 'open'|'closed'|'unknown', label: string|null, soon?: true}}
 * `soon` is set when it closes (or opens) within the hour.
 * `now` is injectable for tests; `atWall` is a wall-clock time in the cafe's timezone (see parseWall).
 */
export function openStatus(hours, { lat, lon }, now = new Date(), atWall = null) {
  const unknown = { state: 'unknown', label: null };
  if (!hours) return unknown;
  const tz = timezoneFor(lat, lon);
  if (!tz) return unknown;
  try {
    const oh = new OpeningHours(hours, { lat, lon });
    const t = atWall ?? wallClock(now, tz); // atWall: a time the user picked, already in the cafe's local wall-clock
    if (oh.getUnknown(t)) return unknown; // e.g. "by appointment" or a comment-only rule
    const next = oh.getNextChange(t);
    if (oh.getState(t)) {
      if (!next) return { state: 'open', label: 'Open 24/7' };
      const hoursAway = (next - t) / 36e5;
      if (hoursAway > 48) return { state: 'open', label: 'Open' };
      const mins = Math.round((next - t) / 6e4);
      if (mins <= SOON_MIN) return { state: 'open', label: `Open · closes in ${Math.max(mins, 1)} min`, soon: true };
      return { state: 'open', label: sameDay(next, t) ? `Open · closes ${hhmm(next)}` : `Open · closes ${dayName(next)} ${hhmm(next)}` };
    }
    if (!next) return { state: 'closed', label: 'Closed' };
    const minsToOpen = Math.round((next - t) / 6e4);
    if (minsToOpen <= SOON_MIN) return { state: 'closed', label: `Closed · opens in ${Math.max(minsToOpen, 1)} min`, soon: true };
    const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    const when = sameDay(next, t) ? hhmm(next) : sameDay(next, tomorrow) ? `tomorrow ${hhmm(next)}` : `${dayName(next)} ${hhmm(next)}`;
    return { state: 'closed', label: `Closed · opens ${when}` };
  } catch {
    return unknown; // unparseable opening_hours values are common in OSM
  }
}
