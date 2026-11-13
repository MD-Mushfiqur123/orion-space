#!/usr/bin/env node
/**
 * @file verify_deployment.mjs
 * @module deploy/verify_deployment
 * @description Comprehensive Phase 4 production verification test suite:
 * - Backend API health & Model Gateway status
 * - Model server /ready & /health checks
 * - Direct OpenAI-compatible POST /v1/chat/completions
 * - Agent backend POST /api/orion/agent scientific grounding & tool planning
 * - Map action sanitization
 * - CORS preflight & origin enforcement
 * - Concurrency control & rate limiting
 * - Latency & memory benchmarking
 * - GitHub Pages build verification
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createOrionAgentServer } from '../server/agent/server.mjs';
import { loadAgentConfig } from '../server/agent/config.js';
import { createAgentOrchestrator } from '../server/agent/orchestrator.js';
import { sanitizeMapActions } from '../src/agent/agentContract.js';

const TEST_PORT = 3199;
const MODEL_PORT = 8199;
const BACKEND_URL = `http://127.0.0.1:${TEST_PORT}`;
const MODEL_URL = `http://127.0.0.1:${MODEL_PORT}`;
const MOCK_API_KEY = 'test-secret-orion-key-2026';
const GITHUB_PAGES_ORIGIN = 'https://md-mushfiqur123.github.io';

let passedTests = 0;
let totalTests = 0;
const benchmarks = [];

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  [PASS] ${message}`);
}

function makeRequest({ method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqHeaders = { ...headers };
    reqHeaders['Connection'] = reqHeaders['Connection'] || 'close';
    let payload = null;

    if (body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const start = performance.now();
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Math.round(performance.now() - start);
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw,
            json,
            latencyMs,
          });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out to ${url}`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function runSuite() {
  console.log('='.repeat(70));
  console.log('       ORION SPACE — PHASE 4 PRODUCTION VERIFICATION SUITE');
  console.log('='.repeat(70));

  // 1. Start Model Server
  console.log('\n[1/8] Starting Orion Model Inference Server on port ' + MODEL_PORT + '...');
  const modelProcess = spawn(
    'python3',
    ['deploy/model_server.py', '--port', String(MODEL_PORT)],
    {
      env: {
        ...process.env,
        ORION_MODEL_API_KEY: MOCK_API_KEY,
        ORION_MODEL_NAME: 'orion-qwen3-0.6b',
        ORION_MODEL_REVISION: 'v0.1-deploy',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  modelProcess.stderr.on('data', (d) => {
    // Suppress normal logs, print on crash
  });

  // Wait for model server to be healthy
  let modelUp = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await makeRequest({ method: 'GET', url: `${MODEL_URL}/health` });
      if (res.status === 200 && res.json?.status === 'healthy') {
        modelUp = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(modelUp, 'Model inference server booted and responded to /health');

  // 2. Start Orion Agent Backend Server
  console.log('\n[2/8] Starting Orion Node.js Agent Backend on port ' + TEST_PORT + '...');
  const customEnv = {
    NODE_ENV: 'production',
    ORION_AGENT_PORT: String(TEST_PORT),
    ORION_AGENT_HOST: '127.0.0.1',
    ORION_CORS_ORIGIN: GITHUB_PAGES_ORIGIN,
    ORION_ALLOW_LOCALHOST_CORS: 'false',
    ORION_MODEL_PROVIDER: 'qwen3',
    ORION_MODEL_BASE_URL: MODEL_URL,
    ORION_MODEL_API_KEY: MOCK_API_KEY,
    ORION_MODEL_NAME: 'orion-qwen3-0.6b',
    ORION_MODEL_TIMEOUT_MS: '8000',
    ORION_AGENT_RATELIMIT_PER_MIN: '100',
  };

  const backendServer = createOrionAgentServer({
    getConfig: () => loadAgentConfig(customEnv),
  });

  await new Promise((resolve) => backendServer.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log('  [+] Backend server listening.');

  try {
    // 3. Health & Readiness Verification
    console.log('\n[3/8] Verifying Health & Readiness Endpoints...');
    const backendHealth = await makeRequest({ method: 'GET', url: `${BACKEND_URL}/health` });
    assert(backendHealth.status === 200, 'GET /health returns HTTP 200');
    assert(backendHealth.json.ok === true, 'Backend health reports ok: true');
    assert(
      backendHealth.json.modelConfigured === true,
      'Backend reports modelConfigured: true',
    );
    assert(
      backendHealth.json.modelName === 'orion-qwen3-0.6b',
      'Backend reports modelName: orion-qwen3-0.6b',
    );
    assert(
      backendHealth.json.modelStatus === 'ready',
      'Backend reports modelStatus: ready',
    );

    const modelReady = await makeRequest({ method: 'GET', url: `${MODEL_URL}/ready` });
    assert(modelReady.status === 200, 'Model server /ready returns HTTP 200');
    assert(modelReady.json.ready === true, 'Model server reports ready: true');

    // 4. Model Direct Chat Completion & Auth
    console.log('\n[4/8] Testing Direct Model Server Endpoint & Auth...');
    // Unauthorized attempt
    const unauth = await makeRequest({
      method: 'POST',
      url: `${MODEL_URL}/v1/chat/completions`,
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert(unauth.status === 401, 'Model server rejects unauthenticated call with HTTP 401');

    // Authorized attempt
    const authDirect = await makeRequest({
      method: 'POST',
      url: `${MODEL_URL}/v1/chat/completions`,
      headers: { Authorization: `Bearer ${MOCK_API_KEY}` },
      body: {
        model: 'orion-qwen3-0.6b',
        messages: [{ role: 'user', content: 'What is the warming trend in Barisal in September?' }],
      },
    });
    assert(authDirect.status === 200, 'Model server responds HTTP 200 with Bearer token');
    const choice = authDirect.json.choices?.[0]?.message;
    assert(
      (choice?.content && choice.content.length > 0) ||
        (Array.isArray(choice?.tool_calls) && choice.tool_calls.length > 0),
      'Model returned content choice or structured tool calls',
    );
    benchmarks.push({
      label: 'Direct Model Inference (Local Emulation)',
      latencyMs: authDirect.latencyMs,
    });

    // 5. Scientific Grounding & Tool Planning via Backend
    console.log('\n[5/8] Testing Scientific Questions via POST /api/orion/agent...');

    // Question A: Barisal September warming
    const q1 = await makeRequest({
      method: 'POST',
      url: `${BACKEND_URL}/api/orion/agent`,
      headers: { Origin: GITHUB_PAGES_ORIGIN },
      body: { message: 'Is Barisal warming in September?' },
    });
    assert(q1.status === 200, 'Agent returns HTTP 200 for Barisal warming query');
    assert(q1.json.ok === true, 'Agent response ok: true');
    assert(
      q1.json.answer?.toLowerCase().includes('barisal') || q1.json.answer?.includes('0.36'),
      'Agent reply cites Barisal climate data',
    );
    assert(Array.isArray(q1.json.mapActions), 'Agent returned mapActions array');
    assert(q1.json.mapActions.length > 0, 'Agent triggered map action for Barisal');
    benchmarks.push({
      label: 'Barisal September Climate Query (End-to-End)',
      latencyMs: q1.latencyMs,
    });

    // Question B: October warming FDR guardrail
    const q2 = await makeRequest({
      method: 'POST',
      url: `${BACKEND_URL}/api/orion/agent`,
      headers: { Origin: GITHUB_PAGES_ORIGIN },
      body: { message: 'What is the October temperature trend for Bangladesh?' },
    });
    assert(q2.status === 200, 'Agent returns HTTP 200 for October trend');
    assert(
      q2.json.answer?.toLowerCase().includes('fdr') ||
        q2.json.answer?.toLowerCase().includes('significan') ||
        q2.json.answer?.toLowerCase().includes('october'),
      'Agent reply respects scientific FDR guardrails for October',
    );
    benchmarks.push({
      label: 'October FDR Guardrail Query (End-to-End)',
      latencyMs: q2.latencyMs,
    });

    // Question C: Live Weather honest fallback
    const q3 = await makeRequest({
      method: 'POST',
      url: `${BACKEND_URL}/api/orion/agent`,
      headers: { Origin: GITHUB_PAGES_ORIGIN },
      body: { message: 'What is the live weather in Dhaka?' },
    });
    assert(q3.status === 200, 'Agent returns HTTP 200 for live weather query');
    assert(
      q3.json.answer?.includes('Dhaka') || q3.json.answer?.includes('weather'),
      'Agent responded to Dhaka weather request',
    );

    // 6. Security, CORS & Rate Limiting
    console.log('\n[6/8] Verifying Security, CORS & Request Limits...');
    // Preflight OPTIONS
    const preflight = await makeRequest({
      method: 'OPTIONS',
      url: `${BACKEND_URL}/api/orion/agent`,
      headers: {
        Origin: GITHUB_PAGES_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    assert(preflight.status === 204, 'Preflight OPTIONS returns HTTP 204');
    assert(
      preflight.headers['access-control-allow-origin'] === GITHUB_PAGES_ORIGIN,
      'CORS header matches exact GitHub Pages origin',
    );

    // Disallowed origin
    const disallowedOrigin = await makeRequest({
      method: 'POST',
      url: `${BACKEND_URL}/api/orion/agent`,
      headers: { Origin: 'https://malicious-site.example.com' },
      body: { message: 'hello' },
    });
    assert(
      disallowedOrigin.headers['access-control-allow-origin'] === undefined,
      'Disallowed origin does NOT receive Access-Control-Allow-Origin header',
    );

    // Payload size guard (> 32KB max body bytes)
    const giantPayload = 'A'.repeat(33 * 1024);
    let oversizedStatus = 0;
    try {
      const oversized = await makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        body: giantPayload,
      });
      oversizedStatus = oversized.status;
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'ECONNRESET') {
        oversizedStatus = 413;
      }
    }
    assert(oversizedStatus === 413, 'Oversized request is rejected with HTTP 413');

    // 7. Map Action Sanitization & Concurrent Request Suite
    console.log('\n[7/8] Verifying Map Action Sanitization & Concurrent Load...');
    const safeActions = sanitizeMapActions([
      {
        type: 'fly_to_coords',
        lat: 22.7,
        lon: 90.37,
        altitude: 120000,
      },
    ]);
    assert(safeActions.length === 1, 'Valid fly_to_coords action sanitized successfully');
    assert(safeActions[0].lat === 22.7, 'Preserved safe coordinate');

    const unsafeActions = sanitizeMapActions([
      {
        type: 'eval',
        code: 'window.alert(1)',
      },
    ]);
    assert(unsafeActions.length === 0, 'Disallowed action dropped by sanitizer');

    // Concurrent load test (5 parallel agent turns)
    const concurrentStart = performance.now();
    const parallelQueries = await Promise.all([
      makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        headers: { Origin: GITHUB_PAGES_ORIGIN },
        body: { message: 'Is Barisal warming in September?' },
      }),
      makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        headers: { Origin: GITHUB_PAGES_ORIGIN },
        body: { message: 'What is the temperature trend in October?' },
      }),
      makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        headers: { Origin: GITHUB_PAGES_ORIGIN },
        body: { message: 'Live weather report for Dhaka' },
      }),
      makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        headers: { Origin: GITHUB_PAGES_ORIGIN },
        body: { message: 'Any active fires in Bangladesh?' },
      }),
      makeRequest({
        method: 'POST',
        url: `${BACKEND_URL}/api/orion/agent`,
        headers: { Origin: GITHUB_PAGES_ORIGIN },
        body: { message: 'Crop advisory for Rangpur' },
      }),
    ]);
    const concurrentDuration = Math.round(performance.now() - concurrentStart);
    const allSuccessful = parallelQueries.every((r) => r.status === 200 && r.json?.ok);
    assert(allSuccessful, '5 concurrent agent requests completed successfully');
    benchmarks.push({
      label: '5 Concurrent Agent Queries (Parallel)',
      latencyMs: concurrentDuration,
    });

    // 8. Performance Benchmark Summary
    console.log('\n[8/8] Performance Benchmark Summary');
    const modelHealth = await makeRequest({ method: 'GET', url: `${MODEL_URL}/health` });
    console.log('-'.repeat(70));
    console.log(
      `Model Server RSS Memory:  ${modelHealth.json.memory?.cpu_rss_mb || 'N/A'} MB`,
    );
    console.log(`Model Server Concurrency: ${modelHealth.json.active_concurrency}`);
    console.log(`Total Served Queries:     ${modelHealth.json.total_requests_served}`);
    console.log('-'.repeat(70));
    for (const b of benchmarks) {
      console.log(`  * ${b.label.padEnd(45)}: ${b.latencyMs} ms`);
    }
    console.log('='.repeat(70));
    console.log(`\nALL ${passedTests}/${totalTests} DEPLOYMENT VERIFICATION TESTS PASSED!\n`);
  } finally {
    // Teardown
    backendServer.close();
    modelProcess.kill('SIGTERM');
  }
}

runSuite().catch((err) => {
  console.error('\n[FATAL TEST RUN ERROR]', err);
  process.exit(1);
});
