/**
 * @file orchestrator.js
 * @module server/agent/orchestrator
 * @description Hybrid agent orchestrator for Orion Space.
 * Combines Qwen3-0.6B tool planning (when configured) with deterministic
 * scientific tool execution, grounded evidence cards, and safe fallbacks.
 */

import {
  sanitizeEvidenceCard,
  sanitizeMapActions,
  validateAgentRequestPayload,
} from '../../src/agent/agentContract.js';
import { BANGLADESH_DISTRICTS } from '../../src/agent/bangladeshDistricts.js';
import { normalizeMonthName } from './climateEngine.js';
import { resolveSectorRecord } from './toolRegistry.js';

const VALID_SECTOR_IDS = new Set([
  ...Object.keys(BANGLADESH_DISTRICTS),
  'sundarbans',
  'kuakata',
  'bay_of_bengal',
  'bangladesh',
]);

const SYSTEM_PROMPT = [
  'You are Orion Intelligence Agent (Orion-0.6B v0.1) for Bangladesh Earth System Trend Detective.',
  'Always call the allowlisted tools before answering climate, weather, fire, crop, or district questions.',
  'NEVER invent temperature trends, Sen slopes, p-values, FDR counts, weather metrics, or fire detections.',
  'Key verified baseline facts from NASA MERRA-2 (2001-2025, 34 cells in Bangladesh):',
  '- Annual mean has 0 of 34 significant cells (median +0.021 C/decade).',
  '- September warms significantly in 34 of 34 cells at p<0.05 and 31 of 34 after Benjamini-Hochberg FDR (q=0.05); Barisal coast (22.5N, 90.0E) is +0.40 C/decade (p=0.00007).',
  '- October shows 29 of 34 cells at p<0.05 (median +0.389 C/decade) but 0 of 34 survive BH FDR, so never claim October passes FDR.',
  'If a tool reports unavailable, state that honestly. Respond concisely in the user language (Bangla, Banglish, or English).',
  'Return plain text or JSON {"answer": "...", "speech": "...", "sectorId": "..."} grounded strictly in tool outputs.',
].join('\n');

function detectLanguage(text) {
  return /[\u0980-\u09FF]/.test(String(text || '')) ? 'bn' : 'en';
}

function detectMonthFromQuery(text) {
  const lower = String(text || '').toLowerCase();
  const candidates = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'annual',
    'জানুয়ারি',
    'ফেব্রুয়ারি',
    'মার্চ',
    'এপ্রিল',
    'মে',
    'জুন',
    'জুলাই',
    'আগস্ট',
    'সেপ্টেম্বর',
    'অক্টোবর',
    'নভেম্বর',
    'ডিসেম্বর',
    'বার্ষিক',
  ];
  for (const token of candidates) {
    if (lower.includes(token)) return normalizeMonthName(token);
  }
  return 'September';
}

