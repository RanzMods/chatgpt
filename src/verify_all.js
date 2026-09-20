#!/usr/bin/env node
/**
 * verify_all.js — Batch-verify accounts in accounts.txt against ChatGPT.
 *
 * Usage:
 *   xvfb-run -a node src/verify_all.js              # verify all entries
 *   xvfb-run -a node src/verify_all.js --only EMAIL  # verify a single email
 *
 * Requires a display server (Xvfb) for the anti-fingerprint stealth browser.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { loadConfig } from './config.js';
import { verifyAccount } from './verify.js';

const ACCOUNTS_FILE = 'accounts.txt';
const STATUS_FILE = 'verify_status.txt';

function log(msg, level = 'info') {
  const colors = { info: '\x1b[37m', success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m' };
  const reset = '\x1b[0m';
  console.log(`${colors[level] || ''}  ${msg}${reset}`);
}

// Determine which accounts to verify
const args = process.argv.slice(2);
const onlyEmail = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

if (!existsSync(ACCOUNTS_FILE)) {
  console.error('accounts.txt not found');
  process.exit(1);
}

const lines = readFileSync(ACCOUNTS_FILE, 'utf8').split('\n').filter(Boolean);
const entries = lines
  .map((line) => {
    const [email, password, mfaKey] = line.split(':');
    return email && password ? { email, password, mfaKey: mfaKey || null, line } : null;
  })
  .filter(Boolean)
  .filter((e) => !onlyEmail || e.email === onlyEmail);

if (entries.length === 0) {
  console.error(onlyEmail ? `Email ${onlyEmail} not found in accounts.txt` : 'No accounts to verify');
  process.exit(1);
}

// Load previously-known statuses so already-verified accounts are skipped
const doneStatuses = new Map();
if (existsSync(STATUS_FILE)) {
  for (const l of readFileSync(STATUS_FILE, 'utf8').split('\n').filter(Boolean)) {
    const [email, status] = l.split(':');
    doneStatuses.set(email, status);
  }
}

const config = await loadConfig();

// Pick proxy for verification (backup ID zone as default)
const proxy = config.proxies.length > 0
  ? config.proxies[0]
  : config.proxy.enabled
    ? config.proxy
    : undefined;

console.log(`\nVerifying ${entries.length} account(s) via ${proxy?.server || 'direct'} ...\n`);

let succeeded = 0;
let failed = 0;
let skipped = 0;

for (const entry of entries) {
  // Skip already verified accounts
  if (doneStatuses.get(entry.email) === 'OK') {
    log(`  ${entry.email} — already verified, skipping`, 'warn');
    skipped++;
    continue;
  }

  log(`  Verifying ${entry.email}...`, 'info');
  try {
    const result = await verifyAccount(config, proxy, entry, log);
    const status = result.ok ? 'OK' : `FAIL — ${result.reason}`;
    appendFileSync(STATUS_FILE, `${entry.email}:${status}\n`);
    if (result.ok) {
      succeeded++;
      log(`  ✓ ${entry.email} verified successfully`, 'success');
    } else {
      failed++;
      log(`  ✗ ${entry.email} FAILED: ${result.reason}`, 'error');
    }
  } catch (e) {
    appendFileSync(STATUS_FILE, `${entry.email}:FAIL — ${e.message}\n`);
    failed++;
    log(`  ✗ ${entry.email} ERROR: ${e.message}`, 'error');
  }
}

console.log('\n═══════════════════════════════════════');
console.log('  Verification Summary');
console.log('═══════════════════════════════════════');
console.log(`  Verified : ${succeeded}`);
console.log(`  Failed   : ${failed}`);
console.log(`  Skipped  : ${skipped}`);
console.log(`  Total    : ${entries.length}`);
console.log(`  Details  : ${STATUS_FILE}`);
console.log('═══════════════════════════════════════\n');
