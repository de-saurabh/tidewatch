import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, parseCsv, readResultsCsv, toCsv } from '../src/report/csv.js';
import { evaluate, worstVerdict } from '../src/env/verdict.js';
import { compareRuns } from '../src/report/compare.js';
import { DEFAULT_CONFIG, NATIVE_PROFILE_ID, normalizeConfig, validateConfig } from '../src/config.js';
import { profileToFlags } from '../src/runner/lighthouse.js';
import { median } from '../src/util.js';

const T = DEFAULT_CONFIG.thresholds;
const snap = (raw, extra = {}) => ({ light: false, raw: { power: { hasBattery: false, onAc: true }, powerSaver: false, cpuLoadPct: 5, freeMemGb: 8, totalMemGb: 16, thermal: { speedLimitPct: 100 }, net: { latencyMs: 20, jitterMs: 2, lossPct: 0 }, downloadMbps: 100, wifi: null, ...raw }, topProcesses: [], ...extra });

test('csv round-trips quotes, commas and newlines', () => {
  const rows = [{ url: 'https://a.test/?q=1,2', error: 'said "no"\nthen left' }];
  const { rows: back } = parseCsv(toCsv(rows, ['url', 'error']));
  assert.deepEqual(back, rows);
});

test('verdict: unavailable checks are not failures', () => {
  const v = evaluate(snap({ powerSaver: null, wifi: null }), T);
  assert.equal(v.overall, 'Ideal');
  assert.ok(v.counts['Not assessed'] >= 2);
});

test('verdict: thresholds drive Warning and Poor, worst wins', () => {
  assert.equal(evaluate(snap({ cpuLoadPct: 30 }), T).overall, 'Acceptable');
  assert.equal(evaluate(snap({ cpuLoadPct: 30, freeMemGb: 1 }), T).overall, 'Poor');
  assert.equal(evaluate(snap({ power: { hasBattery: true, onAc: false, percent: 80 } }), T).overall, 'Acceptable');
  assert.equal(worstVerdict('Ideal', 'Poor', 'Acceptable'), 'Poor');
});

test('light snapshots skip throughput and wifi', () => {
  const v = evaluate(snap({}, { light: true }), T);
  assert.ok(!v.checks.some((c) => c.id === 'download' || c.id === 'wifi'));
});

const row = (o) => ({ schema_version: 1, row_type: 'median', url: 'https://a.test/', profile_id: 'p', profile_name: 'P', os: 'macOS', arch: 'arm64', cpu_model: 'M1', chrome_version: '150.0', lighthouse_version: '13.6.0', form_factor: 'mobile', throttling_method: 'simulate', rtt_ms: 150, download_kbps: 1638.4, cpu_slowdown: 4, env_verdict_start: 'Ideal', env_verdict_batch_before: 'Ideal', env_verdict_batch_after: 'Ideal', runs_ok: 5, runs_degraded: 0, perf_score: 80, lcp_ms: 2000, cls: 0.01, tbt_ms: 100, fcp_ms: 1000, speed_index_ms: 2500, ...o });

test('compare: thresholds classify regressions and improvements', () => {
  const c = compareRuns([row({})], [row({ perf_score: 70, lcp_ms: 1700, tbt_ms: 105, cls: 0.05 })], DEFAULT_CONFIG.regression);
  const by = Object.fromEntries(c.rows.map((r) => [r.key, r.status]));
  assert.equal(by.perf_score, 'Regressed');
  assert.equal(by.lcp_ms, 'Improved');
  assert.equal(by.tbt_ms, 'Within threshold');
  assert.equal(by.cls, 'Regressed');
  assert.ok(c.comparable);
});

test('compare: flags differing environments and unmatched pairs', () => {
  const c = compareRuns([row({ os: 'Windows', env_verdict_start: 'Ideal' }), row({ url: 'https://gone.test/' })], [row({ env_verdict_start: 'Poor', runs_degraded: 2 })], DEFAULT_CONFIG.regression);
  assert.equal(c.comparable, false);
  assert.equal(c.baselineOnly.length, 1);
  assert.ok(c.rows.every((r) => r.unreliable));
});

