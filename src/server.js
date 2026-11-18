import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { zipSync } from 'fflate';
import { CONFIG_PATH, ROOT, loadConfig, resolveOutputDir, saveConfig, validateProfile } from './config.js';
import { collectSnapshot } from './env/collect.js';
import { evaluate } from './env/verdict.js';
import { compareRuns } from './report/compare.js';
import { readResultsCsv } from './report/csv.js';
import { normalizeOptions, runBatch } from './runner/batch.js';
import { profileToChrome, profileToFlags } from './runner/lighthouse.js';
import { BATCH_ID_RE } from './util.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';

const app = express();
app.disable('x-powered-by');

// This server can launch browsers on the machine, so only answer requests addressed to it directly
// (blocks DNS-rebinding) and reject cross-site writes.
app.use((req, res, next) => {
  const hostName = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostName)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  next();
});
app.use(express.json({ limit: '40mb' }));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---- the one active batch -------------------------------------------------
let current = null; // { id, status, events, clients, abort, summary }

function publish(e) {
  current.events.push(e);
  for (const res of current.clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

const idle = () => !current || current.status !== 'running';

// ---- config ---------------------------------------------------------------
app.get('/api/state', wrap(async (req, res) => {
  const config = await loadConfig();
  res.json({
    config,
    configPath: CONFIG_PATH,
    outputDir: resolveOutputDir(config),
    platform: process.platform,
    running: current && current.status === 'running' ? { id: current.id } : null,
  });
}));

app.put('/api/config', wrap(async (req, res) => {
  try { await saveConfig(req.body); } catch (err) { throw new HttpError(400, err.message); }
  res.json({ config: await loadConfig() });
}));

app.post('/api/profile-preview', wrap(async (req, res) => {
  try { validateProfile(req.body); } catch (err) { throw new HttpError(400, err.message); }
  res.json({ lighthouse: profileToFlags(req.body), chrome: profileToChrome(req.body).chromeFlags, timezone: req.body.timezone ?? null });
}));

// ---- environment ----------------------------------------------------------
app.post('/api/env', wrap(async (req, res) => {
  if (!idle()) throw new HttpError(409, 'A batch is running. Measuring now would disturb it.');
  const config = await loadConfig();
  const target = typeof req.body?.host === 'string' && req.body.host ? req.body.host : config.probes.latencyHost ?? 'https://example.com';
  const snapshot = await collectSnapshot({ latencyHost: target, throughputUrl: config.probes.throughputUrl });
  res.json({ snapshot, verdict: evaluate(snapshot, config.thresholds) });
}));

// ---- running --------------------------------------------------------------
app.post('/api/runs', wrap(async (req, res) => {
  if (!idle()) throw new HttpError(409, 'A batch is already running.');
  const config = await loadConfig();
  try { normalizeOptions(req.body, config); } catch (err) { throw new HttpError(400, err.message); }

  const abort = new AbortController();
  current = { id: null, status: 'running', events: [], clients: new Set(), abort };
  const mine = current;
  let onStart;
  const started = new Promise((resolve) => { onStart = resolve; });
  const job = runBatch({
    config,
    rawOptions: req.body,
    signal: abort.signal,
    onEvent: (e) => {
      if (e.type === 'start') { mine.id = e.id; onStart(e.id); }
      publish(e);
    },
  });
  job.then(
    () => { mine.status = 'finished'; for (const c of mine.clients) c.end(); mine.clients.clear(); },
    (err) => {
      mine.status = 'failed';
      publish({ type: 'error', message: err.message });
      for (const c of mine.clients) c.end();
      mine.clients.clear();
    },
  );
  // Rejects here (before "start") when the baseline CSV or setup is invalid.
  const id = await Promise.race([started, job.then(() => null)]).catch((err) => { throw new HttpError(400, err.message); });
  res.status(202).json({ id });
}));

app.get('/api/runs/current/events', (req, res) => {
  if (!current) return res.status(404).json({ error: 'No batch has been started' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const e of current.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (current.status !== 'running') return res.end();
  current.clients.add(res);
  req.on('close', () => current?.clients.delete(res));
});

app.post('/api/runs/current/cancel', (req, res) => {
  if (idle()) return res.status(409).json({ error: 'Nothing is running' });
  current.abort.abort();
  res.json({ ok: true });
});

// ---- finished batches -----------------------------------------------------
async function batchDir(id) {
  if (!BATCH_ID_RE.test(id)) throw new HttpError(400, 'Invalid batch id');
  const config = await loadConfig();
  return path.join(resolveOutputDir(config), id);
}

app.get('/api/batches', wrap(async (req, res) => {
  const root = resolveOutputDir(await loadConfig());
  let names = [];
  try { names = await fs.readdir(root); } catch { /* output folder does not exist yet */ }
  const out = [];
  for (const id of names.filter((n) => BATCH_ID_RE.test(n)).sort().reverse()) {
    try {
      const b = JSON.parse(await fs.readFile(path.join(root, id, 'batch.json'), 'utf8'));
      out.push({
        id,
        startedAt: b.startedAt,
        status: b.status,
        overall: b.overall,
        runs: b.runs.length,
        failed: b.runs.filter((r) => !r.ok).length,
        urls: b.options.urls.length,
        profiles: b.options.profileIds.length,
        os: b.envBefore.snapshot.host.os,
        comparison: b.comparison ? b.comparison.summary : null,
      });
    } catch { /* incomplete or foreign folder */ }
  }
  res.json({ batches: out });
}));

app.get('/api/batches/:id/zip', wrap(async (req, res) => {
  const dir = await batchDir(req.params.id);
  const full = req.query.full === '1';
  const files = {};
  const walk = async (rel) => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) await walk(r);
      else if (full || !(rel === 'runs' && entry.name.endsWith('.json'))) files[r] = new Uint8Array(await fs.readFile(path.join(dir, r)));
    }
  };
  try { await walk(''); } catch { throw new HttpError(404, 'Batch not found'); }
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="lighthouse-${req.params.id}.zip"` });
  res.send(Buffer.from(zipSync(files, { level: 6 })));
}));

// ---- CSV validation and comparison (nothing is stored) ---------------------
app.post('/api/csv/validate', (req, res) => {
  const r = readResultsCsv(req.body?.csv);
  res.json({ ok: r.ok, errors: r.errors, info: r.info });
});

app.post('/api/compare', wrap(async (req, res) => {
  const config = await loadConfig();
  const base = readResultsCsv(req.body?.baselineCsv);
  if (!base.ok) throw new HttpError(400, `Baseline CSV: ${base.errors.join(' ')}`);
  let currentCsv = req.body?.currentCsv;
  if (!currentCsv && req.body?.batchId) {
    try { currentCsv = await fs.readFile(path.join(await batchDir(req.body.batchId), 'results.csv'), 'utf8'); } catch { throw new HttpError(404, 'Batch not found'); }
  }
  const cur = readResultsCsv(currentCsv);
  if (!cur.ok) throw new HttpError(400, `Current CSV: ${cur.errors.join(' ')}`);
  res.json({ baselineInfo: base.info, currentInfo: cur.info, comparison: compareRuns(base.rows, cur.rows, config.regression) });
}));

// ---- static ---------------------------------------------------------------
// Resolved per request so a changed outputDir takes effect without a restart.
app.use('/out', (req, res, next) => {
  loadConfig().then(
    (config) => express.static(resolveOutputDir(config), { dotfiles: 'ignore', index: false })(req, res, next),
    next,
  );
});
app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status ?? (err.type === 'entity.too.large' ? 413 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`Lighthouse Tester: http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
