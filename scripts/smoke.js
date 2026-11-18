// End-to-end check: serve a tiny local page, run one real Lighthouse batch against it,
// and verify the outputs. Used by CI on every OS; also runnable locally with `npm run smoke`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readResultsCsv } from '../src/report/csv.js';
import { runBatch } from '../src/runner/batch.js';

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Smoke</title></head><body><h1>Smoke test page</h1></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-smoke-'));

try {
  const config = structuredClone(DEFAULT_CONFIG);
  config.outputDir = outputDir;
  config.probes.throughputUrl = null; // no outbound traffic from CI
  const events = [];
  const { dir, batch, rows } = await runBatch({
    config,
    rawOptions: { urls: [url], profileIds: ['desktop-cable'], runs: 2, cooldownSec: 0 },
    onEvent: (e) => events.push(e.type),
  });

  assert.equal(batch.status, 'completed');
  assert.equal(batch.runs.length, 2);
  for (const r of batch.runs) assert.ok(r.ok, `run failed: ${r.error}`);
  assert.ok(batch.envBefore.verdict.total > 0, 'environment verdict missing');
  assert.deepEqual(events.filter((t) => t === 'run').length, 2);

  const csv = readResultsCsv(await fs.readFile(path.join(dir, 'results.csv'), 'utf8'));
  assert.ok(csv.ok, csv.errors.join(' '));
  assert.equal(rows.filter((r) => r.row_type === 'median').length, 1);
  assert.equal(csv.rows.filter((r) => r.row_type === 'run').length, 2);

  const report = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(report, /Ran under (non-)?ideal conditions/);

  // Self-comparison through the baseline path.
  const second = await runBatch({
    config,
    rawOptions: { urls: [url], profileIds: ['desktop-cable', 'this-machine'], runs: 1, cooldownSec: 0, baselineCsv: await fs.readFile(path.join(dir, 'results.csv'), 'utf8') },
  });
  assert.ok(second.batch.comparison.rows.length > 0, 'comparison produced no rows');
  assert.ok(second.batch.runs.every((r) => r.ok), 'native or desktop run failed');
  assert.ok(second.batch.comparison.currentOnly.some((x) => x.profileId === 'this-machine'), 'native profile missing from results');

  console.log(`smoke ok: ${batch.runs.map((r) => r.metrics.perf_score).join(', ')} · conditions ${batch.overall} · ${os.platform()}`);
} finally {
  server.close();
  await fs.rm(outputDir, { recursive: true, force: true });
}
