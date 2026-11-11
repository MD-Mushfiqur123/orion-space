/**
 * @file firmsTool.js
 * @module server/agent/firmsTool
 * @description Server-side NASA FIRMS active-fire lookup reusing the repository's
 * .gev-cache/firms.json cache and src/data/firmsCsv.js parser.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';

const BANGLADESH_BBOX = Object.freeze({
  minLat: 20.5,
  maxLat: 26.7,
  minLon: 88.0,
  maxLon: 92.7,
});

const TTL_MS = 30 * 60_000;

/**
 * Query NASA FIRMS detections within Bangladesh or around a coordinate.
 * Never returns synthetic counts when FIRMS_MAP_KEY and cache are unavailable.
 */
export async function queryActiveFires({
  lat,
  lon,
  radiusDeg = 0.75,
  cachePath = path.join(process.cwd(), '.gev-cache', 'firms.json'),
  firmsMapKey = String(process.env.FIRMS_MAP_KEY || '').trim(),
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let fires = null;
  let fetchedAt = null;
  let stale = false;

  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.fires)) {
      fires = filterTrailing24h(parsed.fires, now());
      fetchedAt = parsed.at;
      stale = now() - parsed.at >= TTL_MS;
    }
  } catch {
    // No disk cache yet; fall back to direct fetch only if key is configured.
  }

  if ((!fires || stale) && firmsMapKey) {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(firmsMapKey)}/VIIRS_NOAA20_NRT/world/2`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const parsed = parseFirmsCsv(await res.text());
        if (parsed !== null) {
          fires = filterTrailing24h(parsed, now());
          fetchedAt = now();
          stale = false;
        }
      }
    } catch {
      // Fall back to stale cache if present, else unavailable below.
    }
  }

  if (!fires) {
    return {
      status: 'unavailable',
      reason: firmsMapKey
        ? 'FIRMS upstream unavailable and no local cache present'
        : 'FIRMS_MAP_KEY not configured and no local cache present',
      count: null,
      detections: [],
    };
  }

  const hasPoint = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  const minLat = hasPoint ? Number(lat) - radiusDeg : BANGLADESH_BBOX.minLat;
  const maxLat = hasPoint ? Number(lat) + radiusDeg : BANGLADESH_BBOX.maxLat;
  const minLon = hasPoint ? Number(lon) - radiusDeg : BANGLADESH_BBOX.minLon;
  const maxLon = hasPoint ? Number(lon) + radiusDeg : BANGLADESH_BBOX.maxLon;

  const matches = fires.filter((f) => {
    const fLat = Number(f.lat ?? f.latitude);
    const fLon = Number(f.lon ?? f.longitude);
    return (
      Number.isFinite(fLat) &&
      Number.isFinite(fLon) &&
      fLat >= minLat &&
      fLat <= maxLat &&
      fLon >= minLon &&
      fLon <= maxLon
    );
  });

  return {
    status: 'ready',
    stale,
    fetchedAt,
    scope: hasPoint ? 'local_radius' : 'bangladesh',
    count: matches.length,
    detections: matches.slice(0, 10),
  };
}
