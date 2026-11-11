/**
 * @file modelGateway.js
 * @module server/agent/modelGateway
 * @description OpenAI-compatible gateway for the Orion Qwen3-0.6B inference server.
 * Enforces timeouts, concurrency bounds, capped reads, Qwen3 tag parsing, and secret isolation.
 */

import { readCappedResponseText } from '../providers/common/http.js';

const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
const HEALTH_CACHE_TTL_MS = 10_000;

/** Strip Qwen3 <think>...</think> reasoning blocks before displaying text. */
export function stripThinkingBlocks(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

/**
 * Parse inline <tool_call>{...}</tool_call> tags emitted when a runtime
 * returns Qwen/Hermes tool calls inside message.content instead of tool_calls.
 */
export function extractInlineToolCalls(content) {
  const calls = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  let index = 0;
  while ((match = regex.exec(String(content || ''))) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed.name === 'string') {
        calls.push({
          id: `inline_call_${index++}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments:
              typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {}),
          },
        });
      }
    } catch {
      // Ignore malformed inline tool blocks; orchestrator handles fallback.
    }
  }
  return calls;
}

class ConcurrencySemaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  async acquire(timeoutMs) {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    if (this.queue.length >= this.limit * 2) {
      const err = new Error('Model concurrency queue saturated');
      err.code = 'MODEL_BUSY';
      throw err;
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve: null, timer: null };
      entry.timer = setTimeout(
        () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          const err = new Error('Timed out waiting for model slot');
          err.code = 'MODEL_BUSY';
          reject(err);
        },
        Math.min(timeoutMs, 5000),
      );
      entry.resolve = () => {
        clearTimeout(entry.timer);
        this.active += 1;
        resolve(() => this.release());
      };
      this.queue.push(entry);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}

/** Create an OpenAI-compatible Qwen3 model gateway client. */
export function createModelGateway({
  getConfig,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let semaphoreKey = '';
  let semaphore = new ConcurrencySemaphore(4);
  let healthCache = { checkedAt: 0, value: null };

  function getSemaphore(limit) {
    const key = String(limit);
    if (key !== semaphoreKey) {
      semaphoreKey = key;
      semaphore = new ConcurrencySemaphore(limit);
    }
    return semaphore;
  }

  function buildAuthHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.modelApiKey) {
      headers.Authorization = `Bearer ${config.modelApiKey}`;
    }
    return headers;
  }

  async function chatCompletions({
    messages,
    tools,
    temperature = 0.2,
    maxTokens,
  }) {
    const config = getConfig();
    if (!config.modelBaseUrl) {
      const err = new Error('Model endpoint is not configured');
      err.code = 'MODEL_UNCONFIGURED';
      throw err;
    }

    const release = await getSemaphore(config.modelConcurrency).acquire(
      config.modelTimeoutMs,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);

    try {
      const endpoint = `${config.modelBaseUrl}/v1/chat/completions`;
      const body = {
        model: config.modelName,
        messages,
        temperature,
        max_tokens: maxTokens || config.modelMaxOutputTokens,
        ...(Array.isArray(tools) && tools.length
          ? { tools, tool_choice: 'auto' }
          : {}),
      };

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: buildAuthHeaders(config),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      const read = await readCappedResponseText(res, MAX_MODEL_RESPONSE_BYTES);
      if (read.tooLarge) {
        const err = new Error('Model response exceeded cap');
        err.code = 'MODEL_BAD_RESPONSE';
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`Model upstream HTTP ${res.status}`);
        err.code = 'MODEL_HTTP_ERROR';
        err.status = res.status;
        throw err;
      }

      const payload = JSON.parse(read.text);
      const message = payload?.choices?.[0]?.message;
      if (!message || typeof message !== 'object') {
        const err = new Error('Malformed chat completion payload');
        err.code = 'MODEL_BAD_RESPONSE';
        throw err;
      }

      const rawContent =
        typeof message.content === 'string' ? message.content : '';
      const structuredCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      const inlineCalls =
        structuredCalls.length === 0 ? extractInlineToolCalls(rawContent) : [];

      return {
        model: payload.model || config.modelName,
        content: stripThinkingBlocks(
          rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ''),
        ),
        toolCalls: structuredCalls.length ? structuredCalls : inlineCalls,
        usage: payload.usage || null,
      };
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error('Model request timed out');
        timeoutErr.code = 'MODEL_TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  async function checkHealth({ force = false } = {}) {
    const config = getConfig();
    if (!config.modelBaseUrl) {
      return {
        configured: false,
        reachable: false,
        status: 'unconfigured',
        provider: config.provider,
        modelName: config.modelName,
      };
    }

    const currentTime = now();
    if (
      !force &&
      healthCache.value &&
      currentTime - healthCache.checkedAt < HEALTH_CACHE_TTL_MS
    ) {
      return healthCache.value;
    }

    const headers = config.modelApiKey
      ? { Authorization: `Bearer ${config.modelApiKey}` }
      : {};

    let reachable = false;
    let status = 'degraded';
    for (const probePath of ['/health', '/v1/models']) {
      try {
        const res = await fetchImpl(`${config.modelBaseUrl}${probePath}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(2500),
          redirect: 'error',
        });
        if (res.ok) {
          reachable = true;
          status = 'ready';
          break;
        }
      } catch {
        // Try next probe path.
      }
    }

    const snapshot = {
      configured: true,
      reachable,
      status,
      provider: config.provider,
      modelName: config.modelName,
    };
    healthCache = { checkedAt: currentTime, value: snapshot };
    return snapshot;
  }

  return {
    chatCompletions,
    checkHealth,
  };
}
