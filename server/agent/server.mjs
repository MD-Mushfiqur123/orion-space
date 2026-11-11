#!/usr/bin/env node
/**
 * @file server.mjs
 * @module server/agent/server
 * @description Standalone Node.js HTTP server for production VPS / GPU host deployment.
 * Exposes only GET /health (and /api/orion/health) and POST /api/orion/agent.
 */

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadAgentConfig } from './config.js';
import { createOrionAgentHttpHandler } from './httpHandler.js';

function loadRootDotenv() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = parseEnv(readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // Ignore malformed optional dotenv files.
    }
  }
}

export function createOrionAgentServer(options = {}) {
  const getConfig = options.getConfig || (() => loadAgentConfig());
  const handler = createOrionAgentHttpHandler({ ...options, getConfig });

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0];
    if (pathname === '/health' || pathname === '/api/orion/health') {
      handler.handleHealth(req, res);
      return;
    }
    if (pathname === '/api/orion/agent') {
      handler.handleAgentRequest(req, res);
      return;
    }
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  return server;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  loadRootDotenv();
  const config = loadAgentConfig();
  const server = createOrionAgentServer({ getConfig: () => loadAgentConfig() });

  const shutdown = (signal) => {
    console.info(
      `[orion-agent] Received ${signal}, shutting down gracefully...`,
    );
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.port, config.host, () => {
    console.info(
      `[orion-agent] Listening on http://${config.host}:${config.port} (model=${config.modelName}, configured=${Boolean(config.modelBaseUrl)})`,
    );
  });
}
