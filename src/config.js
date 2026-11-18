import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.LT_CONFIG
  ? path.resolve(process.env.LT_CONFIG)
  : path.join(ROOT, 'lighthouse-tester.config.json');

const mobile = {
  formFactor: 'mobile',
  userAgent: null,
  throttlingMethod: 'simulate',
  locale: 'en-US',
  timezone: null,
  colorScheme: 'light',
  reducedMotion: false,
  saveData: false,
  blockedUrlPatterns: [],
  extraHeaders: {},
};

export const DEFAULT_CONFIG = {
  outputDir: 'output',
  defaults: { runs: 5, cooldownSec: 10, cache: 'cold', warmup: false, categories: ['performance'] },
  probes: {
    // Host for latency/jitter probes. null = use the first target URL's host.
    latencyHost: null,
    // Download probe for the throughput check. null disables it ("Not assessed").
    throughputUrl: 'https://speed.cloudflare.com/__down?bytes=10000000',
  },
  thresholds: {
    power: { requireAC: true, warnPercent: 30, poorPercent: 15 },
    cpuLoadPct: { warn: 20, poor: 60 },
    freeMemGb: { warn: 4, poor: 2 },
    thermalSpeedLimitPct: { warn: 99, poor: 70 },
    thermalTempC: { warn: 80, poor: 90 },
    latencyMs: { warn: 100, poor: 250 },
    jitterMs: { warn: 15, poor: 50 },
    packetLossPct: { warn: 1, poor: 5 },
    downloadMbps: { warn: 20, poor: 5 },
    wifiSignalDbm: { warn: -70, poor: -80 },
  },
  regression: { scorePoints: 5, lcpPct: 10, tbtPct: 15, clsAbs: 0.02, fcpPct: 10, siPct: 10 },
  profiles: [
    {
      ...mobile,
      id: 'moto-g-slow-4g',
      name: 'Moto G Power · Slow 4G · 4× CPU',
      screen: { width: 412, height: 823, deviceScaleFactor: 1.75 },
      throttling: { rttMs: 150, downloadKbps: 1638.4, uploadKbps: 675, cpuSlowdownMultiplier: 4 },
    },
    {
      ...mobile,
      id: 'desktop-cable',
      name: 'Desktop · Cable · 1× CPU',
      formFactor: 'desktop',
      screen: { width: 1350, height: 940, deviceScaleFactor: 1 },
      throttling: { rttMs: 40, downloadKbps: 10240, uploadKbps: 10240, cpuSlowdownMultiplier: 1 },
    },
    {
      ...mobile,
      id: 'tablet-fast-4g',
      name: 'Tablet · Fast 4G · 2× CPU',
      screen: { width: 768, height: 1024, deviceScaleFactor: 2 },
      throttling: { rttMs: 70, downloadKbps: 9000, uploadKbps: 1500, cpuSlowdownMultiplier: 2 },
    },
    {
      ...mobile,
      id: 'slow-3g-stress',
      name: 'Slow 3G stress test · 6× CPU',
      screen: { width: 412, height: 823, deviceScaleFactor: 1.75 },
      throttling: { rttMs: 400, downloadKbps: 400, uploadKbps: 400, cpuSlowdownMultiplier: 6 },
    },
  ],
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const num = (v, label, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label} must be a number between ${min} and ${max}`);
};

export function validateProfile(p) {
  if (!isObj(p)) throw new Error('Profile must be an object');
  if (!ID_RE.test(p.id ?? '')) throw new Error(`Profile id "${p.id}" must be lowercase letters, digits, "-" or "_"`);
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`Profile ${p.id}: name is required`);
  if (!['mobile', 'desktop'].includes(p.formFactor)) throw new Error(`Profile ${p.id}: formFactor must be mobile or desktop`);
  if (!['simulate', 'devtools', 'provided'].includes(p.throttlingMethod)) throw new Error(`Profile ${p.id}: invalid throttlingMethod`);
  num(p.screen?.width, `Profile ${p.id}: width`, 200, 8000);
  num(p.screen?.height, `Profile ${p.id}: height`, 200, 8000);
  num(p.screen?.deviceScaleFactor, `Profile ${p.id}: deviceScaleFactor`, 0.5, 5);
  num(p.throttling?.rttMs, `Profile ${p.id}: rttMs`, 0, 5000);
  num(p.throttling?.downloadKbps, `Profile ${p.id}: downloadKbps`, 1, 10_000_000);
  num(p.throttling?.uploadKbps, `Profile ${p.id}: uploadKbps`, 1, 10_000_000);
  num(p.throttling?.cpuSlowdownMultiplier, `Profile ${p.id}: cpuSlowdownMultiplier`, 1, 20);
  if (!Array.isArray(p.blockedUrlPatterns) || p.blockedUrlPatterns.some((x) => typeof x !== 'string')) throw new Error(`Profile ${p.id}: blockedUrlPatterns must be a list of strings`);
  if (!isObj(p.extraHeaders) || Object.values(p.extraHeaders).some((x) => typeof x !== 'string')) throw new Error(`Profile ${p.id}: extraHeaders must map names to strings`);
  if (!['light', 'dark'].includes(p.colorScheme)) throw new Error(`Profile ${p.id}: colorScheme must be light or dark`);
  if (p.timezone != null && !/^[A-Za-z0-9_+\-/]+$/.test(p.timezone)) throw new Error(`Profile ${p.id}: invalid timezone`);
}

export function validateConfig(cfg) {
  if (!isObj(cfg)) throw new Error('Config must be an object');
  if (typeof cfg.outputDir !== 'string' || !cfg.outputDir.trim()) throw new Error('outputDir is required');
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length) throw new Error('At least one profile is required');
  const ids = new Set();
  for (const p of cfg.profiles) {
    validateProfile(p);
    if (ids.has(p.id)) throw new Error(`Duplicate profile id "${p.id}"`);
    ids.add(p.id);
  }
  for (const [k, group] of Object.entries(cfg.thresholds ?? {})) {
    for (const [f, v] of Object.entries(group)) {
      if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error(`thresholds.${k}.${f} must be a number`);
    }
  }
  for (const [k, v] of Object.entries(cfg.regression ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`regression.${k} must be a non-negative number`);
  }
}

export async function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${CONFIG_PATH}: ${err.message}`);
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  // Profiles are replaced wholesale (never merged with the defaults) so deleting one sticks.
  const cfg = merge({ ...DEFAULT_CONFIG, profiles: undefined }, raw);
  cfg.profiles = (raw.profiles ?? DEFAULT_CONFIG.profiles).map((p) => ({ ...mobile, ...p }));
  validateConfig(cfg);
  return cfg;
}

export async function saveConfig(cfg) {
  validateConfig(cfg);
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n');
  await fs.rename(tmp, CONFIG_PATH);
}

export const resolveOutputDir = (cfg) => path.resolve(ROOT, cfg.outputDir);
