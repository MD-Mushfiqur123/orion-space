/**
 * @file toolRegistry.js
 * @module server/agent/toolRegistry
 * @description Strict allowlisted tool registry for Orion Agent backend.
 * Wraps local district geospatial lookup, MERRA-2 trend engine, Open-Meteo
 * server-side weather, and NASA FIRMS cache/proxy. Never executes arbitrary URLs or shell.
 */

import {
  BANGLADESH_DISTRICTS,
  findDistrictSector,
} from '../../src/agent/bangladeshDistricts.js';
import { ALLOWED_TOOL_NAMES } from '../../src/agent/agentContract.js';
import { weatherCodeLabel } from '../../src/data/regionalModel.js';
import { fetchRegionalWeather } from '../providers/regional/weather.js';
import { createClimateEngine, normalizeMonthName } from './climateEngine.js';
import { queryActiveFires } from './firmsTool.js';

const EXTRA_SECTORS = Object.freeze({
  sundarbans: {
    id: 'sundarbans',
    name: 'Sundarbans Mangrove Delta & Coastal Front',
    bnName: 'সুন্দরবন',
    division: 'Khulna',
    lat: 21.9497,
    lon: 89.5403,
  },
  kuakata: {
    id: 'kuakata',
    name: 'Payra Port & Kuakata Coastal Seawall',
    bnName: 'কুয়াকাটা',
    division: 'Barisal',
    lat: 21.8167,
    lon: 90.1167,
  },
  bay_of_bengal: {
    id: 'bay_of_bengal',
    name: 'Bay of Bengal EEZ Maritime Sector',
    bnName: 'বঙ্গোপসাগর',
    division: 'Maritime',
    lat: 20.2,
    lon: 89.8,
  },
  bangladesh: {
    id: 'bangladesh',
    name: "People's Republic of Bangladesh",
    bnName: 'বাংলাদেশ',
    division: 'National',
    lat: 23.685,
    lon: 90.3563,
  },
});

/** OpenAI-compatible tool definitions exposed to Qwen3-0.6B. */
export const AGENT_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'resolve_bangladesh_location',
      description:
        'Resolve a Bangladesh district, upazila, coastal sector, or Bangla/Banglish place name to coordinates and sector id.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description:
              'District or sector name in English, Banglish, or Bangla.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_climate_trends',
      description:
        'Query reproducible 2001-2025 NASA MERRA-2 2m temperature trend metrics (Mann-Kendall, Theil-Sen slope, Benjamini-Hochberg FDR).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: [
              'cell_month',
              'month_summary',
              'fastest_warming',
              'significance_overview',
              'seasonal_dissociation',
            ],
          },
          districtId: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lon: { type: 'number', minimum: -180, maximum: 180 },
          month: { type: 'string' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_live_weather',
      description:
        'Fetch live current weather conditions (temperature, precipitation, wind, clouds) for a Bangladesh district or coordinate.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          districtId: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lon: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_active_fires',
      description:
        'Check NASA FIRMS VIIRS/MODIS active fire detections over Bangladesh or near a district in the trailing 24 hours.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          districtId: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lon: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_crop_advisory',
      description:
        'Generate climate-informed Bangladesh agricultural guidance combining live weather and observed MERRA-2 warming trends.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          districtId: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lon: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  },
]);

export function resolveSectorRecord(queryOrId) {
  if (!queryOrId || typeof queryOrId !== 'string') return null;
  const cleaned = queryOrId.trim().normalize('NFC').toLowerCase();
  if (BANGLADESH_DISTRICTS[cleaned]) return BANGLADESH_DISTRICTS[cleaned];
  if (EXTRA_SECTORS[cleaned]) return EXTRA_SECTORS[cleaned];
  const matched = findDistrictSector(cleaned);
  if (matched) return matched;
  if (cleaned.includes('sundarban') || cleaned.includes('সুন্দরবন')) {
    return EXTRA_SECTORS.sundarbans;
  }
  if (cleaned.includes('kuakata') || cleaned.includes('কুয়াকাটা')) {
    return EXTRA_SECTORS.kuakata;
  }
  if (cleaned.includes('bay') || cleaned.includes('বঙ্গোপসাগর')) {
    return EXTRA_SECTORS.bay_of_bengal;
  }
  if (cleaned.includes('bangladesh') || cleaned.includes('বাংলাদেশ')) {
    return EXTRA_SECTORS.bangladesh;
  }
  return null;
}

