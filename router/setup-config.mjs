#!/usr/bin/env node
/**
 * Generates providers.json for the local Claude Code router.
 *
 * Credential sources, in order:
 *   1. ~/.claude/remote-settings.json   (legacy file, may be gone)
 *   2. DEEPSEEK_API_KEY / OPENROUTER_API_KEY environment variables
 *   3. the existing ~/.claude/router/providers.json (preserve what works)
 *
 * Never prints the keys. Writes the config with mode 0600.
 *
 * Routing:
 *   deepseek-v4-flash, deepseek-v4-pro   -> DeepSeek direct
 *   openrouter/<vendor>/<model>          -> OpenRouter
 *   <vendor>/<model>                     -> OpenRouter
 *   provider:model                       -> explicit provider (handled by router.mjs)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const OUT = path.join(HERE, 'providers.json');

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const legacy = readJsonIfPresent(path.join(HOME, '.claude', 'remote-settings.json'));
const existing = readJsonIfPresent(OUT);

const deepseekKey =
  legacy?.deepseek?.api_key ||
  process.env.DEEPSEEK_API_KEY ||
  existing?.providers?.deepseek?.api_key;

const openrouterKey =
  legacy?.openrouter?.api_key ||
  process.env.OPENROUTER_API_KEY ||
  existing?.providers?.openrouter?.api_key;

if (!deepseekKey) throw new Error('no DeepSeek key: set DEEPSEEK_API_KEY or keep remote-settings.json');
if (!openrouterKey) throw new Error('no OpenRouter key: set OPENROUTER_API_KEY or keep remote-settings.json');

const cfg = {
  host: '127.0.0.1',
  port: 4000,
  default_provider: 'deepseek',
  providers: {
    deepseek: {
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: deepseekKey,
    },
    openrouter: {
      name: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      api_key: openrouterKey,
    },
  },
  rules: [
    // DeepSeek direct names have no slash: deepseek-v4-flash, deepseek-v4-pro.
    { match: '^deepseek-[^/]+$', provider: 'deepseek' },
    // Accept an explicit "openrouter/" prefix and strip it.
    { match: '^openrouter/', provider: 'openrouter', strip: 'openrouter/' },
    // Any vendor/model id (google/..., nvidia/..., openai/..., deepseek/...)
    // is an OpenRouter model.
    { match: '/', provider: 'openrouter' },
  ],
  aliases: {
    'ds': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    'ds-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    'ds-pro': { provider: 'deepseek', model: 'deepseek-v4-pro' },
    // Claude Code's short aliases map to DeepSeek by default.
    'opus': { provider: 'deepseek', model: 'deepseek-v4-pro' },
    'sonnet': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    'haiku': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    'fable': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    // OpenRouter shortcuts.
    'or': { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
    'gemma': { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' },
    'nemotron': { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    'lightning': { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' },
    'gpt-oss': { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  },
};

fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(OUT, 0o600);

console.log(`wrote ${OUT} (mode 0600)`);
console.log(`providers: ${Object.keys(cfg.providers).join(', ')}`);
console.log(`default: ${cfg.default_provider}`);
