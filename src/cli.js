#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { collectSnapshot } from './env/collect.js';
import { evaluate } from './env/verdict.js';
import { runBatch } from './runner/batch.js';
import { readResultsCsv } from './report/csv.js';
import { compareRuns } from './report/compare.js';

const USAGE = `Tidewatch CLI

  node src/cli.js env [--host <url>]
  node src/cli.js run --url <url> [--url <url> ...] [--profile <id> ...] [--runs N] [--cooldown S]
                      [--categories performance,accessibility] [--cache cold|warm] [--warmup] [--baseline results.csv]
  node src/cli.js compare --baseline <csv> --current <csv>
  node src/cli.js profiles

Start the web UI with: npm start`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', multiple: true },
    profile: { type: 'string', multiple: true },
    runs: { type: 'string' },
    cooldown: { type: 'string' },
    categories: { type: 'string' },
    cache: { type: 'string' },
    warmup: { type: 'boolean' },
    baseline: { type: 'string' },
    current: { type: 'string' },
    host: { type: 'string' },
  },
});

const [command] = positionals;
const config = await loadConfig();
const ICON = { Ideal: '✓', Warning: '!', Poor: '✗', 'Not assessed': '·' };

try {
  if (command === 'env') {
    const snap = await collectSnapshot({ latencyHost: values.host ?? config.probes.latencyHost ?? 'https://example.com', throughputUrl: config.probes.throughputUrl });
    const v = evaluate(snap, config.thresholds);
    console.log(`Verdict: ${v.overall} (${v.assessed} of ${v.total} checks assessed)\n`);
    for (const c of v.checks) console.log(`${ICON[c.status]} ${c.status.padEnd(13)} ${c.label.padEnd(22)} ${c.display}`);
  } else if (command === 'profiles') {
    for (const p of config.profiles) console.log(`${p.id.padEnd(22)} ${p.name}`);
  } else if (command === 'run') {
    const baselineCsv = values.baseline ? await fs.readFile(values.baseline, 'utf8') : null;
    const ac = new AbortController();
    process.once('SIGINT', () => { console.log('\nStopping after the current run…'); ac.abort(); });
    const { dir, batch } = await runBatch({
      config,
      signal: ac.signal,
      rawOptions: {
        urls: values.url,
        profileIds: values.profile ?? [config.defaultProfileId],
        runs: values.runs,
        cooldownSec: values.cooldown,
        categories: values.categories?.split(','),
        cache: values.cache,
        warmup: values.warmup,
        baselineCsv,
        baselineName: values.baseline,
      },
      onEvent: (e) => {
        if (e.type === 'phase') console.log(`… ${e.phase}`);
        if (e.type === 'run') console.log(`${e.ok ? '✓' : '✗'} [${e.done}/${e.total}] ${e.url} · ${e.profileId} · run ${e.run}: ${e.ok ? `score ${e.score}` : e.error} · conditions ${e.envVerdict}${e.nonIdeal.length ? ` (${e.nonIdeal.join('; ')})` : ''}`);
      },
    });
    console.log(`\nConditions: ${batch.overall}. Output: ${dir}`);
    if (batch.comparison) {
      const s = batch.comparison.summary;
      console.log(`Baseline comparison: ${s.regressed} regressed, ${s.improved} improved, ${s.within} within threshold${batch.comparison.comparable ? '' : ' (environments differ, may be unreliable)'}`);
    }
  } else if (command === 'compare') {
    if (!values.baseline || !values.current) throw new Error('compare needs --baseline and --current');
    const [b, c] = await Promise.all([values.baseline, values.current].map(async (f) => readResultsCsv(await fs.readFile(f, 'utf8'))));
    for (const [name, r] of [['baseline', b], ['current', c]]) if (!r.ok) throw new Error(`${name}: ${r.errors.join(' ')}`);
    const cmp = compareRuns(b.rows, c.rows, config.regression);
    for (const x of cmp.comparability) console.log(`${x.status.padEnd(8)} ${x.text}`);
    console.log();
    for (const r of cmp.rows) console.log(`${r.status.padEnd(16)} ${r.url} · ${r.profileId} · ${r.metric}: ${r.baseline} → ${r.current}`);
  } else {
    console.log(USAGE);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
