import {
  epoch,
  finite,
  httpError,
  LiveSourceError,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

function openSkyError(response) {
  const error = httpError(response, 'OpenSky');
  const mode = String(
    header(response, 'x-opensky-auth-mode-used') ||
      header(response, 'x-opensky-auth') ||
      '',
  ).toLowerCase();
  const reason = String(
    header(response, 'x-opensky-auth-reason') || '',
  ).toLowerCase();
  if (response.status === 429 && (!mode || mode === 'anon'))
    error.message = 'OpenSky rate limited (anonymous)';
  if (response.status === 401 || response.status === 403) {
    const reasons = {
      oauth_invalid_or_missing: 'OpenSky OAuth client missing/invalid',
      oauth_invalid_credentials: 'OpenSky OAuth rejected credentials',
      basic_invalid_credentials: 'OpenSky username/password rejected',
      missing_basic_creds: 'OpenSky auth missing',
      missing_oauth_and_basic_creds: 'OpenSky auth missing',
      auth_required: 'OpenSky auth required',
      forced_anonymous: 'OpenSky auth required',
    };
    error.message =
      reasons[reason] ||
      (/^(oauth_|basic_)/.test(reason)
        ? 'OpenSky auth invalid'
        : mode === 'anon'
          ? 'OpenSky auth required'
          : 'OpenSky auth failed');
  }
  return error;
}

/** Existing same-origin aircraft routes; no request starts during construction. */
export function createOpenSkySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'OpenSky Network',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/opensky${params.size ? '?' + params : ''}`,
        { signal },
        'OpenSky',
      );
      if (response.ok && payload) {
        return {
          ...openSkySnapshot(payload, {
            source: header(response, 'x-flight-source') || 'OpenSky Network',
            coverage:
              header(response, 'x-flight-coverage') ||
              'worldwide upstream snapshot',
            now: now(),
          }),
          status: response.status,
        };
      }
      throw openSkyError(response);
    },
    async getTrack(reference, { signal } = {}) {
      try {
        const { response, payload } = await readResponse(
          fetchImpl,
          '/api/opensky-track?icao24=' + encodeURIComponent(reference),
          { signal },
          'OpenSky',
        );
        if (response.ok) {
          return {
            records: normalizeAircraftTrack(payload?.path),
            complete: false,
          };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      return { records: [], complete: false };
    },
    async getEnrichment(query, { signal } = {}) {
      if (!['type', 'route'].includes(query.kind))
        throw new LiveSourceError('unsupported', 'Enrichment unavailable');
      try {
        const { response, payload } = await readResponse(
          fetchImpl,
          `/api/adsbdb/${query.kind}/${encodeURIComponent(query.id)}`,
          { signal },
          'adsbdb',
        );
        if (response.ok) return payload;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      return { id: query.id, name: 'Aircraft Telemetry' };
    },
  };
}

export function createAdsbLolSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'adsb.lol',
    async getIdentities(_query = {}, { signal } = {}) {
      let response, payload;
      try {
        const res = await readResponse(
          fetchImpl,
          '/api/adsblol/mil',
          { signal },
          'adsb.lol',
        );
        response = res.response;
        payload = res.payload;
      } catch (error) {
        if (signal?.aborted) throw error;
      }

      if (!response || !response.ok) {
        try {
          const direct = await readResponse(
            fetchImpl,
            'https://api.adsb.lol/v2/mil',
            { signal },
            'adsb.lol',
          );
          response = direct.response;
          payload = direct.payload;
        } catch (error) {
        if (signal?.aborted) throw error;
      }
      }

      if (response?.ok && payload) return readsbIdentities(payload);
      return [];
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      let response, payload;
      try {
        const res = await readResponse(
          fetchImpl,
          '/api/adsblol/mil',
          { signal },
          'adsb.lol',
        );
        response = res.response;
        payload = res.payload;
      } catch (error) {
        if (signal?.aborted) throw error;
      }

      if (!response || !response.ok) {
        try {
          const direct = await readResponse(
            fetchImpl,
            'https://api.adsb.lol/v2/mil',
            { signal },
            'adsb.lol',
          );
          response = direct.response;
          payload = direct.payload;
        } catch (error) {
        if (signal?.aborted) throw error;
      }
      }

      if (response?.ok && payload) {
        const age = finite(header(response, 'x-ads-b-cache-age-ms'));
        return {
          ...readsbSnapshot(payload, {
            observedAtMs: now() - (age != null && age > 0 ? age : 0),
            now: now(),
            stale: header(response, 'x-ads-b-cache') === 'STALE',
          }),
          status: response.status,
        };
      }

      // Safe static fallback
      return {
        ...readsbSnapshot({ ac: [], total: 0 }, { observedAtMs: now(), now: now(), stale: false }),
        status: 200,
      };
    },
    async getTrack(reference, { signal } = {}) {
      let response, payload;
      try {
        const res = await readResponse(
          fetchImpl,
          '/api/adsblol/trace?hex=' + encodeURIComponent(reference),
          { signal },
          'adsb.lol',
        );
        response = res.response;
        payload = res.payload;
      } catch (error) {
        if (signal?.aborted) throw error;
      }

      if (!response || !response.ok) {
        try {
          const direct = await readResponse(
            fetchImpl,
            'https://api.adsb.lol/v2/trace/' + encodeURIComponent(reference),
            { signal },
            'adsb.lol',
          );
          response = direct.response;
          payload = direct.payload;
        } catch (error) {
        if (signal?.aborted) throw error;
      }
      }

      if (response?.ok && payload) {
        const baseTimeMs = epoch(payload?.timestamp, 1000);
        return {
          records:
            baseTimeMs == null
              ? []
              : normalizeAircraftTrack(payload?.trace, {
                  baseTimeMs,
                  readsb: true,
                }),
          complete: false,
        };
      }
      return { records: [], complete: false };
    },
  };
}

export function createAisStreamSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/ais-live',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  return {
    label: 'AISStream',
    async getSnapshot({ maxRows = 12000 } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS live',
      );
      if (response.ok && payload) {
        return { ...vesselSnapshot(payload), status: response.status };
      }
      if (payload && typeof payload.status === 'string') {
        // The proxy reported its feed state (for example 'missing-key');
        // surface it instead of inventing positions.
        return {
          records: [],
          complete: false,
          source: 'AISStream',
          coverage: 'received AIS positions',
          transportStatus: payload.status,
          observedAtMs: null,
          freshness: 'unknown',
          stale: false,
          rawRowCount: 0,
        };
      }
      throw new LiveSourceError(
        'unavailable',
        `AIS live HTTP ${response.status}`,
        { status: response.status },
      );
    },
    async getTrack(reference, { signal } = {}) {
      try {
        const { response, payload } = await readResponse(
          fetchImpl,
          '/api/ais-live/track?mmsi=' + encodeURIComponent(reference),
          { signal },
          'AIS live',
        );
        if (response.ok && payload) {
          return {
            records: normalizeVesselTrack(payload?.samples),
            complete: false,
          };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      return { records: [], complete: false };
    },
  };
}
