import fs from 'node:fs/promises';
import path from 'node:path';
import { collectSnapshot } from '../env/collect.js';
import { evaluate, worstVerdict } from '../env/verdict.js';
import { resolveOutputDir } from '../config.js';
import { compareRuns } from '../report/compare.js';
import { SCHEMA_VERSION, readResultsCsv, toCsv } from '../report/csv.js';
import { renderReportHtml } from '../report/html.js';
import { CATEGORY_IDS, extractMetrics, launchChrome, runLighthouse } from './lighthouse.js';
import { BATCH_ID_RE, batchIdNow, median, round, sleep, slug, stddev } from '../util.js';

const MAX_URLS = 200;
const MAX_RUNS = 25;

export function normalizeOptions(raw, config) {
  const d = config.defaults;
  const urls = [...new Set((raw.urls ?? []).map((u) => String(u).trim()).filter(Boolean))];
  if (!urls.length) throw new Error('Add at least one URL.');
  if (urls.length > MAX_URLS) throw new Error(`At most ${MAX_URLS} URLs per batch.`);
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error(`Not a valid URL: ${u}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Only http(s) URLs are supported: ${u}`);
  }
  const known = new Map(config.profiles.map((p) => [p.id, p]));
  const profileIds = [...new Set(raw.profileIds ?? [])];
  if (!profileIds.length) throw new Error('Select at least one profile.');
  for (const id of profileIds) if (!known.has(id)) throw new Error(`Unknown profile: ${id}`);
  const categories = (raw.categories?.length ? raw.categories : d.categories).filter((c) => CATEGORY_IDS.includes(c));
  if (!categories.length) throw new Error('Select at least one category.');
  const int = (v, fallback, min, max, label) => {
    const n = v == null ? fallback : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
    return n;
  };
  const cache = raw.cache ?? d.cache;
  if (!['cold', 'warm'].includes(cache)) throw new Error('Cache must be cold or warm.');
  return {
    urls,
    profileIds,
    categories,
    runs: int(raw.runs, d.runs, 1, MAX_RUNS, 'Runs per URL'),
    cooldownSec: int(raw.cooldownSec, d.cooldownSec, 0, 300, 'Cooldown'),
    cache,
    warmup: Boolean(raw.warmup ?? d.warmup),
    baselineCsv: typeof raw.baselineCsv === 'string' && raw.baselineCsv.trim() ? raw.baselineCsv : null,
    baselineName: typeof raw.baselineName === 'string' ? raw.baselineName.slice(0, 200) : null,
  };
}

function abortableSleep(ms, signal) {
  return signal?.aborted ? Promise.resolve() : Promise.race([
    sleep(ms),
    new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })),
  ]);
}

const nonIdeal = (verdict) => verdict.checks.filter((c) => c.status === 'Warning' || c.status === 'Poor');

function envColumns(rec) {
  const raw = rec.raw;
  const thermal = rec.checks.find((c) => c.id === 'thermal');
  return {
    on_ac: raw.power?.onAc ?? '',
    battery_pct: raw.power?.percent ?? '',
    power_saver: raw.powerSaver ?? '',
    cpu_load_pct: raw.cpuLoadPct,
    free_mem_gb: raw.freeMemGb,
    thermal: thermal?.status === 'Not assessed' ? '' : thermal?.display ?? '',
    latency_ms: raw.net?.latencyMs,
    jitter_ms: raw.net?.jitterMs,
    packet_loss_pct: raw.net?.lossPct,
  };
}

