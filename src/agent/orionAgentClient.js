/**
 * @file orionAgentClient.js
 * @module agent/orionAgentClient
 * @description Public browser client for POST /api/orion/agent.
 * Uses only public backend base URL configuration; never holds secrets.
 */

/** Resolve the public Orion Agent backend base URL (empty string = same origin). */
export function resolveOrionAgentBaseUrl(overrideBaseUrl) {
  const candidate =
    overrideBaseUrl ??
    import.meta.env?.VITE_ORION_AGENT_BASE_URL ??
    globalThis?.__ORION_AGENT_CONFIG__?.baseUrl ??
    '';
  const trimmed = String(candidate || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  } catch {
    // Allow relative prefix paths like '/proxy' if configured.
    if (trimmed.startsWith('/')) return trimmed;
  }
  return '';
}

/** Create a browser HTTP client for the Orion Agent backend API. */
export function createOrionAgentClient({
  baseUrl,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  timeoutMs = 15_000,
} = {}) {
  async function ask({
    message,
    history = [],
    activeSectorId = null,
    clientContext = {},
  }) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: 'fetch_unavailable' };
    }
    const resolvedBase = resolveOrionAgentBaseUrl(baseUrl);
    const endpoint = `${resolvedBase}/api/orion/agent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: Array.isArray(history) ? history.slice(-6) : [],
          activeSectorId,
          clientContext,
        }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        return {
          ok: false,
          status: response.status,
          error: payload?.error || `HTTP ${response.status}`,
        };
      }
      return payload;
    } catch (err) {
      return {
        ok: false,
        error: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ask };
}
