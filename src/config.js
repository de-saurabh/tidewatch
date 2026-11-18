import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.TIDEWATCH_CONFIG
  ? path.resolve(process.env.TIDEWATCH_CONFIG)
  : path.join(ROOT, 'tidewatch.config.json');

const base = {
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

const profile = (id, name, formFactor, screen, [rttMs, downloadKbps, uploadKbps], cpuSlowdownMultiplier) => ({
  ...base,
  id,
  name,
  formFactor,
  screen,
  throttling: { rttMs, downloadKbps, uploadKbps, cpuSlowdownMultiplier },
});

export const NATIVE_PROFILE_ID = 'this-machine';

/**
 * Uses the machine exactly as it is: its real CPU, its real network, a desktop viewport.
 * Built in and read-only: it is always present and is never customised.
 */
export const NATIVE_PROFILE = {
  ...base,
  id: NATIVE_PROFILE_ID,
  name: 'This machine · no emulation or throttling',
  native: true,
  formFactor: 'desktop',
  throttlingMethod: 'provided',
  locale: 'en-US',
  screen: null,
  throttling: null,
};

// Ordered fastest to slowest. Network values follow Lighthouse's own presets where one exists.
const BUILT_IN_PROFILES = [
  profile('desktop-fiber', 'Desktop · Fiber · 1× CPU', 'desktop', { width: 1350, height: 940, deviceScaleFactor: 1 }, [10, 100000, 50000], 1),
  profile('desktop-cable', 'Desktop · Cable · 1× CPU', 'desktop', { width: 1350, height: 940, deviceScaleFactor: 1 }, [40, 10240, 10240], 1),
  profile('tablet-fast-4g', 'Tablet · Fast 4G · 2× CPU', 'mobile', { width: 768, height: 1024, deviceScaleFactor: 2 }, [70, 9000, 1500], 2),
  profile('phone-high-end-fast-4g', 'High-end phone · Fast 4G · 2× CPU', 'mobile', { width: 412, height: 915, deviceScaleFactor: 2.625 }, [70, 9000, 1500], 2),
  profile('moto-g-slow-4g', 'Mid-range phone (Moto G Power) · Slow 4G · 4× CPU', 'mobile', { width: 412, height: 823, deviceScaleFactor: 1.75 }, [150, 1638.4, 675], 4),
  profile('slow-3g-stress', 'Low-end phone · Slow 3G · 6× CPU', 'mobile', { width: 412, height: 823, deviceScaleFactor: 1.75 }, [400, 400, 400], 6),
];

export const DEFAULT_CONFIG = {
  outputDir: 'output',
  defaultProfileId: NATIVE_PROFILE_ID,
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
  profiles: [NATIVE_PROFILE, ...BUILT_IN_PROFILES],
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(baseObj, over) {
  if (!isObj(baseObj) || !isObj(over)) return over === undefined ? baseObj : over;
  const out = { ...baseObj };
  for (const [k, v] of Object.entries(over)) out[k] = k in baseObj && isObj(baseObj[k]) ? merge(baseObj[k], v) : v;
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
  if (p.native) return; // nothing to customise
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

/** The native profile is always first, always canonical, and the default falls back to it. */
export function normalizeConfig(cfg) {
  const out = { ...cfg };
  out.profiles = [NATIVE_PROFILE, ...(cfg.profiles ?? []).filter((p) => p.id !== NATIVE_PROFILE_ID && !p.native)];
  if (!out.profiles.some((p) => p.id === out.defaultProfileId)) out.defaultProfileId = NATIVE_PROFILE_ID;
  return out;
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
  if (!ids.has(cfg.defaultProfileId)) throw new Error(`defaultProfileId "${cfg.defaultProfileId}" is not a known profile`);
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
  cfg.profiles = (raw.profiles ?? DEFAULT_CONFIG.profiles).map((p) => (p.native ? p : { ...base, ...p }));
  const normalized = normalizeConfig(cfg);
  validateConfig(normalized);
  return normalized;
}

export async function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  validateConfig(normalized);
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n');
  await fs.rename(tmp, CONFIG_PATH);
}

export const resolveOutputDir = (cfg) => path.resolve(ROOT, cfg.outputDir);
