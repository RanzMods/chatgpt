import inquirer from 'inquirer';
import chalk from 'chalk';
import { appendFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { createAccount } from './bot.js';

const OUTPUT_FILE = 'accounts.txt';

// Keep the process alive against transient Playwright/Chromium internal errors
// (e.g. "Invalid InterceptionId") so a single worker hiccup doesn't kill the pool.
process.on('uncaughtException', (err) => {
  console.error(chalk.yellow(`[fatal] Uncaught (non-fatal, continuing): ${err?.message || err}`));
});
process.on('unhandledRejection', (err) => {
  console.error(chalk.yellow(`[fatal] Unhandled rejection (non-fatal, continuing): ${err?.message || err}`));
});

function banner() {
  console.log(chalk.cyan('\n╔══════════════════════════════════════╗'));
  console.log(chalk.cyan('║     ChatGPT Signup Bot — Learning     ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════╝\n'));
}

function workerLog(workerId, message, level = 'info') {
  const prefix = chalk.gray(`[Worker ${workerId}]`);
  const colors = { info: chalk.white, success: chalk.green, error: chalk.red, warn: chalk.yellow };
  const colorFn = colors[level] ?? chalk.white;
  console.log(`${prefix} ${colorFn(message)}`);
}

function saveAccount(email, password, mfaKey) {
  const line = mfaKey ? `${email}:${password}:${mfaKey}\n` : `${email}:${password}\n`;
  appendFileSync(OUTPUT_FILE, line, 'utf8');
}

async function runWorker(workerId, config) {
  const log = (msg, level = 'info') => workerLog(workerId, msg, level);

  const attempts = [];
  if (config.proxy.enabled) {
    attempts.push({ proxy: config.proxy, label: `${config.proxy.server} (${config.proxy.username})` });
  }
  if (config.proxies.length > 0) {
    const px = config.proxies[(workerId - 1) % config.proxies.length];
    if (!config.proxy.enabled || px.username !== config.proxy.username || px.server !== config.proxy.server) {
      attempts.push({ proxy: px, label: `${px.server} (${px.username} - proxy.txt backup)` });
    }
  }
  if (attempts.length === 0) {
    attempts.push({ proxy: undefined, label: 'direct' });
  }

  for (let i = 0; i < attempts.length; i++) {
    const { proxy: p, label } = attempts[i];
    log(`${i === 0 ? 'Starting' : 'Retrying'} with proxy: ${label}`);
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      try {
        const account = await createAccount(config, (msg, lvl) => log(msg, lvl), p);
        saveAccount(account.email, account.password, account.mfaKey);

        const mfaTag = account.mfaKey ? ` [2FA Key: ${account.mfaKey}]` : '';
        log(`✓ Done — ${account.email}${mfaTag}`, 'success');
        log('Account saved to accounts.txt. Run `xvfb-run -a node src/verify_all.js` later to confirm the account is active.', 'info');
        return { success: true, account };
      } catch (err) {
        log(`✗ Failed — ${err.message}`, 'error');
        // Retry once on the same proxy if the browser itself failed (relaunch races,
        // leftover processes). Full signup retries are expensive, so only do it when
        // the failure happened at (or very near) browser launch.
        const browserLevel = /browser has been closed|launchPersistentContext|browserType|Target page|Timed out waiting for browser/i.test(
          err.message || ''
        );
        if (attemptNo === 1 && browserLevel) {
          log('Browser-level failure — retrying once on the same proxy after cleanup...', 'warn');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        break;
      }
    }
    // Allow the browser/Xvfb to fully tear down before the next proxy attempt
    if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 4000));
  }

  return { success: false, error: 'All proxy attempts failed' };
}

async function runPool(total, config) {
  const { workers } = config;
  let queued = total;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let nextWorkerId = 1;
  const active = new Set();

  const results = [];

  async function spawnWorker() {
    if (queued === 0) return;
    queued--;
    const id = nextWorkerId++;
    active.add(id);
    const result = await runWorker(id, config);
    results.push(result);
    completed++;
    if (result.success) succeeded++;
    else failed++;
    active.delete(id);
    printProgress(completed, total, succeeded, failed);
    await spawnWorker();
  }

  const initialBatch = Math.min(workers, total);
  const tasks = Array.from({ length: initialBatch }, () => spawnWorker());
  await Promise.all(tasks);

  return { succeeded, failed, results };
}

