/**
 * @file config.js
 * @module server/agent/config
 * @description Runtime configuration loader for the Orion Agent Node.js backend.
 * Reads server-side secrets lazily from process.env and validates URLs/bounds.
 */

const DEFAULT_DEV_ORIGINS = Object.freeze([
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function normalizeHttpBaseUrl(raw) {
  const trimmed = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function parseCorsOrigins(raw, includeDevDefaults) {
  const origins = new Set();
  for (const part of String(raw || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed origin entries instead of crashing startup.
    }
  }
  if (includeDevDefaults) {
    for (const devOrigin of DEFAULT_DEV_ORIGINS) {
      origins.add(devOrigin);
    }
  }
  return origins;
}

/** Load a sanitized snapshot of Orion Agent backend config from env. */
export function loadAgentConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '')
    .trim()
    .toLowerCase();
  const isProduction = nodeEnv === 'production';
  const includeDevCors =
    env.ORION_ALLOW_LOCALHOST_CORS === 'true' ||
    (!isProduction && env.ORION_ALLOW_LOCALHOST_CORS !== 'false');

  return {
    provider: String(env.ORION_MODEL_PROVIDER || 'qwen3').trim() || 'qwen3',
    modelBaseUrl: normalizeHttpBaseUrl(env.ORION_MODEL_BASE_URL),
    modelApiKey: String(env.ORION_MODEL_API_KEY || '').trim(),
    modelName:
      String(env.ORION_MODEL_NAME || 'orion-qwen3-0.6b').trim() ||
      'orion-qwen3-0.6b',
    modelTimeoutMs: clampInt(env.ORION_MODEL_TIMEOUT_MS, 15_000, 1000, 60_000),
    modelMaxContextTokens: clampInt(
      env.ORION_MODEL_MAX_CONTEXT,
      4096,
      512,
      32_768,
    ),
    modelMaxOutputTokens: clampInt(
      env.ORION_MODEL_MAX_OUTPUT_TOKENS,
      384,
      64,
      2048,
    ),
    modelConcurrency: clampInt(env.ORION_MODEL_CONCURRENCY, 4, 1, 32),
    agentApiKey: String(env.ORION_AGENT_API_KEY || '').trim(),
    corsOrigins: parseCorsOrigins(env.ORION_CORS_ORIGIN, includeDevCors),
    rateLimitPerMin: clampInt(env.ORION_AGENT_RATELIMIT_PER_MIN, 30, 0, 600),
    host: String(env.ORION_AGENT_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: clampInt(env.ORION_AGENT_PORT || env.PORT, 8787, 1, 65_535),
    trustProxy: String(env.ORION_TRUST_PROXY || '').trim() === 'true',
    isProduction,
  };
}