/** Flatten a finished batch into CSV rows: one per run, one median row per URL and profile. */
export function buildRows(batch) {
  const before = batch.envBefore;
  const after = batch.envAfter;
  const host = before.snapshot.host;
  const common = {
    schema_version: SCHEMA_VERSION,
    batch_id: batch.id,
    env_verdict_batch_before: before.verdict.overall,
    env_verdict_batch_after: after?.verdict.overall ?? '',
    download_mbps_before: before.snapshot.raw.downloadMbps,
    download_mbps_after: after?.snapshot.raw.downloadMbps ?? '',
    os: host.os,
    os_version: host.osVersion,
    arch: host.arch,
    cpu_model: host.cpuModel,
    cpu_cores: host.cpuCores,
    ram_gb: host.ramGb,
    cache_mode: batch.options.cache,
  };
  const profiles = new Map(batch.profiles.map((p) => [p.id, p]));
  const shape = (p) => ({
    profile_name: p.name,
    form_factor: p.formFactor,
    throttling_method: p.throttlingMethod,
    rtt_ms: p.throttling.rttMs,
    download_kbps: p.throttling.downloadKbps,
    cpu_slowdown: p.throttling.cpuSlowdownMultiplier,
  });

  const rows = [];
  for (const url of batch.options.urls) {
    for (const profileId of batch.options.profileIds) {
      const runs = batch.runs.filter((r) => r.url === url && r.profileId === profileId);
      if (!runs.length) continue;
      const profile = profiles.get(profileId);
      const okRuns = runs.filter((r) => r.ok);
      const sorted = [...okRuns].sort((a, b) => (a.metrics.perf_score ?? -1) - (b.metrics.perf_score ?? -1));
      const medianRun = sorted.length ? sorted[(sorted.length - 1) >> 1] : null;
      for (const r of runs) {
        rows.push({
          ...common,
          ...shape(profile),
          timestamp: r.startedAt,
          row_type: 'run',
          url,
          profile_id: profileId,
          run: r.run,
          is_median_run: r === medianRun,
          error: r.error ?? '',
          ...(r.ok ? r.metrics : {}),
          env_verdict_start: r.envStart.overall,
          ...envColumns(r.envStart),
        });
      }
      const med = (key) => median(okRuns.map((r) => r.metrics[key]));
      const lcps = okRuns.map((r) => r.metrics.lcp_ms).filter(Number.isFinite);
      const first = okRuns[0]?.metrics ?? {};
      rows.push({
        ...common,
        ...shape(profile),
        timestamp: runs[0].startedAt,
        row_type: 'median',
        url,
        profile_id: profileId,
        perf_score: round(med('perf_score')),
        a11y_score: round(med('a11y_score')),
        best_practices_score: round(med('best_practices_score')),
        seo_score: round(med('seo_score')),
        lcp_ms: round(med('lcp_ms')),
        cls: round(med('cls'), 3),
        tbt_ms: round(med('tbt_ms')),
        fcp_ms: round(med('fcp_ms')),
        speed_index_ms: round(med('speed_index_ms')),
        transfer_kb: round(med('transfer_kb')),
        requests: round(med('requests')),
        benchmark_index: round(med('benchmark_index')),
        chrome_version: first.chrome_version ?? '',
        lighthouse_version: first.lighthouse_version ?? '',
        run_warnings: okRuns.reduce((a, r) => a + (r.metrics.run_warnings ?? 0), 0),
        runs_ok: okRuns.length,
        runs_degraded: runs.filter((r) => r.envStart.overall !== 'Ideal').length,
        perf_score_stddev: round(stddev(okRuns.map((r) => r.metrics.perf_score)), 1),
        lcp_min_ms: lcps.length ? Math.min(...lcps) : null,
        lcp_max_ms: lcps.length ? Math.max(...lcps) : null,
        env_verdict_start: worstVerdict(...runs.map((r) => r.envStart.overall)),
      });
    }
  }
  return rows;
}

