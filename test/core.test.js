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
