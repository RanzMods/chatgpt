import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');
const PROXY_PATH = join(__dirname, '..', 'proxy.txt');

const SAMPLE_CONFIG = {
  defaultPassword: 'MyStr0ng!Pass2024',
  headless: false,
  slowMotion: 100,
  timeout: 60000,
  workers: 1,
  stealth: false,
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(SAMPLE_CONFIG, null, 2));
    console.log('\n  config.json was not found — a sample has been created for you.');
    console.log('  Please edit config.json before running again:\n');
    console.log('    defaultPassword  — password used for every account');
    console.log('    headless         — true = no browser window, false = visible');
    console.log('    slowMotion       — ms delay between actions (0 = fast, 200 = visible)');
    console.log('    timeout          — max ms to wait for any page action');
    console.log('    workers          — how many browsers run at the same time\n');
    process.exit(0);
  }

  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);

  const proxy = cfg.proxy?.enabled
    ? {
        enabled: true,
        server: `http://${cfg.proxy.host}:${cfg.proxy.port}`,
        username: cfg.proxy.username,
        password: cfg.proxy.password,
      }
    : { enabled: false };

  const proxies = loadProxyList();

  return {
    defaultPassword: cfg.defaultPassword ?? SAMPLE_CONFIG.defaultPassword,
    headless: cfg.headless ?? SAMPLE_CONFIG.headless,
    slowMotion: cfg.slowMotion ?? SAMPLE_CONFIG.slowMotion,
    timeout: cfg.timeout ?? SAMPLE_CONFIG.timeout,
    workers: cfg.workers ?? SAMPLE_CONFIG.workers,
    stealth: cfg.stealth ?? SAMPLE_CONFIG.stealth,
    proxy,
    proxies,
  };
}

function loadProxyList() {
  if (!existsSync(PROXY_PATH)) return [];
  const list = [];
  for (const raw of readFileSync(PROXY_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const [host, port, ...rest] = parts;
    list.push({
      enabled: true,
      server: `http://${host}:${port}`,
      username: rest[0],
      password: rest[1],
    });
  }
  return list;
}