test('readResultsCsv rejects foreign files and wrong schema versions', () => {
  assert.equal(readResultsCsv('a,b\n1,2').ok, false);
  const good = toCsv([row({})], COLUMNS);
  assert.equal(readResultsCsv(good).ok, true);
  assert.equal(readResultsCsv(good.replace(/^1,/m, '1,').replace('\r\n1,', '\r\n2,')).ok, false);
});

test('default config validates; bad profile is rejected', () => {
  validateConfig(structuredClone(DEFAULT_CONFIG));
  const bad = structuredClone(DEFAULT_CONFIG);
  bad.profiles[1].throttling.cpuSlowdownMultiplier = 0;
  assert.throws(() => validateConfig(bad));
});

test('median handles odd, even and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('native profile is always first, canonical and the fallback default', () => {
  const messy = structuredClone(DEFAULT_CONFIG);
  messy.profiles = messy.profiles.filter((p) => !p.native); // user removed it
  messy.profiles.push({ ...DEFAULT_CONFIG.profiles[0], id: 'sneaky', native: true }); // forged copy
  messy.defaultProfileId = 'deleted-profile';
  const n = normalizeConfig(messy);
  assert.equal(n.profiles[0].id, NATIVE_PROFILE_ID);
  assert.ok(!n.profiles.some((p) => p.id === 'sneaky'));
  assert.equal(n.defaultProfileId, NATIVE_PROFILE_ID);
  validateConfig(n);
});

test('native profile applies no emulation or throttling; others are ordered fast to slow', () => {
  const f = profileToFlags(DEFAULT_CONFIG.profiles[0]);
  assert.equal(f.throttlingMethod, 'provided');
  assert.equal(f.screenEmulation.disabled, true);
  assert.equal(f.throttling.cpuSlowdownMultiplier, 1);
  const rest = DEFAULT_CONFIG.profiles.slice(1);
  const speed = (p) => p.throttling.cpuSlowdownMultiplier * 1e6 + p.throttling.rttMs;
  assert.deepEqual(rest.map(speed), [...rest.map(speed)].sort((a, b) => a - b));
});

// ---- browser checks -------------------------------------------------------

import { classifyChannel, detectPackaging, judgeArch, parseElfMachine, parseFileArchs, parsePeMachine, parsePlutilKeys, parseRegistryNames, parseScutilProxy, parseVersion, summarizeBrowserProcesses } from '../src/env/browser.js';

test('browser channel is read from the build, not from a folder called dev', () => {
  assert.equal(classifyChannel('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome 157.0.8103.79'), 'stable');
  assert.equal(classifyChannel('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'), 'canary');
  assert.equal(classifyChannel('/opt/google/chrome-beta/chrome', 'Google Chrome 130.0.1.2 beta'), 'beta');
  assert.equal(classifyChannel('/opt/google/chrome-unstable/chrome'), 'dev');
  assert.equal(classifyChannel('/home/dev/bin/chrome'), 'stable');
  assert.equal(classifyChannel('/usr/bin/chromium', 'Chromium 120.0.1.2'), 'chromium');
  assert.equal(classifyChannel('/x/chrome', 'Google Chrome for Testing 130.0.1.2'), 'chrome-for-testing');
  assert.equal(parseVersion('Google Chrome 157.0.8103.79 '), '157.0.8103.79');
  assert.equal(detectPackaging('/snap/chromium/current/usr/lib/chromium-browser/chrome'), 'snap');
});

