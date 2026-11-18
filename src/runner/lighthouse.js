import fs from 'node:fs';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { round } from '../util.js';

export const CATEGORY_IDS = ['performance', 'accessibility', 'best-practices', 'seo'];

// Lighthouse constants for converting RTT / throughput into DevTools-style throttling.
const DEVTOOLS_RTT_FACTOR = 3.75;
const DEVTOOLS_THROUGHPUT_FACTOR = 0.9;

/** Lighthouse flags for a profile. Exposed to the UI as the "effective settings" preview. */
export function profileToFlags(profile) {
  if (profile.native) {
    // The machine as it is: real CPU, real network, real browser user agent, no viewport override.
    return {
      formFactor: 'desktop',
      screenEmulation: { disabled: true },
      emulatedUserAgent: false,
      throttlingMethod: 'provided',
      throttling: { rttMs: 0, throughputKbps: 0, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1 },
    };
  }
  const t = profile.throttling;
  const flags = {
    formFactor: profile.formFactor,
    screenEmulation: {
      mobile: profile.formFactor === 'mobile',
      width: profile.screen.width,
      height: profile.screen.height,
      deviceScaleFactor: profile.screen.deviceScaleFactor,
      disabled: false,
    },
    throttlingMethod: profile.throttlingMethod,
    throttling: {
      rttMs: t.rttMs,
      throughputKbps: t.downloadKbps,
      requestLatencyMs: round(t.rttMs * DEVTOOLS_RTT_FACTOR, 1),
      downloadThroughputKbps: round(t.downloadKbps * DEVTOOLS_THROUGHPUT_FACTOR, 1),
      uploadThroughputKbps: t.uploadKbps,
      cpuSlowdownMultiplier: t.cpuSlowdownMultiplier,
    },
    locale: profile.locale || 'en-US',
  };
  if (profile.userAgent) flags.emulatedUserAgent = profile.userAgent;
  if (profile.blockedUrlPatterns.length) flags.blockedUrlPatterns = profile.blockedUrlPatterns;
  const headers = { ...profile.extraHeaders, ...(profile.saveData ? { 'Save-Data': 'on' } : {}) };
  if (Object.keys(headers).length) flags.extraHeaders = headers;
  return flags;
}

/** Chrome launch options for the parts of a profile that Lighthouse has no setting for. */
export function profileToChrome(profile) {
  const flags = ['--headless=new', '--disable-extensions', '--no-first-run'];
  // Headless Chrome defaults to an 800×600 window, which renders a cramped desktop layout.
  if (profile.native) flags.push('--window-size=1350,940');
  // Containers and CI runners (often root, no user namespaces) cannot start Chrome's sandbox.
  if (process.platform === 'linux' && (process.env.CI || fs.existsSync('/.dockerenv') || process.getuid?.() === 0)) {
    flags.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  if (profile.native) return { chromeFlags: flags, envVars: undefined };
  if (profile.colorScheme === 'dark') flags.push('--blink-settings=preferredColorScheme=1');
  if (profile.reducedMotion) flags.push('--force-prefers-reduced-motion');
  const envVars = profile.timezone ? { ...process.env, TZ: profile.timezone } : undefined;
  return { chromeFlags: flags, envVars };
}

export async function launchChrome(profile) {
  const { chromeFlags, envVars } = profileToChrome(profile);
  return chromeLauncher.launch({ chromeFlags, envVars, logLevel: 'silent' });
}

/** Run Lighthouse once against an already-running Chrome. Returns { lhr, html }. */
export async function runLighthouse({ chrome, url, profile, categories, disableStorageReset = false }) {
  const flags = {
    port: chrome.port,
    output: ['json', 'html'],
    logLevel: 'error',
    onlyCategories: categories,
    disableStorageReset,
    ...profileToFlags(profile),
  };
  const result = await lighthouse(url, flags);
  if (!result) throw new Error('Lighthouse returned no result');
  const [json, html] = result.report;
  return { lhr: JSON.parse(json), html };
}

const score = (lhr, id) => {
  const s = lhr.categories?.[id]?.score;
  return s == null ? null : Math.round(s * 100);
};
const metric = (lhr, id, digits = 0) => round(lhr.audits?.[id]?.numericValue, digits);

export function extractMetrics(lhr) {
  const chromeMatch = /(?:Headless)?Chrome\/([\d.]+)/.exec(lhr.environment?.hostUserAgent ?? '');
  return {
    perf_score: score(lhr, 'performance'),
    a11y_score: score(lhr, 'accessibility'),
    best_practices_score: score(lhr, 'best-practices'),
    seo_score: score(lhr, 'seo'),
    lcp_ms: metric(lhr, 'largest-contentful-paint'),
    cls: metric(lhr, 'cumulative-layout-shift', 3),
    tbt_ms: metric(lhr, 'total-blocking-time'),
    fcp_ms: metric(lhr, 'first-contentful-paint'),
    speed_index_ms: metric(lhr, 'speed-index'),
    transfer_kb: round((lhr.audits?.['total-byte-weight']?.numericValue ?? NaN) / 1024, 0),
    requests: lhr.audits?.['network-requests']?.details?.items?.length ?? null,
    benchmark_index: round(lhr.environment?.benchmarkIndex, 0),
    chrome_version: chromeMatch?.[1] ?? '',
    lighthouse_version: lhr.lighthouseVersion ?? '',
    run_warnings: lhr.runWarnings?.length ?? 0,
  };
}
