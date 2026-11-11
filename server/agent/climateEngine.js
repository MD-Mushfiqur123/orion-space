/**
 * @file climateEngine.js
 * @module server/agent/climateEngine
 * @description Deterministic scientific engine backed by the reproducible
 * NASA POWER / MERRA-2 trend dataset (analysis/results/t2m_trends_by_cell_month.csv).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../analysis/results/t2m_trends_by_cell_month.csv',
);

const VALID_MONTHS = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'Annual',
]);

const MONTH_ALIASES = Object.freeze({
  jan: 'January',
  january: 'January',
  জানুয়ারি: 'January',
  জানুয়ারি: 'January',
  feb: 'February',
  february: 'February',
  ফেব্রুয়ারি: 'February',
  ফেব্রুয়ারি: 'February',
  mar: 'March',
  march: 'March',
  মার্চ: 'March',
  apr: 'April',
  april: 'April',
  এপ্রিল: 'April',
  may: 'May',
  মে: 'May',
  jun: 'June',
  june: 'June',
  জুন: 'June',
  jul: 'July',
  july: 'July',
  জুলাই: 'July',
  aug: 'August',
  august: 'August',
  আগস্ট: 'August',
  sep: 'September',
  sept: 'September',
  september: 'September',
  সেপ্টেম্বর: 'September',
  oct: 'October',
  october: 'October',
  অক্টোবর: 'October',
  nov: 'November',
  november: 'November',
  নভেম্বর: 'November',
  dec: 'December',
  december: 'December',
  ডিসেম্বর: 'December',
  annual: 'Annual',
  yearly: 'Annual',
  mean: 'Annual',
  বার্ষিক: 'Annual',
});

function parseBool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Normalize user or model month strings into canonical dataset month names. */
export function normalizeMonthName(raw) {
  if (!raw) return 'September';
  const cleaned = String(raw).trim().normalize('NFC').toLowerCase();
  if (MONTH_ALIASES[cleaned]) return MONTH_ALIASES[cleaned];
  for (const month of VALID_MONTHS) {
    if (month.toLowerCase() === cleaned) return month;
  }
  return 'September';
}

/** Parse t2m_trends_by_cell_month.csv into typed rows. */
export function parseTrendsCsv(csvText) {
  const lines = String(csvText || '')
    .trim()
    .split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts.length !== headers.length) continue;
    const raw = Object.fromEntries(headers.map((h, idx) => [h, parts[idx]]));
    rows.push({
      latitude: Number(raw.latitude),
      longitude: Number(raw.longitude),
      insideBangladesh: parseBool(raw.inside_bangladesh),
      month: raw.month,
      nYears: Number(raw.n_years),
      mkS: Number(raw.mk_S),
      mkZ: Number(raw.mk_Z),
      pValue: Number(raw.p_value),
      senSlopePerDecade: Number(raw.sen_slope_c_per_decade),
      lag1R: Number(raw.lag1_r),
      prewhitened: parseBool(raw.prewhitened),
      pValueTfpw: Number(raw.p_value_tfpw),
      significantP05: parseBool(raw.significant_p05),
      significantFdr05: parseBool(raw.significant_fdr05),
      significantFdr05Tfpw: parseBool(raw.significant_fdr05_tfpw),
    });
  }
  return rows;
}

/** Create a deterministic scientific climate engine over the MERRA-2 trend table. */
export function createClimateEngine({ csvPath = DEFAULT_CSV_PATH, rows } = {}) {
  const allRows = Array.isArray(rows)
    ? rows
    : parseTrendsCsv(readFileSync(csvPath, 'utf8'));

  const insideRows = allRows.filter((r) => r.insideBangladesh);
  const insideCellsMap = new Map();
  for (const row of insideRows) {
    const key = `${row.latitude},${row.longitude}`;
    if (!insideCellsMap.has(key)) {
      insideCellsMap.set(key, {
        latitude: row.latitude,
        longitude: row.longitude,
      });
    }
  }
  const insideCells = [...insideCellsMap.values()];

  const byCellMonth = new Map();
  for (const row of allRows) {
    byCellMonth.set(`${row.latitude},${row.longitude}:${row.month}`, row);
  }

  function nearestInsideCell(lat, lon) {
    let best = null;
    let bestDistSq = Infinity;
    for (const cell of insideCells) {
      const dLat = cell.latitude - lat;
      const dLon = cell.longitude - lon;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = cell;
      }
    }
    return best;
  }

  function queryCellMonth({ lat, lon, month = 'September' }) {
    const canonicalMonth = normalizeMonthName(month);
    const cell = nearestInsideCell(Number(lat), Number(lon));
    if (!cell) return null;
    const record = byCellMonth.get(
      `${cell.latitude},${cell.longitude}:${canonicalMonth}`,
    );
    const annual = byCellMonth.get(`${cell.latitude},${cell.longitude}:Annual`);
    if (!record) return null;
    return {
      cell,
      month: canonicalMonth,
      record,
      annualRecord: annual || null,
    };
  }

  function queryMonthSummary({ month = 'September' }) {
    const canonicalMonth = normalizeMonthName(month);
    const matches = insideRows.filter((r) => r.month === canonicalMonth);
    const slopes = matches.map((r) => r.senSlopePerDecade);
    const p05Count = matches.filter((r) => r.significantP05).length;
    const fdrCount = matches.filter((r) => r.significantFdr05).length;
    const fastest = [...matches].sort(
      (a, b) => b.senSlopePerDecade - a.senSlopePerDecade,
    )[0];
    return {
      month: canonicalMonth,
      cellCount: matches.length,
      medianSenSlopePerDecade: Number(median(slopes).toFixed(3)),
      significantP05Count: p05Count,
      significantFdr05Count: fdrCount,
      fastestCell: fastest || null,
    };
  }

  function querySignificanceOverview() {
    const monthly = VALID_MONTHS.map((m) => queryMonthSummary({ month: m }));
    return {
      totalCells: insideCells.length,
      totalTests: insideRows.length,
      significantP05Total: insideRows.filter((r) => r.significantP05).length,
      significantFdr05Total: insideRows.filter((r) => r.significantFdr05)
        .length,
      prewhitenedCount: insideRows.filter((r) => r.prewhitened).length,
      significantFdr05TfpwTotal: insideRows.filter(
        (r) => r.significantFdr05Tfpw,
      ).length,
      september: monthly.find((m) => m.month === 'September'),
      october: monthly.find((m) => m.month === 'October'),
      annual: monthly.find((m) => m.month === 'Annual'),
      monthly,
    };
  }

  function queryFastestWarming({ fdrOnly = true, limit = 5 } = {}) {
    const pool = fdrOnly
      ? insideRows.filter((r) => r.significantFdr05)
      : insideRows;
    const sorted = [...pool].sort(
      (a, b) => b.senSlopePerDecade - a.senSlopePerDecade,
    );
    const barisalSep = byCellMonth.get('22.5,90:September') || null;
    return {
      fdrOnly,
      topCells: sorted.slice(0, Math.max(1, Math.min(10, limit))),
      barisalCoastSeptember: barisalSep,
      septemberSummary: queryMonthSummary({ month: 'September' }),
      octoberSummary: queryMonthSummary({ month: 'October' }),
    };
  }

  return {
    totalRows: allRows.length,
    insideCellCount: insideCells.length,
    queryCellMonth,
    queryMonthSummary,
    querySignificanceOverview,
    queryFastestWarming,
  };
}
