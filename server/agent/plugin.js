/**
 * @file plugin.js
 * @module server/agent/plugin
 * @description Vite middleware plugin mounting /api/orion/agent and /api/orion/health
 * (+ /health) inside local dev and preview servers.
 */

import { createOrionAgentHttpHandler } from './httpHandler.js';

export function orionAgentProxy(options = {}) {
  const handler = createOrionAgentHttpHandler(options);

  function install(middlewares) {
    middlewares.use('/api/orion/agent', (req, res, next) => {
      const subPath = String(req.url || '').split('?')[0];
      if (subPath && subPath !== '/') {
        next();
        return;
      }
      handler.handleAgentRequest(req, res);
    });

    middlewares.use('/api/orion/health', (req, res) => {
      handler.handleHealth(req, res);
    });

    middlewares.use('/health', (req, res, next) => {
      const subPath = String(req.url || '').split('?')[0];
      if (subPath && subPath !== '/') {
        next();
        return;
      }
      handler.handleHealth(req, res);
    });
  }

  return {
    name: 'orion-agent-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
