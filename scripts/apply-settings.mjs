#!/usr/bin/env node
/**
 * Merge the canonical router settings into the live Claude Code user settings.
 *
 * - Backs up ~/.claude/settings.json before writing.
 * - Preserves keys the repo doesn't manage (theme, other env vars, allow rules).
 * - Unions permissions.deny instead of replacing it.
 * - Removes the obsolete "bash.deniedCommands" key.
 * - Removes the unsupported "modelAliases" key from settings.local.json.
 *
 * Usage:
 *   node scripts/apply-settings.mjs [--dry-run]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOME = os.homedir();
const DRY = process.argv.includes('--dry-run');

const canonicalPath = path.join(REPO, 'claude', 'settings.example.json');
const livePath = path.join(HOME, '.claude', 'settings.json');
const localPath = path.join(HOME, '.claude', 'settings.local.json');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const canonical = readJson(canonicalPath);
if (!canonical) {
  console.error(`cannot read ${canonicalPath}`);
  process.exit(1);
}

const live = readJson(livePath, {}) || {};
const merged = { ...live };

// Keys the repo owns.
merged.model = canonical.model;
merged.env = { ...(live.env || {}), ...(canonical.env || {}) };
merged.modelPicker = canonical.modelPicker;

// Union deny rules, preserve allow/ask/defaultMode.
const permissions = { ...(live.permissions || {}) };
const deny = new Set([...(permissions.deny || []), ...(canonical.permissions?.deny || [])]);
permissions.deny = [...deny];
merged.permissions = permissions;

// The old unsupported key.
if (merged.bash && Array.isArray(merged.bash.deniedCommands)) {
  delete merged.bash;
}

// Other top-level canonical keys (theme, skipDangerousModePermissionPrompt...).
for (const [key, value] of Object.entries(canonical)) {
  if (['model', 'env', 'modelPicker', 'permissions'].includes(key)) continue;
  merged[key] = value;
}

const before = JSON.stringify(live);
const after = JSON.stringify(merged);

if (before === after) {
  console.log('settings.json already up to date');
} else if (DRY) {
  console.log('DRY RUN: would update ~/.claude/settings.json');
  console.log(`  model: ${merged.model}`);
  console.log(`  env keys: ${Object.keys(merged.env).join(', ')}`);
  console.log(`  modelPicker rows: ${merged.modelPicker?.options?.length ?? 0}`);
  console.log(`  permissions.deny rules: ${merged.permissions.deny.length}`);
} else {
  const backup = `${livePath}.bak-${stamp()}`;
  fs.copyFileSync(livePath, backup);
  fs.writeFileSync(livePath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`updated ~/.claude/settings.json (backup: ${backup})`);
  console.log(`  model: ${merged.model}`);
  console.log(`  env keys: ${Object.keys(merged.env).join(', ')}`);
  console.log(`  modelPicker rows: ${merged.modelPicker?.options?.length ?? 0}`);
  console.log(`  permissions.deny rules: ${merged.permissions.deny.length}`);
}

// settings.local.json: remove the unsupported modelAliases block.
const local = readJson(localPath);
if (local && Object.prototype.hasOwnProperty.call(local, 'modelAliases')) {
  if (DRY) {
    console.log('DRY RUN: would remove "modelAliases" from ~/.claude/settings.local.json');
  } else {
    const backup = `${localPath}.bak-${stamp()}`;
    fs.copyFileSync(localPath, backup);
    delete local.modelAliases;
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2) + '\n');
    console.log(`removed "modelAliases" from ~/.claude/settings.local.json (backup: ${backup})`);
  }
} else {
  console.log('settings.local.json has no modelAliases key');
}