export async function runBatch({ config, rawOptions, onEvent = () => {}, signal }) {
  const options = normalizeOptions(rawOptions, config);
  const profiles = options.profileIds.map((id) => config.profiles.find((p) => p.id === id));
  const outRoot = resolveOutputDir(config);
  await fs.mkdir(outRoot, { recursive: true });

  let id = batchIdNow();
  for (let n = 2; await fs.stat(path.join(outRoot, id)).then(() => true, () => false); n++) id = `${batchIdNow()}-${n}`;
  if (!BATCH_ID_RE.test(id)) throw new Error('Could not allocate a batch id');
  const dir = path.join(outRoot, id);
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });

  let baseline = null;
  if (options.baselineCsv) {
    baseline = readResultsCsv(options.baselineCsv);
    if (!baseline.ok) throw new Error(`Baseline CSV rejected: ${baseline.errors.join(' ')}`);
  }

  const total = options.urls.length * profiles.length * options.runs;
  const probeOpts = { latencyHost: config.probes.latencyHost || options.urls[0], throughputUrl: config.probes.throughputUrl };
  const startedAt = new Date();
  const batch = {
    schemaVersion: SCHEMA_VERSION,
    id,
    status: 'running',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    options: { ...options, baselineCsv: undefined },
    profiles,
    thresholds: config.thresholds,
    envBefore: null,
    envAfter: null,
    runs: [],
    comparison: null,
  };

  const snap = async (light) => {
    const snapshot = await collectSnapshot({ light, ...probeOpts });
    return { snapshot, verdict: evaluate(snapshot, config.thresholds) };
  };

  onEvent({ type: 'start', id, total });
  onEvent({ type: 'phase', phase: 'Checking the environment' });
  batch.envBefore = await snap(false);
  onEvent({ type: 'env', which: 'before', verdict: batch.envBefore.verdict.overall });

  let done = 0;
  const cancelled = () => signal?.aborted;

  outer: for (const url of options.urls) {
    for (const profile of profiles) {
      const warmCache = options.cache === 'warm';
      let sharedChrome = null;
      try {
        const plan = [];
        if (warmCache || options.warmup) plan.push({ discard: true });
        for (let run = 1; run <= options.runs; run++) plan.push({ run });
        for (const step of plan) {
          if (cancelled()) break outer;
          const label = step.discard ? 'warm-up' : `run ${step.run}/${options.runs}`;
          onEvent({ type: 'phase', phase: `${url} · ${profile.name} · ${label}` });
          // Measure just before launching Chrome, so the snapshot is what this run actually started under.
          const envLight = await snap(true);
          const record = {
            url,
            profileId: profile.id,
            run: step.run ?? 0,
            startedAt: new Date().toISOString(),
            envStart: { overall: envLight.verdict.overall, raw: envLight.snapshot.raw, checks: envLight.verdict.checks },
            ok: false,
          };
          let chrome = null;
          try {
            if (warmCache) sharedChrome ??= await launchChrome(profile);
            chrome = sharedChrome ?? await launchChrome(profile);
            const { lhr, html } = await runLighthouse({
              chrome,
              url,
              profile,
              categories: options.categories,
              disableStorageReset: warmCache && !step.discard,
            });
            if (!step.discard) {
              const base = `${slug(url)}__${profile.id}__run${step.run}`;
              await fs.writeFile(path.join(dir, 'runs', `${base}.report.html`), html);
              await fs.writeFile(path.join(dir, 'runs', `${base}.json`), JSON.stringify(lhr));
              record.ok = true;
              record.metrics = extractMetrics(lhr);
              record.files = { html: `runs/${base}.report.html`, json: `runs/${base}.json` };
              if (lhr.runWarnings?.length) record.warnings = lhr.runWarnings;
            }
          } catch (err) {
            record.error = String(err?.message ?? err).slice(0, 500);
          } finally {
            if (chrome && chrome !== sharedChrome) await chrome.kill();
          }
          if (step.discard) continue;
          batch.runs.push(record);
          done++;
          onEvent({
            type: 'run',
            done,
            total,
            url,
            profileId: profile.id,
            run: record.run,
            ok: record.ok,
            error: record.error,
            score: record.metrics?.perf_score ?? null,
            envVerdict: record.envStart.overall,
            nonIdeal: nonIdeal(envLight.verdict).map((c) => `${c.label}: ${c.display}`),
          });
          if (done < total && options.cooldownSec > 0) await abortableSleep(options.cooldownSec * 1000, signal);
        }
      } finally {
        if (sharedChrome) await sharedChrome.kill();
      }
    }
  }

  onEvent({ type: 'phase', phase: 'Checking the environment again' });
  batch.envAfter = await snap(false);
  batch.status = cancelled() ? 'cancelled' : 'completed';
  batch.finishedAt = new Date().toISOString();
  batch.durationSec = Math.round((Date.parse(batch.finishedAt) - startedAt.getTime()) / 1000);
  batch.overall = worstVerdict(batch.envBefore.verdict.overall, batch.envAfter.verdict.overall, ...batch.runs.map((r) => r.envStart.overall));

  const rows = buildRows(batch);
  if (baseline) {
    batch.comparison = compareRuns(baseline.rows, rows, config.regression);
    batch.comparison.baselineName = options.baselineName;
  }

  await fs.writeFile(path.join(dir, 'results.csv'), toCsv(rows));
  await fs.writeFile(path.join(dir, 'batch.json'), JSON.stringify(batch, null, 2));
  await fs.writeFile(path.join(dir, 'report.html'), renderReportHtml(batch, rows));
  onEvent({ type: 'done', id, status: batch.status, overall: batch.overall, failed: batch.runs.filter((r) => !r.ok).length });
  return { id, dir, batch, rows };
}
