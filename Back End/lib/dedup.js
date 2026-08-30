'use strict';
/* =====================================================================
   DEDUPLICATION — ported from the original client-side dedup.js logic.
   Runs server-side against rows already in the database so duplicate
   detection can't be bypassed by a client that skips it.
   ===================================================================== */

const RADIUS_METERS = 150.0;
const TEXT_SIM_THRESHOLD = 0.22;
const MIN_SHARED_TOKENS = 2;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'there', 'here', 'my', 'our', 'your', 'i',
  'we', 'you', 'he', 'she', 'it', 'they', 'them', 'me', 'us', 'to', 'of', 'in',
  'on', 'at', 'for', 'with', 'and', 'or', 'but', 'so', 'very', 'please', 'near',
  'outside', 'around', 'again', 'also', 'not', 'has', 'have', 'had', 'do',
  'does', 'did', 'will', 'would', 'can', 'could', 'hai', 'hain', 'ka', 'ki',
  'ke', 'se', 'me', 'mein', 'ho', 'raha', 'rahi',
]);

function tokenize(text) {
  const words = (String(text || '').toLowerCase().match(/[a-z0-9]+/g)) || [];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 1));
}

function jaccard(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return [0, 0];
  const shared = [...A].filter((x) => B.has(x));
  const union = new Set([...A, ...B]);
  return [shared.length / union.size, shared.length];
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @param {string} newText
 * @param {number} lat
 * @param {number} lon
 * @param {Array<{id:number, text:string, lat:number, lon:number}>} candidates
 * @returns {{id:number, text:string}|null}
 */
function findDuplicate(newText, lat, lon, candidates) {
  if (lat == null || lon == null || !candidates.length) return null;
  const geoClose = candidates.filter(
    (c) => c.lat != null && c.lon != null && haversine(lat, lon, c.lat, c.lon) <= RADIUS_METERS,
  );
  let best = null;
  let bestSim = 0;
  for (const c of geoClose) {
    const [sim, shared] = jaccard(newText, c.text);
    if (sim >= TEXT_SIM_THRESHOLD && shared >= MIN_SHARED_TOKENS && sim > bestSim) {
      best = c;
      bestSim = sim;
    }
  }
  return best;
}

module.exports = { RADIUS_METERS, TEXT_SIM_THRESHOLD, MIN_SHARED_TOKENS, tokenize, jaccard, haversine, findDuplicate };
