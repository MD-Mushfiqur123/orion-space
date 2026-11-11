/**
 * @file agentContract.js
 * @module agent/agentContract
 * @description Pure request/response contracts, allowlists, and deterministic
 * client-vs-backend routing helpers shared between browser and Node.js backend.
 * Must remain free of DOM, Cesium, and Node built-in imports.
 */

export const ORION_AGENT_MAX_MESSAGE_CHARS = 1000;
export const ORION_AGENT_MAX_HISTORY_TURNS = 6;
export const ORION_AGENT_MAX_BODY_BYTES = 32 * 1024;

export const ALLOWED_MAP_ACTION_TYPES = Object.freeze([
  'fly_to_sector',
  'fly_to_coords',
  'toggle_clouds',
  'set_shader',
  'start_orbit',
  'stop_orbit',
  'show_evidence_card',
]);

export const ALLOWED_SHADERS = Object.freeze([
  'normal',
  'thermal',
  'surveillance',
  'noir',
]);

export const ALLOWED_TOOL_NAMES = Object.freeze([
  'resolve_bangladesh_location',
  'query_climate_trends',
  'get_live_weather',
  'get_active_fires',
  'get_crop_advisory',
]);

const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escape plain text before interpolation into existing DOM templates. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

function cleanBoundedString(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Validate and normalize incoming POST /api/orion/agent JSON payloads. */
export function validateAgentRequestPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const message =
    typeof raw.message === 'string'
      ? raw.message.trim().slice(0, ORION_AGENT_MAX_MESSAGE_CHARS)
      : '';
  if (!message) {
    return { ok: false, error: 'Field "message" must be a non-empty string.' };
  }

  const history = [];
  if (Array.isArray(raw.history)) {
    for (const item of raw.history.slice(-ORION_AGENT_MAX_HISTORY_TURNS)) {
      if (!item || typeof item !== 'object') continue;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      const content = cleanBoundedString(
        item.content,
        ORION_AGENT_MAX_MESSAGE_CHARS,
      );
      if (content) history.push({ role, content });
    }
  }

  const activeSectorId = cleanBoundedString(raw.activeSectorId, 64) || null;
  const clientContext =
    raw.clientContext &&
    typeof raw.clientContext === 'object' &&
    !Array.isArray(raw.clientContext)
      ? {
          cloudsActive: Boolean(raw.clientContext.cloudsActive),
          shader: ALLOWED_SHADERS.includes(raw.clientContext.shader)
            ? raw.clientContext.shader
            : 'normal',
        }
      : { cloudsActive: false, shader: 'normal' };

  return {
    ok: true,
    value: {
      message,
      history,
      activeSectorId,
      clientContext,
    },
  };
}

/** Validate and bound an evidence card payload returned to the browser. */
export function sanitizeEvidenceCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const clean = (key, maxLen, fallback = '') =>
    cleanBoundedString(card[key], maxLen) || fallback;

  const title = clean('title', 120);
  const narrative = clean('narrative', 800);
  if (!title && !narrative) return null;

  return {
    title: title || 'ORION INTELLIGENCE DOSSIER',
    sector: clean('sector', 140, 'Bangladesh'),
    slope: clean('slope', 160, 'N/A'),
    senSlope: clean('senSlope', 160, 'N/A'),
    pValue: clean('pValue', 160, 'N/A'),
    significance: clean('significance', 100, 'OBSERVATION'),
    narrative: narrative || title,
    speech: clean('speech', 500),
  };
}

/** Filter and clamp map actions to the strict browser allowlist. */
export function sanitizeMapActions(actions, validSectorIds = null) {
  if (!Array.isArray(actions)) return [];
  const validSet =
    validSectorIds instanceof Set
      ? validSectorIds
      : Array.isArray(validSectorIds)
        ? new Set(validSectorIds)
        : null;

  const sanitized = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (!ALLOWED_MAP_ACTION_TYPES.includes(action.type)) continue;

    switch (action.type) {
      case 'fly_to_sector': {
        const sectorId = cleanBoundedString(action.sectorId, 64).toLowerCase();
        if (!sectorId) break;
        if (validSet && !validSet.has(sectorId)) break;
        sanitized.push({ type: 'fly_to_sector', sectorId });
        break;
      }
      case 'fly_to_coords': {
        const lat = Number(action.lat);
        const lon = Number(action.lon);
        const altitude = Number.isFinite(Number(action.altitude))
          ? Math.min(5_000_000, Math.max(1000, Number(action.altitude)))
          : 120_000;
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          lat >= -90 &&
          lat <= 90 &&
          lon >= -180 &&
          lon <= 180
        ) {
          sanitized.push({
            type: 'fly_to_coords',
            lat,
            lon,
            altitude,
            label: cleanBoundedString(action.label, 80) || 'Target Sector',
          });
        }
        break;
      }
      case 'toggle_clouds': {
        sanitized.push({
          type: 'toggle_clouds',
          active:
            typeof action.active === 'boolean' ? action.active : undefined,
        });
        break;
      }
      case 'set_shader': {
        if (ALLOWED_SHADERS.includes(action.style)) {
          sanitized.push({ type: 'set_shader', style: action.style });
        }
        break;
      }
      case 'start_orbit':
      case 'stop_orbit':
      case 'show_evidence_card': {
        sanitized.push({ type: action.type });
        break;
      }
    }

    if (sanitized.length >= 4) break;
  }
  return sanitized;
}

