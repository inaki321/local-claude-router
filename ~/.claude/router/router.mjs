#!/usr/bin/env node
/**
 * Local Anthropic-compatible provider router for Claude Code.
 *
 * Claude Code talks to this process as if it were api.anthropic.com.
 * The router reads the request's "model" field and forwards the request,
 * untouched, to the provider that owns that model:
 *
 *   deepseek-flash / deepseek-*        -> DeepSeek's Anthropic endpoint
 *   openrouter/... or vendor/model    -> OpenRouter's Anthropic endpoint
 *   claude-* / sonnet / opus / ...     -> api.anthropic.com
 *
 * It also accepts an explicit "provider:model" prefix, e.g.
 *   deepseek:deepseek-flash
 *   openrouter:google/gemma-4-26b-a4b-it:free
 *   anthropic:claude-sonnet-5-5
 *
 * Config: providers.json next to this file (or $CLAUDE_ROUTER_CONFIG).
 * No third-party dependencies; requires Node 18+.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env.CLAUDE_ROUTER_CONFIG || path.join(HERE, 'providers.json');

function fail(message) {
  console.error(`[router] fatal: ${message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  fail(`cannot read config ${CONFIG_PATH}: ${err.message}`);
}

const HOST = config.host || '127.0.0.1';
const PORT = Number(config.port || 4000);
const DEFAULT_PROVIDER = config.default_provider || 'anthropic';

for (const [name, p] of Object.entries(config.providers || {})) {
  if (!p.base_url) fail(`provider "${name}" has no base_url`);
  if (!p.api_key) fail(`provider "${name}" has no api_key`);
}

const RULES = (config.rules || []).map((r) => ({
  re: new RegExp(r.match),
  provider: r.provider,
  strip: r.strip || null,
}));

const ALIASES = config.aliases || {};
const PROVIDER_NAMES = Object.keys(config.providers || {});

function log(...args) {
  console.log(new Date().toISOString(), '[router]', ...args);
}

function resolve(model) {
  // 1. Explicit "provider:model" prefix. Only treats real provider names as
  //    prefixes, so OpenRouter ids like "google/...:free" are untouched.
  if (typeof model === 'string') {
    const colon = model.indexOf(':');
    if (colon > 0) {
      const maybeProvider = model.slice(0, colon);
      if (PROVIDER_NAMES.includes(maybeProvider)) {
        return { provider: config.providers[maybeProvider], model: model.slice(colon + 1), via: 'prefix' };
      }
    }
  }

  // 2. Named shortcut from providers.json "aliases".
  if (typeof model === 'string' && ALIASES[model]) {
    const a = ALIASES[model];
    return { provider: config.providers[a.provider], model: a.model, via: 'alias' };
  }

  // 3. Pattern rules.
  if (typeof model === 'string') {
    for (const rule of RULES) {
      if (!rule.re.test(model)) continue;
      let upstream = model;
      if (rule.strip && upstream.startsWith(rule.strip)) {
        upstream = upstream.slice(rule.strip.length);
      }
      if (rule.prefix) upstream = rule.prefix + upstream;
      return { provider: config.providers[rule.provider], model: upstream, via: 'rule' };
    }
  }

  // 4. Fallback.
  return { provider: config.providers[DEFAULT_PROVIDER], model, via: 'default' };
}

function upstreamHeaders(req, provider) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (
      key === 'host' ||
      key === 'authorization' ||
      key === 'x-api-key' ||
      key === 'content-length' ||
      key === 'accept-encoding' ||
      key === 'connection' ||
      key === 'transfer-encoding'
    ) {
      continue;
    }
    if (v !== undefined) out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  // Providers accept x-api-key; OpenRouter and DeepSeek also accept Bearer,
  // but x-api-key avoids sending two conflicting credentials.
  out['x-api-key'] = provider.api_key;
  out['accept-encoding'] = 'identity';
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  req.on('error', () => { /* client aborted */ });
  res.on('error', () => { /* client aborted */ });
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    sendJson(res, 200, {
      ok: true,
      listen: `${HOST}:${PORT}`,
      default_provider: DEFAULT_PROVIDER,
      providers: PROVIDER_NAMES,
    });
    return;
  }

  // Claude Code probes this endpoint to check connectivity.
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    return;
  }

  let body = Buffer.alloc(0);
  let parsed = null;
  let model;
  let resolved;

  try {
    body = await readBody(req);
    if (body.length > 0 && (req.headers['content-type'] || '').includes('json')) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
        model = parsed?.model;
      } catch {
        parsed = null;
      }
    }

    resolved = resolve(model);

    // Rewrite the model field when the router mapped it to something else.
    if (parsed && typeof model === 'string' && resolved.model !== model) {
      parsed.model = resolved.model;
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
    }

    const base = resolved.provider.base_url.replace(/\/+$/, '');
    const target = base + url.pathname + url.search;

    log(
      `${req.method} ${url.pathname} model=${JSON.stringify(model ?? null)}`,
      `-> ${resolved.provider.name || '?'} ${resolved.model ?? ''} (${resolved.via})`
    );

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        try { ac.abort(); } catch { /* already closed */ }
      }
    });

    const upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req, resolved.provider),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: ac.signal,
    });

    // OpenRouter does not implement Anthropic's count_tokens endpoint.
    // Return a local estimate instead of a 404 so Claude Code's context
    // accounting keeps working.
    if (upstream.status === 404 && url.pathname.endsWith('/count_tokens') && parsed) {
      const text = JSON.stringify(parsed.messages ?? parsed);
      sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
      return;
    }

    const outHeaders = {};
    for (const [k, v] of upstream.headers) {
      if (
        k === 'content-encoding' ||
        k === 'content-length' ||
        k === 'transfer-encoding' ||
        k === 'connection' ||
        k === 'keep-alive'
      ) {
        continue;
      }
      outHeaders[k] = v;
    }

    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body || req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', (streamErr) => {
      // Client disconnects (e.g. user cancels) abort the upstream request.
      // Without this handler Node treats it as an uncaught 'error' event
      // and kills the whole router.
      if (streamErr?.name !== 'AbortError') {
        log(`stream error: ${streamErr?.message || streamErr}`);
      }
      if (!res.destroyed) res.destroy();
    });
    res.on('error', () => { /* client went away */ });
    stream.pipe(res);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    log(`error: ${err?.message || err}`);
    if (!res.headersSent) {
      sendJson(res, 502, {
        type: 'error',
        error: { type: 'api_error', message: `claude-router: ${err?.message || err}` },
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (config: ${CONFIG_PATH})`);
  log(`providers: ${PROVIDER_NAMES.join(', ')}; default: ${DEFAULT_PROVIDER}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    // Close the listener, then tear down keep-alive connections so systemd
    // can actually see the process exit and restart it.
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
