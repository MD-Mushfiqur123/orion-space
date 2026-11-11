/**
 * @file httpHandler.js
 * @module server/agent/httpHandler
 * @description Shared HTTP request handler for GET /health and POST /api/orion/agent
 * used by both Vite dev/preview middleware and the standalone Node.js server.
 */

import { timingSafeEqual } from 'node:crypto';
import { ORION_AGENT_MAX_BODY_BYTES } from '../../src/agent/agentContract.js';
import { clientKey, makeRateLimiter } from '../providers/common/rate-limit.js';
import { readRequestBodyCapped } from '../providers/common/request.js';
import { loadAgentConfig } from './config.js';
import { createModelGateway } from './modelGateway.js';
import { createAgentOrchestrator } from './orchestrator.js';
import { createToolRegistry } from './toolRegistry.js';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function constantTimeMatch(expected, actual) {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractRequestApiKey(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return String(req.headers?.['x-orion-api-key'] || '').trim();
}

function resolveClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return clientKey(req);
}

function buildCorsHeaders(req, config) {
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return { allowed: true, headers: { Vary: 'Origin' } };
  if (!config.corsOrigins.has(origin)) {
    return { allowed: false, headers: { Vary: 'Origin' } };
  }
  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Orion-Api-Key',
      'Access-Control-Max-Age': '600',
    },
  };
}

/** Create the shared Orion Agent HTTP handler + dependencies. */
export function createOrionAgentHttpHandler({
  getConfig = () => loadAgentConfig(),
  toolRegistry = createToolRegistry(),
  modelGateway,
  orchestrator,
} = {}) {
  const gateway = modelGateway || createModelGateway({ getConfig });
  const agent =
    orchestrator ||
    createAgentOrchestrator({
      toolRegistry,
      modelGateway: gateway,
      getConfig,
    });

  let limiterPerMin = null;
  let limiter = null;

  function getLimiter(rateLimitPerMin) {
    if (rateLimitPerMin <= 0) return null;
    if (limiterPerMin !== rateLimitPerMin || !limiter) {
      limiterPerMin = rateLimitPerMin;
      limiter = makeRateLimiter({
        windowMs: 60_000,
        max: rateLimitPerMin,
        globalMax: rateLimitPerMin * 20,
      });
    }
    return limiter;
  }

  async function handleHealth(req, res) {
    const config = getConfig();
    const cors = buildCorsHeaders(req, config);
    if (!cors.allowed) {
      sendJson(
        res,
        403,
        { ok: false, error: 'Origin not allowed' },
        cors.headers,
      );
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors.headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      sendJson(
        res,
        405,
        { ok: false, error: 'Method not allowed' },
        cors.headers,
      );
      return;
    }

    const modelHealth = await gateway.checkHealth();
    sendJson(
      res,
      200,
      {
        ok: true,
        service: 'orion-agent-backend',
        modelStatus: modelHealth.status,
        modelConfigured: modelHealth.configured,
        modelName: modelHealth.modelName,
        climateCellsInsideBangladesh:
          toolRegistry.climateEngine.insideCellCount,
        timestamp: new Date().toISOString(),
      },
      cors.headers,
    );
  }

  async function handleAgentRequest(req, res) {
    const config = getConfig();
    const cors = buildCorsHeaders(req, config);
    if (!cors.allowed) {
      sendJson(
        res,
        403,
        { ok: false, error: 'Origin not allowed' },
        cors.headers,
      );
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors.headers);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(
        res,
        405,
        { ok: false, error: 'Method not allowed' },
        cors.headers,
      );
      return;
    }

    if (
      config.agentApiKey &&
      !constantTimeMatch(config.agentApiKey, extractRequestApiKey(req))
    ) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' }, cors.headers);
      return;
    }

    const activeLimiter = getLimiter(config.rateLimitPerMin);
    if (
      activeLimiter &&
      !activeLimiter(resolveClientIp(req, config.trustProxy))
    ) {
      sendJson(
        res,
        429,
        { ok: false, error: 'Rate limit exceeded' },
        { ...cors.headers, 'Retry-After': '10' },
      );
      return;
    }

    let rawText = '';
    try {
      const buffer = await readRequestBodyCapped(
        req,
        ORION_AGENT_MAX_BODY_BYTES,
      );
      rawText = buffer.toString('utf8');
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        sendJson(
          res,
          413,
          { ok: false, error: 'Request payload too large' },
          cors.headers,
        );
        return;
      }
      sendJson(
        res,
        400,
        { ok: false, error: 'Failed to read request body' },
        cors.headers,
      );
      return;
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawText || '{}');
    } catch {
      sendJson(
        res,
        400,
        { ok: false, error: 'Invalid JSON body' },
        cors.headers,
      );
      return;
    }

    try {
      const result = await agent.handle(parsedBody);
      sendJson(res, result.statusCode, result.body, cors.headers);
    } catch (err) {
      console.warn('[orion-agent] Unhandled orchestrator error:', err?.message);
      sendJson(
        res,
        500,
        { ok: false, error: 'Internal agent error' },
        cors.headers,
      );
    }
  }

  return {
    handleHealth,
    handleAgentRequest,
  };
}