const QUESTION_OR_DOMAIN_PATTERN = new RegExp(
  String.raw`\?|\b(?:why|how|what|explain|tell me|compare|warm(?:ing)?|trend|trends|climate|temp|temperature|tapmatra|weather|abohawa|abohaoa|rain|brishti|humidity|wind|batash|crop|fosol|krishi|chash|farmer|krishok|flood|bonna|cyclone|ghurnijhor|storm|fire|fires|firms|evidence|stat|stats|statistical|significant|significance|p value|p-value|mann|kendall|fdr|october|september|annual|seasonal|fastest|hotspot|kemon|keno|koto)\b|তাপমাত্রা|আবহাওয়া|বৃষ্টি|বাতাস|ফসল|কৃষি|চাষ|কৃষক|বন্যা|ঘূর্ণিঝড়|আগুন|অক্টোবর|সেপ্টেম্বর|প্রমাণ|তথ্য|অবস্থা|(?:^|\s)(?:কি|কী|কেন|কেমন|কত)(?=\s|$|[?!.,।])`.normalize(
    'NFC',
  ),
  'i',
);

/**
 * Decide whether a command should execute purely locally in Cesium
 * vs. routing to the backend Orion Agent API.
 */
export function classifyLocalCommand(rawCommand, { findSector } = {}) {
  const trimmed =
    typeof rawCommand === 'string' ? rawCommand.trim().normalize('NFC') : '';
  const lower = trimmed.toLowerCase();
  if (!lower) return { kind: 'ignore' };

  const hasQuestionOrDomainIntent = QUESTION_OR_DOMAIN_PATTERN.test(lower);

  // Direct lat/lon coordinates always execute locally with zero latency.
  const coordMatch = lower.match(
    /^\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)\s*$/,
  );
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { kind: 'local', action: 'coords', lat, lon };
    }
  }

  if (!hasQuestionOrDomainIntent) {
    if (
      /\b(?:orbit|rotate|360|ghuro)\b/.test(lower) ||
      lower.includes('ঘুরো')
    ) {
      return { kind: 'local', action: 'orbit' };
    }
    if (/\b(?:stop|halt|thamo)\b/.test(lower) || lower.includes('থামো')) {
      return { kind: 'local', action: 'stop_orbit' };
    }
    if (/\b(?:cloud|clouds|megh|gibs)\b/.test(lower) || lower.includes('মেঘ')) {
      return { kind: 'local', action: 'clouds' };
    }
    if (/\b(?:thermal|flir)\b/.test(lower) || lower === 'gorom') {
      return {
        kind: 'local',
        action: 'shader',
        style: 'thermal',
        announcement: 'FLIR Thermal (Ironbow) Mode activated.',
      };
    }
    if (
      /\b(?:nvg|night vision)\b/.test(lower) ||
      /^(?:night|raat|rat)$/.test(lower)
    ) {
      return {
        kind: 'local',
        action: 'shader',
        style: 'surveillance',
        announcement: 'Night Vision Sensor Pass activated.',
      };
    }
    if (/\b(?:noir|monochrome|black and white)\b/.test(lower)) {
      return {
        kind: 'local',
        action: 'shader',
        style: 'noir',
        announcement: 'Swiss Monochrome Noir Style activated.',
      };
    }
    if (/\b(?:normal|optical|reset style)\b/.test(lower)) {
      return {
        kind: 'local',
        action: 'shader',
        style: 'normal',
        announcement: 'Standard Optical Globe restored.',
      };
    }
    if (/\b(?:sea level|slr|surge)\b/.test(lower) || lower.includes('জলস্তর')) {
      return { kind: 'local', action: 'sea_level' };
    }

    if (typeof findSector === 'function') {
      const sector = findSector(lower);
      if (sector) {
        return { kind: 'local', action: 'sector', sector };
      }
    }
  }

  return { kind: 'remote' };
}