test('binary architecture parsers read real file headers', () => {
  const universal = 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]';
  assert.deepEqual(parseFileArchs(universal).sort(), ['arm64', 'x64']);
  const elf = Buffer.alloc(64); elf.write('\x7fELF', 0, 'latin1'); elf.writeUInt16LE(0xb7, 18);
  assert.equal(parseElfMachine(elf), 'arm64');
  const pe = Buffer.alloc(256); pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\0\0', 0x80, 'latin1'); pe.writeUInt16LE(0x8664, 0x84);
  assert.equal(parsePeMachine(pe), 'x64');
  assert.equal(parsePeMachine(Buffer.alloc(8)), null);
});

test('architecture mismatch is graded by how bad the translation is', () => {
  assert.equal(judgeArch({ hardware: 'arm64', binArchs: ['arm64', 'x64'] }).status, 'Ideal');
  assert.equal(judgeArch({ hardware: 'arm64', binArchs: ['x64'], platform: 'darwin' }).status, 'Poor');
  assert.equal(judgeArch({ hardware: 'arm64', binArchs: ['x64'], platform: 'win32' }).status, 'Warning');
  assert.equal(judgeArch({ hardware: 'arm64', binArchs: ['arm64', 'x64'], nodeTranslated: true }).status, 'Warning');
  assert.equal(judgeArch({ hardware: null, binArchs: [] }).status, 'Not assessed');
});

test('policy, proxy and process parsers', () => {
  assert.deepEqual(parsePlutilKeys('{\n  "ExtensionInstallForcelist" => [\n    0 => "x"\n  ]\n  "HomepageLocation" => "https://a"\n}'), ['ExtensionInstallForcelist', 'HomepageLocation']);
  const reg = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\n    ProxyMode    REG_SZ    direct\n\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\n    1    REG_SZ    abc';
  assert.deepEqual(parseRegistryNames(reg).sort(), ['1', 'ExtensionInstallForcelist', 'ProxyMode']);
  assert.equal(parseScutilProxy('HTTPEnable : 1\nHTTPSEnable : 0'), true);
  assert.equal(parseScutilProxy('HTTPEnable : 0'), false);
  const s = summarizeBrowserProcesses([{ name: 'Google Chrome', cpu: 5, memRss: 2048 }, { name: 'Google Chrome Helper', cpu: 7.4, memRss: 1024 }, { name: 'node', cpu: 90, memRss: 100 }]);
  assert.deepEqual(s, { count: 2, cpuPct: 12, memMb: 3 });
});

test('browser checks feed the verdict and never fail when unavailable', () => {
  const browser = { found: true, version: '157.0.1.2', channel: 'stable', packaging: null, binArchs: ['arm64'], hardwareArch: 'arm64', nodeTranslated: false, policies: [] };
  const ok = evaluate(snap({ browser, otherBrowsers: { count: 3, cpuPct: 2, memMb: 900 }, proxyVpn: { proxies: [], vpn: false } }), T);
  assert.equal(ok.overall, 'Ideal');
  assert.equal(ok.checks.find((c) => c.id === 'browser').group, 'browser');
  const bad = evaluate(snap({ browser: { ...browser, channel: 'canary', binArchs: ['x64'], policies: ['ExtensionInstallForcelist'] }, otherBrowsers: { count: 9, cpuPct: 55, memMb: 4000 }, proxyVpn: { proxies: ['system'], vpn: true } }), T);
  const by = Object.fromEntries(bad.checks.map((c) => [c.id, c.status]));
  assert.equal(by.browser, 'Warning');
  assert.equal(by.browserArch, 'Poor');
  assert.equal(by.browserPolicies, 'Warning');
  assert.equal(by.otherBrowsers, 'Poor');
  assert.equal(by.proxyVpn, 'Warning');
  assert.equal(evaluate(snap({ browser: { found: false } }), T).checks.find((c) => c.id === 'browser').status, 'Poor');
  const light = evaluate(snap({}, { light: true }), T);
  assert.ok(!light.checks.some((c) => c.group === 'browser'));
});

// ---- noise floor ----------------------------------------------------------

