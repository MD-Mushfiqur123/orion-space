import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLocalCommand,
  escapeHtml,
  sanitizeEvidenceCard,
  sanitizeMapActions,
  validateAgentRequestPayload,
} from './agentContract.js';
import { findDistrictSector } from './bangladeshDistricts.js';
import {
  createOrionAgentClient,
  resolveOrionAgentBaseUrl,
} from './orionAgentClient.js';
import {
  createClimateEngine,
  normalizeMonthName,
} from '../../server/agent/climateEngine.js';
import { loadAgentConfig } from '../../server/agent/config.js';
import { createOrionAgentHttpHandler } from '../../server/agent/httpHandler.js';
import {
  createModelGateway,
  extractInlineToolCalls,
  stripThinkingBlocks,
} from '../../server/agent/modelGateway.js';
import { createAgentOrchestrator } from '../../server/agent/orchestrator.js';
import { createOrionAgentServer } from '../../server/agent/server.mjs';
import { createToolRegistry } from '../../server/agent/toolRegistry.js';

test('agentContract validates request payloads, actions, and HTML escaping', () => {
  assert.equal(validateAgentRequestPayload(null).ok, false);
  assert.equal(validateAgentRequestPayload({ message: '   ' }).ok, false);

  const valid = validateAgentRequestPayload({
    message: '  Why is Barisal warming in September?  ',
    history: [
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Ignored system role coerced safely' },
    ],
    activeSectorId: 'barisal',
    clientContext: { cloudsActive: true, shader: 'thermal' },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.message, 'Why is Barisal warming in September?');
  assert.equal(valid.value.history.length, 2);
  assert.equal(valid.value.history[1].role, 'user');
  assert.equal(valid.value.clientContext.shader, 'thermal');

  const actions = sanitizeMapActions(
    [
      { type: 'fly_to_sector', sectorId: 'pirojpur' },
      { type: 'fly_to_sector', sectorId: 'nonexistent_sector' },
      { type: 'fly_to_coords', lat: 999, lon: 90 },
      { type: 'fly_to_coords', lat: 22.5, lon: 90.0, altitude: 500 },
      { type: 'exec_shell', cmd: 'rm -rf /' },
      { type: 'set_shader', style: 'noir' },
    ],
    new Set(['pirojpur', 'barisal']),
  );
  assert.deepEqual(actions, [
    { type: 'fly_to_sector', sectorId: 'pirojpur' },
    {
      type: 'fly_to_coords',
      lat: 22.5,
      lon: 90,
      altitude: 1000,
      label: 'Target Sector',
    },
    { type: 'set_shader', style: 'noir' },
  ]);

  assert.equal(
    escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
  );
});

test('classifyLocalCommand keeps instant map controls local and routes NL queries to backend', () => {
  const opts = { findSector: findDistrictSector };

  assert.equal(classifyLocalCommand('orbit', opts).action, 'orbit');
  assert.equal(classifyLocalCommand('stop', opts).action, 'stop_orbit');
  assert.equal(classifyLocalCommand('flir', opts).style, 'thermal');
  assert.equal(classifyLocalCommand('22.5, 90.0', opts).action, 'coords');
  assert.equal(classifyLocalCommand('Pirojpur', opts).sector.id, 'pirojpur');
  assert.equal(
    classifyLocalCommand('fly to barisal', opts).sector.id,
    'barisal',
  );
  // Must NOT misclassify Bengali district names containing "কি" as questions.
  assert.equal(
    classifyLocalCommand('কিশোরগঞ্জ', opts).sector.id,
    'kishoreganj',
  );

  // Scientific / weather / crop / conversational queries go to backend.
  assert.equal(
    classifyLocalCommand('where is warming fastest', opts).kind,
    'remote',
  );
  assert.equal(
    classifyLocalCommand('Pirojpur warming trend', opts).kind,
    'remote',
  );
  assert.equal(classifyLocalCommand('live weather', opts).kind, 'remote');
  assert.equal(classifyLocalCommand('crop advisory', opts).kind, 'remote');
  assert.equal(
    classifyLocalCommand('সিলেটে সেপ্টেম্বর মাসে তাপমাত্রা কেমন?', opts).kind,
    'remote',
  );
});

test('climateEngine loads verified MERRA-2 Bangladesh results without synthetic overrides', () => {
  const engine = createClimateEngine();
  assert.equal(engine.insideCellCount, 34);
  assert.equal(normalizeMonthName('সেপ্টেম্বর'), 'September');

  const barisalSep = engine.queryCellMonth({
    lat: 22.701,
    lon: 90.3535,
    month: 'September',
  });
  assert.equal(barisalSep.cell.latitude, 22.5);
  assert.equal(barisalSep.cell.longitude, 90);
  assert.equal(barisalSep.record.senSlopePerDecade, 0.4);
  assert.equal(barisalSep.record.significantFdr05, true);

  const overview = engine.querySignificanceOverview();
  assert.equal(overview.totalCells, 34);
  assert.equal(overview.totalTests, 442);
  assert.equal(overview.significantFdr05Total, 36);
  assert.equal(overview.september.significantP05Count, 34);
  assert.equal(overview.september.significantFdr05Count, 31);
  assert.equal(overview.october.significantP05Count, 29);
  assert.equal(overview.october.significantFdr05Count, 0);
  assert.equal(overview.annual.significantP05Count, 0);
});

test('toolRegistry executes allowlisted tools and rejects unknown tools', async () => {
  const registry = createToolRegistry({
    weatherFetcher: async ({ latitude, longitude }) => ({
      observedAt: '2026-11-11T12:00:00Z',
      temperatureC: 29.4,
      apparentTemperatureC: 31.0,
      precipitationMm: 0.2,
      cloudCoverPct: 35,
      windKph: 11.2,
      windDirectionDeg: 180,
      visibilityM: 10000,
      weatherCode: 2,
      lat: latitude,
      lon: longitude,
    }),
    firesFetcher: async () => ({
      status: 'unavailable',
      reason: 'FIRMS_MAP_KEY missing',
      count: null,
      detections: [],
    }),
  });

  const denied = await registry.executeTool('run_shell', { cmd: 'ls' });
  assert.equal(denied.ok, false);

  const loc = await registry.executeTool('resolve_bangladesh_location', {
    query: 'পিরোজপুর',
  });
  assert.equal(loc.found, true);
  assert.equal(loc.sector.id, 'pirojpur');

  const weather = await registry.executeTool('get_live_weather', {
    districtId: 'pirojpur',
  });
  assert.equal(weather.status, 'ready');
  assert.equal(weather.weather.temperatureC, 29.4);

  const fires = await registry.executeTool('get_active_fires', {
    districtId: 'sundarbans',
  });
  assert.equal(fires.status, 'unavailable');

  const crop = await registry.executeTool('get_crop_advisory', {
    districtId: 'barisal',
  });
  assert.equal(crop.weatherStatus, 'ready');
  assert.equal(crop.septemberTrend.senSlopePerDecade, 0.4);
});

test('modelGateway parses Qwen3 thinking/tool tags, sends auth header, and strips secrets from health', async () => {
  assert.equal(
    stripThinkingBlocks('<think>internal thought</think>\nFinal answer.'),
    'Final answer.',
  );
  const inline = extractInlineToolCalls(
    '<tool_call>{"name":"query_climate_trends","arguments":{"mode":"fastest_warming"}}</tool_call>',
  );
  assert.equal(inline.length, 1);
  assert.equal(inline[0].function.name, 'query_climate_trends');

  let seenAuth = '';
  const gateway = createModelGateway({
    getConfig: () =>
      loadAgentConfig({
        ORION_MODEL_PROVIDER: 'qwen3',
        ORION_MODEL_BASE_URL: 'https://private-gpu.internal:8000',
        ORION_MODEL_API_KEY: 'top-secret-token',
        ORION_MODEL_NAME: 'orion-qwen3-0.6b',
      }),
    fetchImpl: async (url, init) => {
      seenAuth = init.headers.Authorization;
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          model: 'orion-qwen3-0.6b',
          choices: [
            {
              message: {
                content:
                  '<think>checking barisal</think><tool_call>{"name":"query_climate_trends","arguments":{"mode":"fastest_warming"}}</tool_call>',
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const health = await gateway.checkHealth({ force: true });
  assert.equal(health.status, 'ready');
  assert.equal(JSON.stringify(health).includes('private-gpu.internal'), false);
  assert.equal(JSON.stringify(health).includes('top-secret-token'), false);

  const completion = await gateway.chatCompletions({
    messages: [{ role: 'user', content: 'Where is warming fastest?' }],
  });
  assert.equal(seenAuth, 'Bearer top-secret-token');
  assert.equal(completion.toolCalls.length, 1);
  assert.equal(completion.toolCalls[0].function.name, 'query_climate_trends');
});

test('orchestrator executes model tool loop and falls back cleanly when model errors', async () => {
  const registry = createToolRegistry({
    weatherFetcher: async () => null,
    firesFetcher: async () => ({
      status: 'unavailable',
      reason: 'no_key',
      count: null,
      detections: [],
    }),
  });

  let callIndex = 0;
  const orchestrator = createAgentOrchestrator({
    toolRegistry: registry,
    getConfig: () =>
      loadAgentConfig({
        ORION_MODEL_BASE_URL: 'https://private-gpu.internal:8000',
        ORION_MODEL_NAME: 'orion-qwen3-0.6b',
      }),
    modelGateway: {
      chatCompletions: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'query_climate_trends',
                  arguments: JSON.stringify({
                    mode: 'cell_month',
                    districtId: 'pirojpur',
                    month: 'September',
                  }),
                },
              },
            ],
          };
        }
        return {
          content: JSON.stringify({
            answer:
              'Pirojpur nearest MERRA-2 cell warms significantly in September.',
            speech: 'Pirojpur nearest cell warms significantly in September.',
            sectorId: 'pirojpur',
          }),
          toolCalls: [],
        };
      },
    },
  });

  const modelRes = await orchestrator.handle({
    message: 'Pirojpur September warming?',
  });
  assert.equal(modelRes.statusCode, 200);
  assert.equal(modelRes.body.meta.mode, 'model');
  assert.deepEqual(modelRes.body.meta.toolsUsed, ['query_climate_trends']);
  assert.equal(modelRes.body.mapActions[0].sectorId, 'pirojpur');

  // Failing model must seamlessly fall back to deterministic grounded tool execution.
  const failingOrchestrator = createAgentOrchestrator({
    toolRegistry: registry,
    getConfig: () =>
      loadAgentConfig({
        ORION_MODEL_BASE_URL: 'https://private-gpu.internal:8000',
      }),
    modelGateway: {
      chatCompletions: async () => {
        throw new Error('upstream down');
      },
    },
  });

  const fallbackRes = await failingOrchestrator.handle({
    message: 'is warming significant?',
  });
  assert.equal(fallbackRes.statusCode, 200);
  assert.equal(fallbackRes.body.meta.mode, 'deterministic_fallback');
  assert.match(fallbackRes.body.answer, /31\/34/);
  assert.match(fallbackRes.body.answer, /0\/34/);
});

test('standalone HTTP server enforces CORS allowlist, auth, rate limit, body cap, and concurrency', async (t) => {
  const registry = createToolRegistry({
    weatherFetcher: async () => null,
    firesFetcher: async () => ({
      status: 'unavailable',
      reason: 'no_key',
      count: null,
      detections: [],
    }),
  });

  const configEnv = {
    NODE_ENV: 'production',
    ORION_CORS_ORIGIN: 'https://md-mushfiqur123.github.io',
    ORION_AGENT_API_KEY: 'test-agent-secret',
    ORION_AGENT_RATELIMIT_PER_MIN: '5',
    ORION_MODEL_NAME: 'orion-qwen3-0.6b',
  };

  const server = createOrionAgentServer({
    getConfig: () => loadAgentConfig(configEnv),
    toolRegistry: registry,
    modelGateway: createModelGateway({
      getConfig: () => loadAgentConfig(configEnv),
    }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Health check
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.climateCellsInsideBangladesh, 34);
  assert.equal(healthJson.modelStatus, 'unconfigured');

  // CORS disallow evil origin
  const badOrigin = await fetch(`${baseUrl}/api/orion/agent`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(badOrigin.status, 403);

  // CORS allow GitHub Pages origin
  const goodOrigin = await fetch(`${baseUrl}/api/orion/agent`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://md-mushfiqur123.github.io' },
  });
  assert.equal(goodOrigin.status, 204);
  assert.equal(
    goodOrigin.headers.get('access-control-allow-origin'),
    'https://md-mushfiqur123.github.io',
  );

  // Auth enforcement
  const unauth = await fetch(`${baseUrl}/api/orion/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'where is warming fastest?' }),
  });
  assert.equal(unauth.status, 401);

  // Oversized body (>32 KB)
  const oversized = await fetch(`${baseUrl}/api/orion/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-agent-secret',
    },
    body: JSON.stringify({ message: 'a'.repeat(40_000) }),
  });
  assert.equal(oversized.status, 413);

  // Concurrent valid requests + rate limit hit
  const makeCall = (msg) =>
    fetch(`${baseUrl}/api/orion/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://md-mushfiqur123.github.io',
        Authorization: 'Bearer test-agent-secret',
      },
      body: JSON.stringify({ message: msg }),
    });

  const [r1, r2, r3, r4] = await Promise.all([
    makeCall('where is warming fastest?'),
    makeCall('is warming significant?'),
    makeCall('Pirojpur warming trend'),
    makeCall('Sylhet September trend'),
  ]);
  for (const res of [r1, r2, r3, r4]) {
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.evidenceCard);
  }
  const limited = await makeCall('one too many');
  assert.equal(limited.status, 429);
});

test('orionAgentClient resolves public base URL and OrionMapHarness bridges NL queries without UI mutation', async (t) => {
  assert.equal(
    resolveOrionAgentBaseUrl('https://api.orion-space.org/'),
    'https://api.orion-space.org',
  );
  assert.equal(resolveOrionAgentBaseUrl('javascript:alert(1)'), '');

  const client = createOrionAgentClient({
    baseUrl: 'https://api.orion-space.org',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          answer: 'Barisal September warming is +0.40°C/decade.',
          speech: 'Barisal September warming is 0.40 degrees per decade.',
          evidenceCard: {
            title: 'SEPTEMBER WARMING HOTSPOT',
            sector: 'Barisal',
            slope: '+0.40°C / decade',
          },
          mapActions: [{ type: 'fly_to_sector', sectorId: 'barisal' }],
        }),
        { status: 200 },
      ),
  });
  const asked = await client.ask({ message: 'where is warming fastest?' });
  assert.equal(asked.ok, true);

  // Import Cesium-backed module before stubbing DOM globals so Cesium/Knockout
  // treat module load as headless Node, then attach minimal DOM stubs for instance methods.
  const { OrionMapHarness } = await import('./OrionMapHarness.js');

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const messages = [];
  const statusEl = { textContent: '', innerHTML: '' };
  const msgListEl = {
    childElementCount: 0,
    appendChild(el) {
      this.childElementCount += 1;
      messages.push(el);
    },
  };
  globalThis.window = { location: { href: 'http://localhost:4173/' } };
  globalThis.document = {
    location: { href: 'http://localhost:4173/' },
    getElementById(id) {
      if (id === 'orion-harness-status-text') return statusEl;
      return null;
    },
    createElement() {
      return {
        className: '',
        textContent: '',
        style: {},
        children: [],
        appendChild(c) {
          this.children.push(c);
        },
        querySelector() {
          return null;
        },
      };
    },
    querySelector() {
      return null;
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  t.after(() => {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  });

  let remoteCalls = 0;
  const harness = new OrionMapHarness(null, {
    agentClient: {
      ask: async () => {
        remoteCalls += 1;
        return {
          ok: true,
          answer: 'Pirojpur September trend: +0.39°C/decade.',
          speech: 'Pirojpur September trend verified.',
          evidenceCard: sanitizeEvidenceCard({
            title: '<img src=x onerror=alert(1)>',
            sector: 'Pirojpur',
            slope: '+0.39°C / decade',
            narrative: 'MERRA-2 trend check.',
          }),
          mapActions: [
            { type: 'fly_to_sector', sectorId: 'pirojpur' },
            { type: 'show_evidence_card' },
          ],
        };
      },
    },
  });
  harness.speechEnabled = false;
  harness._msgList = msgListEl;
  harness._loadClimateData = async () => {};
  const shownCards = [];
  harness.showEvidenceCard = (card) => shownCards.push(card);

  // 1. Local command executes without hitting backend.
  await harness.execute('Pirojpur');
  assert.equal(remoteCalls, 0);
  assert.equal(harness.activeSector.id, 'pirojpur');

  // 2. Natural-language query goes through backend client and applies mapActions.
  await harness.execute('Pirojpur warming trend');
  assert.equal(remoteCalls, 1);
  assert.equal(shownCards.length, 1);
  assert.equal(harness.agentTurns.length, 2);
});