function printProgress(done, total, succeeded, failed) {
  const bar = buildBar(done, total, 20);
  console.log(
    chalk.gray(`\n  Progress: ${bar} ${done}/${total}  `) +
    chalk.green(`✓ ${succeeded}`) +
    chalk.gray('  ') +
    chalk.red(`✗ ${failed}`) +
    '\n'
  );
}

function buildBar(done, total, width) {
  const filled = Math.round((done / total) * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

function hasXvfb() {
  return spawnSync('which', ['xvfb-run']).status === 0;
}

async function main() {
  banner();

  const config = loadConfig();

  if (config.stealth && !process.env.DISPLAY) {
    if (hasXvfb()) {
      console.log(chalk.gray('Stealth mode needs a display — relaunching under Xvfb...\n'));
      const res = spawnSync(
        'xvfb-run',
        ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: 'inherit', env: process.env }
      );
      process.exit(res.status ?? 0);
    }
    console.error(chalk.red('Stealth mode requires a display (Xvfb). Run "bash install.sh" to auto-install all dependencies.'));
    process.exit(1);
  }

  console.log(chalk.gray('Current config:'));
  console.log(chalk.gray(`  headless    : ${config.headless}`));
  console.log(chalk.gray(`  slowMotion  : ${config.slowMotion}ms`));
  console.log(chalk.gray(`  timeout     : ${config.timeout}ms`));
  console.log(chalk.gray(`  workers     : ${config.workers}`));
  console.log(chalk.gray(`  stealth     : ${config.stealth ? chalk.green('ON (anti-fingerprint extension)') : chalk.red('OFF')}`));
  console.log(chalk.gray(`  proxy       : ${config.proxy.enabled ? chalk.green('enabled (' + config.proxy.server + ')') : chalk.red('disabled')}`));
  if (config.proxies.length > 0) {
    console.log(chalk.gray(`  proxy list  : ${chalk.yellow(config.proxies.length)} entries in proxy.txt (rotated)`));
  }
  console.log('');

  const args = process.argv.slice(2);
  const argCount = args[0] ? parseInt(args[0]) : null;
  const argPassword = args[1] ?? null;

  let count, password;

  if (argCount && !isNaN(argCount) && argCount >= 1 && argCount <= 50) {
    count = argCount;
    password = argPassword ?? config.defaultPassword;
    console.log(chalk.gray(`  Using CLI args: ${count} account(s), password provided`));
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'number',
        name: 'count',
        message: 'How many accounts do you want to create?',
        default: 1,
        validate: (v) => (v >= 1 && v <= 50 ? true : 'Enter a number between 1 and 50'),
      },
      {
        type: 'input',
        name: 'password',
        message: 'Password to use for all accounts:',
        default: config.defaultPassword,
      },
    ]);
    count = answers.count;
    password = answers.password;
  }

  config.defaultPassword = password;

  console.log(chalk.cyan(`Starting ${count} account(s) with up to ${config.workers} worker(s)...`));
  console.log(chalk.gray(`Results will be saved to: ${chalk.white(OUTPUT_FILE)}\n`));

  const start = Date.now();
  const { succeeded, failed } = await runPool(count, config);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(chalk.cyan('═══════════════════════════════════════'));
  console.log(chalk.bold('  Summary'));
  console.log(chalk.cyan('═══════════════════════════════════════'));
  console.log(`  Total requested : ${count}`);
  console.log(`  ${chalk.green('Succeeded')}       : ${succeeded}`);
  console.log(`  ${chalk.red('Failed')}          : ${failed}`);
  console.log(`  Time taken      : ${elapsed}s`);
  if (succeeded > 0) {
    console.log(`  Saved to        : ${chalk.white(OUTPUT_FILE)}`);
  }
  console.log(chalk.cyan('═══════════════════════════════════════\n'));
}

main().catch((err) => {
  console.error(chalk.red('\nFatal error:'), err.message);
  process.exit(1);
});