function resolvePoint({ districtId, lat, lon, fallbackSectorId = 'barisal' }) {
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (nLat >= -90 && nLat <= 90 && nLon >= -180 && nLon <= 180) {
      return {
        sector: resolveSectorRecord(districtId || fallbackSectorId),
        lat: nLat,
        lon: nLon,
      };
    }
  }
  const sector =
    resolveSectorRecord(districtId) ||
    resolveSectorRecord(fallbackSectorId) ||
    BANGLADESH_DISTRICTS.barisal;
  return {
    sector,
    lat: sector.lat,
    lon: sector.lon,
  };
}

/** Build the server-side allowlisted tool executor. */
export function createToolRegistry({
  climateEngine = createClimateEngine(),
  weatherFetcher = fetchRegionalWeather,
  firesFetcher = queryActiveFires,
} = {}) {
  const allowedSet = new Set(ALLOWED_TOOL_NAMES);

  async function executeTool(name, rawArgs = {}, context = {}) {
    if (!allowedSet.has(name)) {
      return { ok: false, error: `Tool "${name}" is not allowlisted.` };
    }
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    const fallbackSectorId = context.activeSectorId || 'barisal';

    switch (name) {
      case 'resolve_bangladesh_location': {
        const query = String(args.query || '')
          .trim()
          .slice(0, 120);
        const match = resolveSectorRecord(query);
        if (!match) {
          return {
            ok: true,
            found: false,
            query,
            sector: null,
          };
        }
        const cellMatch = climateEngine.queryCellMonth({
          lat: match.lat,
          lon: match.lon,
          month: 'September',
        });
        return {
          ok: true,
          found: true,
          sector: {
            id: match.id,
            name: match.name,
            bnName: match.bnName || null,
            division: match.division || null,
            lat: match.lat,
            lon: match.lon,
          },
          nearestMerra2Cell: cellMatch?.cell || null,
        };
      }

      case 'query_climate_trends': {
        const mode = String(args.mode || 'cell_month');
        if (mode === 'fastest_warming') {
          return {
            ok: true,
            mode,
            source: 'NASA POWER / MERRA-2 T2M (2001-2025)',
            ...climateEngine.queryFastestWarming({ fdrOnly: true, limit: 5 }),
          };
        }
        if (
          mode === 'significance_overview' ||
          mode === 'seasonal_dissociation'
        ) {
          return {
            ok: true,
            mode,
            source: 'NASA POWER / MERRA-2 T2M (2001-2025)',
            ...climateEngine.querySignificanceOverview(),
          };
        }
        if (mode === 'month_summary') {
          return {
            ok: true,
            mode,
            source: 'NASA POWER / MERRA-2 T2M (2001-2025)',
            summary: climateEngine.queryMonthSummary({
              month: normalizeMonthName(args.month),
            }),
          };
        }
        const point = resolvePoint({
          districtId: args.districtId,
          lat: args.lat,
          lon: args.lon,
          fallbackSectorId,
        });
        const month = normalizeMonthName(args.month);
        const data = climateEngine.queryCellMonth({
          lat: point.lat,
          lon: point.lon,
          month,
        });
        return {
          ok: Boolean(data),
          mode: 'cell_month',
          source: 'NASA POWER / MERRA-2 T2M (2001-2025)',
          sector: point.sector
            ? {
                id: point.sector.id,
                name: point.sector.name,
                bnName: point.sector.bnName || null,
                lat: point.sector.lat,
                lon: point.sector.lon,
              }
            : null,
          ...data,
        };
      }

      case 'get_live_weather': {
        const point = resolvePoint({
          districtId: args.districtId,
          lat: args.lat,
          lon: args.lon,
          fallbackSectorId,
        });
        const weather = await weatherFetcher({
          latitude: point.lat,
          longitude: point.lon,
        });
        if (!weather) {
          return {
            ok: true,
            status: 'unavailable',
            reason: 'Open-Meteo weather upstream unavailable',
            location: point.sector?.name || `${point.lat}, ${point.lon}`,
            sectorId: point.sector?.id || null,
            coordinates: { lat: point.lat, lon: point.lon },
          };
        }
        return {
          ok: true,
          status: 'ready',
          source: 'Open-Meteo Current Weather API',
          location: point.sector?.name || `${point.lat}, ${point.lon}`,
          sectorId: point.sector?.id || null,
          coordinates: { lat: point.lat, lon: point.lon },
          condition: weatherCodeLabel(weather.weatherCode),
          weather,
        };
      }

      case 'get_active_fires': {
        const hasExplicitPoint =
          Boolean(args.districtId) ||
          (Number.isFinite(Number(args.lat)) &&
            Number.isFinite(Number(args.lon)));
        const point = hasExplicitPoint
          ? resolvePoint({
              districtId: args.districtId,
              lat: args.lat,
              lon: args.lon,
              fallbackSectorId,
            })
          : { sector: null, lat: undefined, lon: undefined };
        const result = await firesFetcher({
          lat: point.lat,
          lon: point.lon,
        });
        return {
          ok: true,
          source: 'NASA FIRMS VIIRS/MODIS NRT (trailing 24h)',
          sectorId: point.sector?.id || null,
          location: point.sector?.name || 'Bangladesh',
          ...result,
        };
      }

      case 'get_crop_advisory': {
        const point = resolvePoint({
          districtId: args.districtId,
          lat: args.lat,
          lon: args.lon,
          fallbackSectorId,
        });
        const [weather, climate] = await Promise.all([
          weatherFetcher({ latitude: point.lat, longitude: point.lon }),
          Promise.resolve(
            climateEngine.queryCellMonth({
              lat: point.lat,
              lon: point.lon,
              month: 'September',
            }),
          ),
        ]);
        const tempC = weather?.temperatureC ?? null;
        const precipMm = weather?.precipitationMm ?? null;
        const sepSlope = climate?.record?.senSlopePerDecade ?? null;
        const recommendations = [];
        if (tempC !== null && tempC >= 32) {
          recommendations.push(
            'High surface heat (>=32°C): irrigate Aman rice in early morning/evening and avoid midday fertilizer top-dressing.',
          );
        } else {
          recommendations.push(
            'Maintain 2–3 cm standing water during Aman reproductive/grain-filling stages and monitor field drainage.',
          );
        }
        if (precipMm !== null && precipMm >= 5) {
          recommendations.push(
            'Active rainfall detected: clear field bund drainage channels before applying urea or pesticides.',
          );
        }
        recommendations.push(
          'Post-monsoon warming signal (September MERRA-2 trend): consider heat-tolerant paddy varieties (e.g. BRRI dhan 75 / 87) and shift early Rabi wheat/mustard sowing 7–10 days if warm anomalies persist.',
        );
        return {
          ok: true,
          advisoryBasis: 'rule-based-climate-plus-live-weather',
          location: point.sector?.name || `${point.lat}, ${point.lon}`,
          sectorId: point.sector?.id || null,
          coordinates: { lat: point.lat, lon: point.lon },
          weatherStatus: weather ? 'ready' : 'unavailable',
          weather,
          septemberTrend: climate?.record || null,
          nearestMerra2Cell: climate?.cell || null,
          recommendations,
        };
      }

      default:
        return { ok: false, error: 'Unsupported tool.' };
    }
  }

  return {
    climateEngine,
    executeTool,
    toolDefinitions: AGENT_TOOL_DEFINITIONS,
  };
}
