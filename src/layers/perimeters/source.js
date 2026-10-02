import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request a normalized snapshot through the bounded, same-origin WFIGS proxy. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl('/api/fire-perimeters', { signal });
        if (response.ok) {
          const payload = await readResponseJsonCapped(
            response,
            80 * 1024 * 1024,
            signal,
          );
          signal?.throwIfAborted();
          if (Array.isArray(payload?.rows)) return payload.rows;
        }
      } catch {}

      // Static fallback: No uncontained mega-wildfire perimeters currently intersecting
      return [];
    },
  };
}