test('noise floor: tiny absolute changes are not regressions, however big the percentage', () => {
  const r = { ...DEFAULT_CONFIG.regression };
  const c = compareRuns([row({ tbt_ms: 1, lcp_ms: 213, fcp_ms: 1000 })], [row({ tbt_ms: 0, lcp_ms: 236, fcp_ms: 1300 })], r);
  const by = Object.fromEntries(c.rows.map((x) => [x.key, x]));
  assert.equal(by.tbt_ms.status, 'Within threshold');
  assert.equal(by.tbt_ms.belowFloor, true);
  assert.equal(by.lcp_ms.status, 'Within threshold'); // +10.8% but only 23 ms
  assert.equal(by.lcp_ms.belowFloor, true);
  assert.equal(by.fcp_ms.status, 'Regressed'); // +30% and 300 ms
  assert.equal(by.fcp_ms.belowFloor, false);
  const strict = compareRuns([row({ lcp_ms: 213 })], [row({ lcp_ms: 236 })], { ...r, minChangeMs: 0 });
  assert.equal(strict.rows.find((x) => x.key === 'lcp_ms').status, 'Regressed');
});

test('browser mode and build differences are flagged, and old baselines are not blamed', () => {
  const base = row({ browser_mode: 'headless', browser_channel: 'stable', browser_arch: 'arm64+x64' });
  const c1 = compareRuns([base], [row({ browser_mode: 'headed', browser_channel: 'stable', browser_arch: 'arm64+x64' })], DEFAULT_CONFIG.regression);
  assert.ok(c1.comparability.some((x) => x.status === 'Differs' && /mode/i.test(x.text)));
  const c2 = compareRuns([row({})], [row({ browser_mode: 'headless', browser_channel: 'stable', browser_arch: 'arm64' })], DEFAULT_CONFIG.regression);
  assert.ok(!c2.comparability.some((x) => /build/i.test(x.text)), 'a baseline without browser info is not compared');
  assert.ok(c2.comparability.every((x) => !/mode/i.test(x.text) || x.status === 'Same'), 'blank mode means headless');
});

// ---- clean-slate inspection against a stand-in DevTools endpoint ---------

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inspectBrowser } from '../src/runner/lighthouse.js';

async function withFakeBrowser(targets, userAgent, fn) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') res.end(JSON.stringify({ Browser: userAgent.includes('Headless') ? 'HeadlessChrome/150.0.0.0' : 'Chrome/150.0.0.0', 'User-Agent': userAgent }));
    else if (req.url === '/json/list') res.end(JSON.stringify(targets));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port); } finally { server.close(); }
}

test('inspectBrowser reports extensions, headless mode and the profile location', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse.'));
  const chrome = (port, dir) => ({ port, process: { spawnargs: ['chrome', `--user-data-dir=${dir}`] } });
  const clean = await withFakeBrowser([{ type: 'page', url: 'about:blank' }], 'Mozilla/5.0 HeadlessChrome/150.0.0.0', async (port) => inspectBrowser(chrome(port, profileDir)));
  assert.deepEqual({ ...clean, userAgent: undefined }, { userAgent: undefined, headless: true, extensionTargets: 0, freshProfile: true });
  const dirty = await withFakeBrowser(
    [{ type: 'page', url: 'about:blank' }, { type: 'service_worker', url: 'chrome-extension://abcdef/background.js' }],
    'Mozilla/5.0 Chrome/150.0.0.0',
    async (port) => inspectBrowser(chrome(port, '/Users/someone/Library/Application Support/Google/Chrome')),
  );
  assert.equal(dirty.extensionTargets, 1);
  assert.equal(dirty.headless, false);
  assert.equal(dirty.freshProfile, false);
  await fs.rm(profileDir, { recursive: true, force: true });
});

test('inspectBrowser says "unknown" rather than "clean" when the endpoint is unreachable', async () => {
  const r = await inspectBrowser({ port: 1, process: { spawnargs: [] } });
  assert.equal(r.extensionTargets, null);
  assert.equal(r.headless, null);
  assert.equal(r.freshProfile, null);
});