function parseJsonObjectSafe(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function formatPValue(p) {
  if (!Number.isFinite(p)) return 'N/A';
  if (p < 0.0001) return `p = ${p.toFixed(5)}`;
  return `p = ${p.toFixed(4)}`;
}

function buildEvidenceFromTools(
  toolOutputs,
  fallbackTitle = 'ORION CLIMATE EVIDENCE',
) {
  for (let i = toolOutputs.length - 1; i >= 0; i--) {
    const { name, result } = toolOutputs[i];
    if (!result || !result.ok) continue;

    if (name === 'query_climate_trends') {
      if (result.mode === 'fastest_warming' && result.barisalCoastSeptember) {
        const b = result.barisalCoastSeptember;
        return sanitizeEvidenceCard({
          title: 'SEPTEMBER WARMING HOTSPOT',
          sector: 'Barisal Coastal Belt [22.5°N, 90.0°E]',
          slope: `+${b.senSlopePerDecade.toFixed(2)}°C / decade (September, 2001–2025)`,
          senSlope: `+${(b.senSlopePerDecade / 10).toFixed(3)}°C / year (Theil-Sen)`,
          pValue: `${formatPValue(b.pValue)} (Mann-Kendall)`,
          significance: b.significantFdr05
            ? 'SIGNIFICANT AFTER FDR (q = 0.05)'
            : 'NOT FDR SIGNIFICANT',
          narrative: `September warms in ${result.septemberSummary.significantP05Count} of 34 cells (median +${result.septemberSummary.medianSenSlopePerDecade.toFixed(2)}°C/decade) and ${result.septemberSummary.significantFdr05Count} of 34 survive FDR. Annual mean shows 0 of 34 significant.`,
        });
      }
      if (
        result.mode === 'significance_overview' ||
        result.mode === 'seasonal_dissociation'
      ) {
        const sep = result.september;
        const oct = result.october;
        const ann = result.annual;
        return sanitizeEvidenceCard({
          title:
            result.mode === 'seasonal_dissociation'
              ? 'SEASONAL DISSOCIATION (MERRA-2)'
              : 'MANN-KENDALL & FDR PROOF',
          sector: `Bangladesh (${result.totalCells} MERRA-2 grid cells)`,
          slope: `Sep: +${sep.medianSenSlopePerDecade.toFixed(2)}°C/dec | Oct: +${oct.medianSenSlopePerDecade.toFixed(2)}°C/dec | Annual: +${ann.medianSenSlopePerDecade.toFixed(2)}°C/dec`,
          senSlope: `Significant at p<0.05: Sep ${sep.significantP05Count}/34, Oct ${oct.significantP05Count}/34, Annual ${ann.significantP05Count}/34`,
          pValue: `After BH FDR (q=0.05): Sep ${sep.significantFdr05Count}/34, Oct ${oct.significantFdr05Count}/34`,
          significance: `${result.significantFdr05Total} OF ${result.totalTests} FDR SIGNIFICANT`,
          narrative:
            'Annual averages mask late-monsoon warming: September warming is robust across Bangladesh (31/34 cells survive BH FDR q=0.05), whereas October trends do not survive FDR (0/34) and annual means are flat (0/34).',
        });
      }
      if (result.record) {
        const r = result.record;
        const sign = r.senSlopePerDecade >= 0 ? '+' : '';
        return sanitizeEvidenceCard({
          title: `${result.month.toUpperCase()} TEMPERATURE TREND`,
          sector: `${result.sector?.name || 'Bangladesh'} [${result.cell.latitude}°N, ${result.cell.longitude}°E]`,
          slope: `${sign}${r.senSlopePerDecade.toFixed(3)}°C / decade (${result.month}, 2001–2025)`,
          senSlope: `${sign}${(r.senSlopePerDecade / 10).toFixed(4)}°C / year (Theil-Sen)`,
          pValue: `${formatPValue(r.pValue)} (MK Z=${r.mkZ.toFixed(2)})`,
          significance: r.significantFdr05
            ? 'SIGNIFICANT AFTER FDR (q = 0.05)'
            : r.significantP05
              ? 'p < 0.05 (NOT FDR SIGNIFICANT)'
              : 'NOT STATISTICALLY SIGNIFICANT',
          narrative: `MERRA-2 grid cell (${result.cell.latitude}°N, ${result.cell.longitude}°E) over ${r.nYears} years. ${r.prewhitened ? 'Series pre-whitened (TFPW) for lag-1 autocorrelation.' : 'No lag-1 autocorrelation pre-whitening needed.'}`,
        });
      }
    }

    if (name === 'get_live_weather') {
      if (result.status === 'ready' && result.weather) {
        const w = result.weather;
        return sanitizeEvidenceCard({
          title: 'LIVE WEATHER TELEMETRY (OPEN-METEO)',
          sector: `${result.location} [${result.coordinates.lat.toFixed(2)}°N, ${result.coordinates.lon.toFixed(2)}°E]`,
          slope: `Temp: ${w.temperatureC}°C (Feels ${w.apparentTemperatureC ?? w.temperatureC}°C)`,
          senSlope: `Precip: ${w.precipitationMm ?? 0} mm | Wind: ${w.windKph ?? 'N/A'} km/h`,
          pValue: `Cloud cover: ${w.cloudCoverPct ?? 'N/A'}% | ${result.condition}`,
          significance: 'OBSERVED LIVE TELEMETRY',
          narrative: `Server-side Open-Meteo observation for ${result.location}${w.observedAt ? ` at ${w.observedAt}` : ''}.`,
        });
      }
      return sanitizeEvidenceCard({
        title: 'LIVE WEATHER TELEMETRY',
        sector: result.location || 'Bangladesh',
        slope: 'Upstream unavailable',
        senSlope: 'N/A',
        pValue: 'Status: UNAVAILABLE',
        significance: 'LIVE FEED UNAVAILABLE',
        narrative:
          result.reason || 'Live weather feed is currently unreachable.',
      });
    }

    if (name === 'get_crop_advisory') {
      const w = result.weather;
      const sep = result.septemberTrend;
      return sanitizeEvidenceCard({
        title: 'CLIMATE-INFORMED CROP ADVISORY',
        sector: `${result.location} [${result.coordinates.lat.toFixed(2)}°N, ${result.coordinates.lon.toFixed(2)}°E]`,
        slope: w
          ? `Live Temp: ${w.temperatureC}°C | Rain: ${w.precipitationMm ?? 0} mm`
          : 'Live weather unavailable (using climate baseline)',
        senSlope: sep
          ? `Sept MERRA-2 Trend: +${sep.senSlopePerDecade.toFixed(2)}°C/decade`
          : 'MERRA-2 baseline loaded',
        pValue: sep ? `${formatPValue(sep.pValue)} (Sep MK)` : 'N/A',
        significance: 'RULE-BASED AGRONOMIC GUIDANCE',
        narrative: result.recommendations.join(' '),
      });
    }

    if (name === 'get_active_fires') {
      return sanitizeEvidenceCard({
        title: 'NASA FIRMS ACTIVE FIRE CHECK',
        sector: result.location || 'Bangladesh',
        slope:
          result.status === 'ready'
            ? `Detections (24h): ${result.count}`
            : 'Feed unavailable',
        senSlope: result.status === 'ready' ? `Scope: ${result.scope}` : 'N/A',
        pValue:
          result.status === 'ready'
            ? `Stale: ${result.stale ? 'yes' : 'no'}`
            : 'FIRMS_MAP_KEY missing / no cache',
        significance:
          result.status === 'ready'
            ? 'NASA VIIRS/MODIS NRT'
            : 'FEED UNAVAILABLE',
        narrative:
          result.status === 'ready'
            ? `Checked trailing 24-hour VIIRS/MODIS detections in ${result.location}: ${result.count} detection(s) found.`
            : result.reason ||
              'Active fire telemetry unavailable without FIRMS_MAP_KEY.',
      });
    }
  }

  return sanitizeEvidenceCard({
    title: fallbackTitle,
    sector: 'Bangladesh',
    narrative:
      'Orion Intelligence response generated from verified backend tools.',
  });
}

function buildMapActionsFromTools(toolOutputs) {
  const actions = [];
  for (const { name, result } of toolOutputs) {
    if (!result || !result.ok) continue;
    const sectorId = result.sector?.id || result.sectorId || null;
    if (sectorId && VALID_SECTOR_IDS.has(sectorId)) {
      actions.push({ type: 'fly_to_sector', sectorId });
    } else if (
      name === 'query_climate_trends' &&
      result.mode === 'fastest_warming'
    ) {
      actions.push({ type: 'fly_to_sector', sectorId: 'barisal' });
    }
  }
  if (toolOutputs.some((t) => t.result?.ok)) {
    actions.push({ type: 'show_evidence_card' });
  }
  return sanitizeMapActions(actions, VALID_SECTOR_IDS);
}

/** Deterministic tool execution plan when model is unconfigured or fails. */
async function runDeterministicPlan(payload, toolRegistry) {
  const lower = payload.message.toLowerCase();
  const lang = detectLanguage(payload.message);
  const sector =
    resolveSectorRecord(lower) ||
    resolveSectorRecord(payload.activeSectorId) ||
    resolveSectorRecord('barisal');
  const month = detectMonthFromQuery(payload.message);
  const toolsUsed = [];
  const toolOutputs = [];

  const run = async (name, args) => {
    const result = await toolRegistry.executeTool(name, args, {
      activeSectorId: payload.activeSectorId,
    });
    toolsUsed.push(name);
    toolOutputs.push({ name, result });
    return result;
  };

  let answer = '';
  let speech = '';

  if (
    /\b(?:crop|fosol|krishi|chash|farmer|krishok)\b/i.test(lower) ||
    /ফসল|কৃষি|চাষ|কৃষক/.test(payload.message)
  ) {
    const res = await run('get_crop_advisory', { districtId: sector.id });
    const tempText = res.weather
      ? `${res.weather.temperatureC}°C`
      : 'unavailable live weather';
    const trendText = res.septemberTrend
      ? `+${res.septemberTrend.senSlopePerDecade.toFixed(2)}°C/decade`
      : 'observed September warming';
    answer =
      lang === 'bn'
        ? `${res.location}-এর কৃষি পরামর্শ: সেপ্টেম্বর মাসে MERRA-2 তাপমাত্রা বৃদ্ধির হার ${trendText} (বর্তমান তাপমাত্রা: ${tempText})। ${res.recommendations[0]} ${res.recommendations[res.recommendations.length - 1]}`
        : `Crop advisory for ${res.location}: observed September warming is ${trendText} (live temp: ${tempText}). ${res.recommendations.join(' ')}`;
    speech = `Crop advisory for ${res.location}. ${res.recommendations[0]}`;
  } else if (
    /\b(?:fire|fires|firms|wildfire|burn)\b/i.test(lower) ||
    /আগুন/.test(payload.message)
  ) {
    const res = await run('get_active_fires', { districtId: sector.id });
    if (res.status === 'ready') {
      answer = `NASA FIRMS active fire check for ${res.location}: ${res.count} detection(s) in the trailing 24 hours.`;
      speech = answer;
    } else {
      answer =
        lang === 'bn'
          ? `NASA FIRMS লাইভ ফায়ার ডেটা এখন পাওয়া যাচ্ছে না (${res.reason})। কোনো অনুমানভিত্তিক সংখ্যা দেখানো হয়নি।`
          : `NASA FIRMS active fire feed is currently unavailable (${res.reason}).`;
      speech = `NASA FIRMS active fire data is currently unavailable.`;
    }
  } else if (
    /\b(?:weather|abohawa|abohaoa|rain|brishti|humidity|wind|batash|disaster rain|cyclone|ghurnijhor|flood|bonna)\b/i.test(
      lower,
    ) ||
    /আবহাওয়া|আবহাওয়া|বৃষ্টি|বাতাস|ঘূর্ণিঝড়|ঘূর্ণিঝড়|বন্যা/.test(
      payload.message,
    )
  ) {
    const targetId =
      /\b(?:cyclone|ghurnijhor|storm)\b/i.test(lower) ||
      /ঘূর্ণিঝড়|ঘূর্ণিঝড়/.test(payload.message)
        ? 'bay_of_bengal'
        : /\b(?:flood|bonna|haor)\b/i.test(lower) ||
            /বন্যা/.test(payload.message)
          ? resolveSectorRecord(lower)?.id || 'sylhet'
          : sector.id;
    const res = await run('get_live_weather', { districtId: targetId });
    if (res.status === 'ready') {
      const w = res.weather;
      answer =
        lang === 'bn'
          ? `${res.location}-এর বর্তমান আবহাওয়া (Open-Meteo): তাপমাত্রা ${w.temperatureC}°C, বৃষ্টিপাত ${w.precipitationMm ?? 0} mm, বাতাসের গতি ${w.windKph ?? 'N/A'} km/h (${res.condition})।`
          : `Live weather for ${res.location} (Open-Meteo): ${w.temperatureC}°C, precipitation ${w.precipitationMm ?? 0} mm, wind ${w.windKph ?? 'N/A'} km/h (${res.condition}).`;
      speech = `Live weather for ${res.location}: ${w.temperatureC} degrees Celsius, ${res.condition}.`;
    } else {
      answer = `Live weather telemetry for ${res.location} is currently unavailable (${res.reason}).`;
      speech = `Live weather for ${res.location} is unavailable.`;
    }
  } else if (
    /\b(?:fastest|hotspot|shobcheye beshi gorom)\b/i.test(lower) ||
    /সবচেয়ে বেশি গরম|সবচেয়ে বেশি গরম/.test(payload.message)
  ) {
    const res = await run('query_climate_trends', { mode: 'fastest_warming' });
    const b = res.barisalCoastSeptember;
    answer =
      lang === 'bn'
        ? `বাংলাদেশের ৩৪টি MERRA-2 গ্রিড সেলের মধ্যে সেপ্টেম্বর মাসে সবচেয়ে শক্তিশালী ও পরিসংখ্যানগতভাবে নির্ভরযোগ্য উষ্ণায়ন দেখা গেছে—বরিশাল উপকূলে (22.5°N, 90.0°E) হার +${b.senSlopePerDecade.toFixed(2)}°C/দশক (Mann-Kendall p = ${b.pValue.toFixed(5)}, FDR-significant)। সারাদেশে সেপ্টেম্বরের median +${res.septemberSummary.medianSenSlopePerDecade.toFixed(2)}°C/দশক।`
        : `Across all 34 Bangladesh MERRA-2 grid cells (2001–2025), late-monsoon September warming is the robust signal (median +${res.septemberSummary.medianSenSlopePerDecade.toFixed(2)}°C/decade, ${res.septemberSummary.significantFdr05Count}/34 FDR-significant). On the Barisal coast (22.5°N, 90.0°E), September warms at +${b.senSlopePerDecade.toFixed(2)}°C/decade (p = ${b.pValue.toFixed(5)}).`;
    speech = `On the Barisal coast, September temperatures warm at +${b.senSlopePerDecade.toFixed(2)} degrees Celsius per decade, significant after FDR correction.`;
  } else if (
    /\b(?:significant|significance|mann|kendall|p value|p-value|fdr|proof|detective|seasonal|october|annual)\b/i.test(
      lower,
    ) ||
    /প্রমাণ|অক্টোবর|বার্ষিক/.test(payload.message)
  ) {
    const mode =
      /\b(?:seasonal|october|annual)\b/i.test(lower) ||
      /অক্টোবর|বার্ষিক/.test(payload.message)
        ? 'seasonal_dissociation'
        : 'significance_overview';
    const res = await run('query_climate_trends', { mode });
    const sep = res.september;
    const oct = res.october;
    const ann = res.annual;
    answer =
      lang === 'bn'
        ? `৪৪২টি Mann-Kendall টেস্টে (৩৪ সেল × ১৩ সিরিজ): সেপ্টেম্বর মাসে ${sep.significantP05Count}/৩৪ সেলে p<0.05 এবং ${sep.significantFdr05Count}/৩৪ সেল Benjamini-Hochberg FDR (q=0.05)-এ উত্তীর্ণ। অক্টোবর মাসে ${oct.significantP05Count}/৩৪ সেলে p<0.05 হলেও FDR-এ একটিও (০/৩৪) টেকেনি। বার্ষিক গড়ে কোনো সেলই (০/৩৪) significant নয়।`
        : `Across 442 Bangladesh cell-month tests (2001–2025 MERRA-2): September is significant in ${sep.significantP05Count}/34 cells at p<0.05 and ${sep.significantFdr05Count}/34 after Benjamini-Hochberg FDR (q=0.05, median +${sep.medianSenSlopePerDecade.toFixed(2)}°C/decade). October warms (median +${oct.medianSenSlopePerDecade.toFixed(2)}°C/decade, ${oct.significantP05Count}/34 at p<0.05) but 0/34 survive FDR, and the annual mean shows 0/34 significant (median +${ann.medianSenSlopePerDecade.toFixed(3)}°C/decade).`;
    speech = `September warming is significant in ${sep.significantFdr05Count} of 34 cells after FDR correction, while October and annual means show zero FDR-significant cells.`;
  } else {
    const loc = await run('resolve_bangladesh_location', {
      query: payload.message,
    });
    const targetId = loc.found ? loc.sector.id : sector.id;
    const trend = await run('query_climate_trends', {
      mode: 'cell_month',
      districtId: targetId,
      month,
    });
    const r = trend.record;
    const sign = r.senSlopePerDecade >= 0 ? '+' : '';
    const fdrNote = r.significantFdr05
      ? 'FDR-significant (q=0.05)'
      : r.significantP05
        ? 'p<0.05 only (not FDR-significant)'
        : 'not statistically significant';
    answer =
      lang === 'bn'
        ? `${trend.sector?.name || sector.name}-এর কাছাকাছি MERRA-2 গ্রিড সেলে (${trend.cell.latitude}°N, ${trend.cell.longitude}°E) ${trend.month} মাসে তাপমাত্রার Theil-Sen প্রবণতা ${sign}${r.senSlopePerDecade.toFixed(3)}°C/দশক (Mann-Kendall ${formatPValue(r.pValue)}, ${fdrNote})।`
        : `Nearest MERRA-2 cell for ${trend.sector?.name || sector.name} (${trend.cell.latitude}°N, ${trend.cell.longitude}°E) in ${trend.month}: Theil-Sen slope ${sign}${r.senSlopePerDecade.toFixed(3)}°C/decade (${formatPValue(r.pValue)}, ${fdrNote}).`;
    speech = answer;
  }

  return {
    mode: 'deterministic_fallback',
    language: lang,
    answer,
    speech,
    toolsUsed,
    toolOutputs,
  };
}

/** Create the hybrid Orion Agent orchestrator. */
export function createAgentOrchestrator({
  toolRegistry,
  modelGateway,
  getConfig,
  now = () => Date.now(),
} = {}) {
  async function handle(rawBody) {
    const startMs = now();
    const validation = validateAgentRequestPayload(rawBody);
    if (!validation.ok) {
      return {
        statusCode: 400,
        body: { ok: false, error: validation.error },
      };
    }

    const payload = validation.value;
    const config = getConfig();
    let mode = 'deterministic_fallback';
    let language = detectLanguage(payload.message);
    let answer = '';
    let speech = '';
    const toolsUsed = [];
    const toolOutputs = [];
    let modelAttempted = false;

    if (config.modelBaseUrl) {
      modelAttempted = true;
      try {
        const messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...payload.history,
          {
            role: 'user',
            content: payload.activeSectorId
              ? `[Active map sector: ${payload.activeSectorId}] ${payload.message}`
              : payload.message,
          },
        ];

        for (let round = 0; round < 2; round++) {
          const completion = await modelGateway.chatCompletions({
            messages,
            tools: toolRegistry.toolDefinitions,
          });

          if (!completion.toolCalls?.length) {
            const parsed = parseJsonObjectSafe(completion.content);
            answer = parsed?.answer || completion.content;
            speech = parsed?.speech || answer;
            if (parsed?.sectorId && VALID_SECTOR_IDS.has(parsed.sectorId)) {
              toolOutputs.push({
                name: 'resolve_bangladesh_location',
                result: { ok: true, sector: { id: parsed.sectorId } },
              });
            }
            if (answer) mode = 'model';
            break;
          }

          messages.push({
            role: 'assistant',
            content: completion.content || '',
            tool_calls: completion.toolCalls,
          });

          for (const call of completion.toolCalls.slice(0, 3)) {
            const toolName = call?.function?.name;
            let parsedArgs = {};
            try {
              parsedArgs =
                typeof call?.function?.arguments === 'string'
                  ? JSON.parse(call.function.arguments || '{}')
                  : call?.function?.arguments || {};
            } catch {
              parsedArgs = {};
            }
            const result = await toolRegistry.executeTool(
              toolName,
              parsedArgs,
              {
                activeSectorId: payload.activeSectorId,
              },
            );
            toolsUsed.push(toolName);
            toolOutputs.push({ name: toolName, result });
            messages.push({
              role: 'tool',
              tool_call_id: call.id || `call_${toolsUsed.length}`,
              content: JSON.stringify(result),
            });
          }
        }
      } catch (err) {
        console.warn(
          '[orion-agent] Model gateway fallback:',
          err?.code || err?.message,
        );
      }
    }

    if (!answer) {
      const fallback = await runDeterministicPlan(payload, toolRegistry);
      mode = fallback.mode;
      language = fallback.language;
      answer = fallback.answer;
      speech = fallback.speech;
      toolsUsed.push(...fallback.toolsUsed);
      toolOutputs.push(...fallback.toolOutputs);
    }

    const evidenceCard = buildEvidenceFromTools(toolOutputs);
    const mapActions = buildMapActionsFromTools(toolOutputs);
    const citations = [
      ...new Set(
        toolOutputs
          .map((t) => t.result?.source)
          .filter((s) => typeof s === 'string' && s.length > 0),
      ),
    ];

    return {
      statusCode: 200,
      body: {
        ok: true,
        answer,
        speech: speech || answer,
        language,
        evidenceCard,
        mapActions,
        citations,
        meta: {
          mode,
          modelAttempted,
          modelName: config.modelName,
          toolsUsed,
          latencyMs: Math.max(0, now() - startMs),
        },
      },
    };
  }

  return { handle };
}
