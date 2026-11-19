const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tone = (label) => `t-${String(label).replace(/ /g, '-')}`;
const pill = (label) => `<span class="pill ${tone(label)}">${esc(label)}</span>`;
const secs = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 6000 : 2800);
}

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const main = $('#main');
const S = {
  state: null,
  config: null,
  env: null,
  envBusy: false,
  urls: store.get('urls', ['https://example.com/']),
  selected: new Set(store.get('profiles', [])),
  opts: store.get('opts', { categories: ['performance'], runs: 5, cooldownSec: 10, cache: 'cold', warmup: false }),
  baseline: null, // { name, csv, info } — kept in memory only, never persisted
  progress: null,
  es: null,
  batches: null,
  editing: null,
  editingOrig: null,
  cmp: { batchId: '', currentCsv: null, currentName: null, result: null, busy: false },
};

// ---------------------------------------------------------------- shared bits

async function readBaselineFile(file) {
  const csv = await file.text();
  const v = await api('/api/csv/validate', { method: 'POST', body: { csv } });
  if (!v.ok) { toast(`${file.name}: ${v.errors.join(' ')}`, true); return false; }
  S.baseline = { name: file.name, csv, info: v.info };
  return true;
}

function baselineInfoHtml() {
  const b = S.baseline;
  if (!b) return '<p class="muted small">No baseline loaded.</p>';
  const i = b.info;
  return `<div class="col" style="gap:6px">
    <span class="mono" style="font-weight:600;word-break:break-all">${esc(b.name)}</span>
    <span class="muted small">${esc(i.os)} · ${esc(i.arch)} · recorded ${i.timestamp ? esc(when(i.timestamp)) : 'unknown'} · ${i.runCount} runs · ${i.urls} URL${i.urls === 1 ? '' : 's'} × ${i.profiles} profile${i.profiles === 1 ? '' : 's'}</span>
  </div>`;
}

function wireDrop(root, onFile) {
  const drop = $('.drop', root);
  if (!drop) return;
  const input = $('input[type=file]', drop);
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]); });
}

const dropHtml = (id, title, hint) => `<label class="drop" for="${id}"><strong>${esc(title)}</strong><span class="muted small">${esc(hint)}</span><input id="${id}" type="file" accept=".csv,text/csv"></label>`;

function comparisonHtml(c, heading) {
  const rows = c.rows.map((r) => {
    const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
    const fmt = (v) => (r.key === 'perf_score' || r.key === 'cls' ? v : secs(v));
    const change = r.key === 'perf_score' || r.key === 'cls' ? `${sign(r.delta)}${Math.abs(r.delta)}` : `${sign(r.pct)}${Math.abs(r.pct ?? 0)}%`;
    return `<tr><td><span class="mono small">${esc(r.url)}</span><div class="muted small">${esc(r.profileName)} · ${esc(r.metric)}</div></td>
      <td class="mono">${fmt(r.baseline)}</td><td class="mono">${fmt(r.current)}</td><td class="mono"><b>${change}</b></td>
      <td>${pill(r.status)}<div class="muted small">${esc(r.note)}${r.belowFloor ? ` · below the ${r.floorMs} ms noise floor` : ''}${r.unreliable && r.status === 'Regressed' ? ', treat as unreliable' : ''}</div></td></tr>`;
  }).join('');
  const unmatched = [...c.baselineOnly.map((x) => `In baseline only: ${x.url} · ${x.profileId}`), ...c.currentOnly.map((x) => `In current results only: ${x.url} · ${x.profileId}`)];
  return `<div class="notice ${c.comparable ? '' : 'warn'}" style="flex-direction:column">
      <strong>${esc(heading ?? (c.comparable ? 'Environments match' : 'Comparison may be unreliable'))}</strong>
      ${c.comparability.map((x) => `<div class="row" style="gap:10px">${pill(x.status)}<span>${esc(x.text)}</span></div>`).join('')}
      ${c.comparable ? '' : '<span class="small">Regressions below may come from the machine, not the site.</span>'}
    </div>
    <p class="muted small">${c.summary.regressed} regressed · ${c.summary.improved} improved · ${c.summary.within} within threshold</p>
    ${unmatched.length ? `<p class="muted small">${unmatched.map(esc).join('<br>')}</p>` : ''}
    ${rows ? `<div class="scroll"><table><thead><tr><th>URL · profile · metric</th><th>Baseline</th><th>Current</th><th>Change</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No URL and profile pair appears in both files.</p>'}`;
}

// ---------------------------------------------------------------- run page

function estimate() {
  const o = S.opts;
  const urls = S.urls.length;
  const profiles = [...S.selected].filter((id) => S.config.profiles.some((p) => p.id === id)).length;
  const extra = o.cache === 'warm' || o.warmup ? urls * profiles : 0;
  const total = urls * profiles * o.runs;
  const minutes = Math.max(1, Math.round(((total + extra) * (20 + o.cooldownSec)) / 60));
  return { urls, profiles, total, minutes, extra };
}

function envCardHtml() {
  const head = `<div class="row" style="justify-content:space-between">
    <div class="row" style="gap:14px"><h2 id="envh">Environment check</h2>${S.env ? `<span class="verdict ${tone(S.env.verdict.overall)}">${esc(S.env.verdict.overall)}</span><span class="muted">${S.env.verdict.assessed} of ${S.env.verdict.total} checks assessed · ${S.env.verdict.counts.Warning} warning${S.env.verdict.counts.Warning === 1 ? '' : 's'} · ${S.env.verdict.counts.Poor} poor</span>` : ''}</div>
    <div class="row">${S.env ? `<span class="muted small">Checked ${esc(new Date(S.env.snapshot.takenAt).toLocaleTimeString())}</span>` : ''}<button class="btn" data-act="env" ${S.envBusy || S.progress?.status === 'running' ? 'disabled' : ''}>${S.envBusy ? 'Checking…' : 'Re-check'}</button></div></div>`;
  if (!S.env) return `${head}<p class="muted">${S.envBusy ? 'Measuring CPU, memory, power and network. This takes about 6 seconds.' : 'No measurement yet.'}</p>`;
  const h = S.env.snapshot.host;
  const card = (c) => `<div class="check"><div class="top"><span>${esc(c.label)}</span>${pill(c.status)}</div><div class="val">${esc(c.display)}</div><div class="muted small">${esc(c.rule)}</div></div>`;
  const group = (name, title) => {
    const list = S.env.verdict.checks.filter((c) => (c.group ?? 'machine') === name);
    return list.length ? `<h3 class="muted">${title}</h3><div class="checks">${list.map(card).join('')}</div>` : '';
  };
  return `${head}
    <div class="row mono small muted" style="gap:8px 20px"><span>${esc(h.os)} ${esc(h.osVersion)} · ${esc(h.arch)}</span><span>${esc(h.cpuModel)}</span><span>${h.cpuCores} cores</span><span>${h.ramGb} GB RAM</span>${h.environmentType !== 'host' ? `<span>${esc(h.environmentType)}</span>` : ''}</div>
    ${group('machine', 'Machine')}${group('browser', 'Browser and network path')}
    <p class="muted small">Thresholds are editable under Settings. A check the OS cannot provide shows as Not assessed and never counts as a failure.</p>`;
}

function urlListHtml() {
  const rows = S.urls.map((u, i) => `<div class="urlrow"><span>${esc(u)}</span><button class="btn icon" data-act="rm-url" data-i="${i}" aria-label="Remove ${esc(u)}"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="#566070" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`).join('');
  return rows || '<p class="muted small">No URLs yet.</p>';
}

function summaryHtml() {
  const e = estimate();
  return `<span class="mono">${e.urls} URL${e.urls === 1 ? '' : 's'} × ${e.profiles} profile${e.profiles === 1 ? '' : 's'} × ${S.opts.runs} runs = ${e.total} runs</span><span class="muted">About ${e.minutes} min${e.extra ? ` (includes ${e.extra} warm-up run${e.extra === 1 ? '' : 's'})` : ''}</span>`;
}

function progressHtml() {
  const p = S.progress;
  if (!p) return '';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const running = p.status === 'running';
  const log = p.log.map((l) => `<div class="${l.bad ? 'bad' : ''}">${esc(l.text)}</div>`).join('');
  let footer = '';
  if (p.status === 'failed') footer = `<div class="notice err">${esc(p.error)}</div>`;
  else if (!running) {
    footer = `<div class="notice ${p.overall === 'Ideal' ? '' : 'warn'}"><div class="col"><strong>${p.status === 'cancelled' ? 'Cancelled. Partial results were saved.' : 'Batch finished.'} Conditions: ${esc(p.overall)}${p.failed ? ` · ${p.failed} run${p.failed === 1 ? '' : 's'} failed` : ''}</strong>
      <span class="row"><a class="btn primary" href="/out/${esc(p.id)}/report.html" target="_blank" rel="noopener">Open report</a><a class="btn" href="/out/${esc(p.id)}/results.csv" download>Download CSV</a><a class="btn" href="/api/batches/${esc(p.id)}/zip" download>Download ZIP</a></span></div></div>`;
  }
  return `<section class="card" aria-live="polite"><div class="row" style="justify-content:space-between"><h2>${running ? 'Running…' : 'Last batch'}</h2>${running ? '<button class="btn danger" data-act="cancel">Cancel after current run</button>' : ''}</div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
    <p class="muted small">${p.done} of ${p.total} runs${p.phase && running ? ` · ${esc(p.phase)}` : ''}</p>
    <div class="log" id="log">${log || '<span class="muted">Waiting for the first run…</span>'}</div>${footer}</section>`;
}

function renderProgress() {
  const area = $('#progressArea');
  if (!area) return;
  const prevScroll = $('#log');
  const stick = !prevScroll || prevScroll.scrollTop + prevScroll.clientHeight >= prevScroll.scrollHeight - 8;
  area.innerHTML = progressHtml();
  const log = $('#log');
  if (log && stick) log.scrollTop = log.scrollHeight;
  const start = $('#startBtn');
  if (start) start.disabled = S.progress?.status === 'running';
}

function applyEvent(e) {
  if (e.type === 'start') S.progress = { status: 'running', id: e.id, total: e.total, done: 0, phase: '', log: [] };
  const p = S.progress;
  if (!p) return;
  if (e.type === 'phase') p.phase = e.phase;
  if (e.type === 'note') p.log.push({ text: `! ${e.message}` });
  if (e.type === 'env') p.log.push({ text: `Environment before the batch: ${e.verdict}` });
  if (e.type === 'run') {
    p.done = e.done;
    const flags = e.nonIdeal.length ? ` (${e.nonIdeal.join('; ')})` : '';
    p.log.push({ bad: !e.ok, text: `${e.ok ? '✓' : '✗'} ${e.url} · ${e.profileId} · run ${e.run}: ${e.ok ? `score ${e.score ?? '–'}` : e.error} · conditions ${e.envVerdict}${flags}` });
  }
  if (e.type === 'done') { Object.assign(p, { status: e.status, overall: e.overall, failed: e.failed }); S.batches = null; }
  if (e.type === 'error') { p.status = 'failed'; p.error = e.message; }
  renderProgress();
  if (e.type === 'done' || e.type === 'error') { const b = $('[data-act=env]'); if (b) b.disabled = false; }
}

function connectEvents() {
  S.es?.close();
  const es = new EventSource('/api/runs/current/events');
  S.es = es;
  es.onmessage = (m) => applyEvent(JSON.parse(m.data));
  es.onerror = () => { es.close(); if (S.es === es) S.es = null; };
}

async function checkEnv() {
  S.envBusy = true;
  S.env = null;
  $('#envArea').innerHTML = envCardHtml();
  try {
    S.env = await api('/api/env', { method: 'POST', body: { host: S.urls[0] } });
  } catch (err) { toast(err.message, true); }
  S.envBusy = false;
  const area = $('#envArea');
  if (area) area.innerHTML = envCardHtml();
}

async function startRun() {
  const o = S.opts;
  const body = {
    urls: S.urls,
    profileIds: [...S.selected].filter((id) => S.config.profiles.some((p) => p.id === id)),
    categories: o.categories,
    runs: o.runs,
    cooldownSec: o.cooldownSec,
    cache: o.cache,
    warmup: o.warmup,
    headless: o.headless !== false,
    baselineCsv: S.baseline?.csv ?? null,
    baselineName: S.baseline?.name ?? null,
  };
  try {
    await api('/api/runs', { method: 'POST', body });
  } catch (err) { toast(err.message, true); return; }
  S.progress = { status: 'running', id: null, total: estimate().total, done: 0, phase: 'Starting', log: [] };
  renderProgress();
  connectEvents();
  $('#progressArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pageRun() {
  const cats = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['best-practices', 'Best practices'], ['seo', 'SEO']];
  const profiles = S.config.profiles.map((p) => `<label class="choice block"><input type="checkbox" data-profile="${esc(p.id)}" ${S.selected.has(p.id) ? 'checked' : ''}><span style="flex:1">${esc(p.name)}</span>${p.id === S.config.defaultProfileId ? '<span class="pill t-Ideal">Default</span>' : ''}<a href="#/profiles" class="small">${p.native ? 'View' : 'Edit'}</a></label>`).join('');
  main.innerHTML = `
    <header class="head"><div><h1>New batch run</h1><p>Check this machine, choose targets and profiles, then run.</p></div>
      <button class="btn primary" id="startBtn" data-act="start" style="height:46px" ${S.progress?.status === 'running' ? 'disabled' : ''}>Start run</button></header>
    <div class="notice"><span>Runs are never blocked by conditions. A snapshot is taken before and after the batch and before every run, and printed in the report, so a result from a noisy machine is always visibly marked.</span></div>
    <div id="progressArea"></div>
    <section class="card" id="envArea" aria-labelledby="envh"></section>
    <div class="split">
      <section class="card" aria-labelledby="urlh"><h2 id="urlh">Target URLs</h2>
        <div class="list" id="urlList"></div>
        <div class="row"><div class="field" style="flex:1 1 220px"><label for="newUrl" style="position:absolute;left:-9999px">Add URLs</label><input id="newUrl" class="mono" type="url" placeholder="https://"></div>
          <button class="btn" data-act="add-url">Add</button></div>
        <p class="muted small">Public http(s) URLs only. Paste several, separated by spaces or new lines.</p></section>
      <section class="card" aria-labelledby="cfgh"><h2 id="cfgh">Run configuration</h2>
        <fieldset><legend>Environment profiles</legend>${profiles}</fieldset>
        <fieldset><legend>Categories</legend><div class="row">${cats.map(([id, label]) => `<label class="choice"><input type="checkbox" data-cat="${id}" ${S.opts.categories.includes(id) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>
        <div class="row" style="align-items:flex-start">
          <div class="field" style="flex:1 1 140px"><label for="runs">Runs per URL</label><input id="runs" type="number" min="1" max="25" class="mono" data-opt="runs" value="${S.opts.runs}"><span class="hint">Report uses the median</span></div>
          <div class="field" style="flex:1 1 140px"><label for="cool">Cooldown between runs (s)</label><input id="cool" type="number" min="0" max="300" class="mono" data-opt="cooldownSec" value="${S.opts.cooldownSec}"><span class="hint">Runs are always serial</span></div></div>
        <fieldset><legend>Cache</legend><div class="row">
          <label class="choice"><input type="radio" name="cache" data-opt="cache" value="cold" ${S.opts.cache === 'cold' ? 'checked' : ''}>Cold</label>
          <label class="choice"><input type="radio" name="cache" data-opt="cache" value="warm" ${S.opts.cache === 'warm' ? 'checked' : ''}>Warm (one discarded warm-up per URL)</label>
          <label class="choice"><input type="checkbox" data-opt="warmup" ${S.opts.warmup ? 'checked' : ''}>Discard a first run</label></div></fieldset>
        <fieldset><legend>Browser</legend><div class="row">
          <label class="choice"><input type="radio" name="mode" data-opt="headless" value="true" ${S.opts.headless !== false ? 'checked' : ''}>Headless</label>
          <label class="choice"><input type="radio" name="mode" data-opt="headless" value="false" ${S.opts.headless === false ? 'checked' : ''}>Headed (visible window)</label></div>
          <span class="muted small">Every run uses a fresh profile with extensions disabled. Headed uses the real window and display path, so leave the machine alone while it runs. Don't mix headless and headed results in one baseline.</span></fieldset>
        <div class="field"><span class="legend">Compare against a baseline CSV (optional)</span><div id="baselineArea"></div></div>
        <div class="sum" id="sum"></div></section>
    </div>`;
  renderProgress();
  $('#envArea').innerHTML = envCardHtml();
  $('#urlList').innerHTML = urlListHtml();
  $('#sum').innerHTML = summaryHtml();
  const ba = $('#baselineArea');
  const drawBaseline = () => {
    ba.innerHTML = `${baselineInfoHtml()}<div style="margin-top:10px">${dropHtml('baseFile', 'Drop a baseline CSV here', 'or choose a file. It is read in memory and never stored by the app.')}</div>${S.baseline ? '<button class="btn" data-act="clear-baseline" style="margin-top:8px">Remove baseline</button>' : ''}`;
    wireDrop(ba, async (f) => { if (await readBaselineFile(f)) drawBaseline(); });
  };
  drawBaseline();
  if (!S.env && !S.envBusy && S.progress?.status !== 'running') checkEnv();
}

function addUrls() {
  const input = $('#newUrl');
  const parts = input.value.split(/[\s,]+/).filter(Boolean);
  const bad = parts.filter((u) => { try { return !['http:', 'https:'].includes(new URL(u).protocol); } catch { return true; } });
  if (bad.length) { toast(`Not a valid http(s) URL: ${bad[0]}`, true); return; }
  for (const u of parts) if (!S.urls.includes(u)) S.urls.push(u);
  store.set('urls', S.urls);
  input.value = '';
  $('#urlList').innerHTML = urlListHtml();
  $('#sum').innerHTML = summaryHtml();
}

// ---------------------------------------------------------------- profiles page

const NETWORK_PRESETS = {
  'slow-3g': { label: 'Slow 3G', rttMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'slow-4g': { label: 'Slow 4G', rttMs: 150, downloadKbps: 1638.4, uploadKbps: 675 },
  'fast-4g': { label: 'Fast 4G', rttMs: 70, downloadKbps: 9000, uploadKbps: 1500 },
  cable: { label: 'Cable / Lighthouse desktop', rttMs: 40, downloadKbps: 10240, uploadKbps: 10240 },
};

const presetOf = (t) => Object.entries(NETWORK_PRESETS).find(([, p]) => p.rttMs === t.rttMs && p.downloadKbps === t.downloadKbps && p.uploadKbps === t.uploadKbps)?.[0] ?? 'custom';
const getPath = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = value;
}

function newProfile() {
  return structuredClone({
    id: 'new-profile', name: 'New profile', formFactor: 'mobile', userAgent: null, throttlingMethod: 'simulate', locale: 'en-US', timezone: null,
    colorScheme: 'light', reducedMotion: false, saveData: false, blockedUrlPatterns: [], extraHeaders: {},
    screen: { width: 412, height: 823, deviceScaleFactor: 1.75 }, throttling: { ...NETWORK_PRESETS['slow-4g'], cpuSlowdownMultiplier: 4 },
  });
}

function editorHtml(p) {
  const num = (path, label, extra = '') => `<div class="field" style="flex:1 1 110px"><label for="f-${path}">${label}</label><input id="f-${path}" class="mono" type="number" step="any" data-f="${path}" value="${esc(getPath(p, path))}" ${extra}></div>`;
  const txt = (path, label, ph = '') => `<div class="field" style="flex:1 1 160px"><label for="f-${path}">${label}</label><input id="f-${path}" class="mono" type="text" data-f="${path}" data-null="1" value="${esc(getPath(p, path) ?? '')}" placeholder="${esc(ph)}"></div>`;
  const preset = presetOf(p.throttling);
  const headers = Object.entries(p.extraHeaders).map(([k, v]) => `${k}: ${v}`).join('\n');
  const tm = [['simulate', 'Simulated (default, fast, repeatable)'], ['devtools', 'Applied in the browser (DevTools)'], ['provided', 'None (use the real network)']];
  return `<div class="row" style="justify-content:space-between"><h2>${esc(p.name)}</h2><span class="muted small mono">${esc(S.editingOrig ?? 'unsaved')}</span></div>
    <div class="row" style="align-items:flex-start"><div class="field" style="flex:2 1 220px"><label for="f-name">Profile name</label><input id="f-name" type="text" data-f="name" value="${esc(p.name)}"></div>
      <div class="field" style="flex:1 1 160px"><label for="f-id">Id (used in CSV)</label><input id="f-id" class="mono" type="text" data-f="id" value="${esc(p.id)}" pattern="[a-z0-9][a-z0-9_-]*"></div></div>
    <fieldset><legend>Device</legend>
      <div class="row">${['mobile', 'desktop'].map((v) => `<label class="choice"><input type="radio" name="ff" data-f="formFactor" value="${v}" ${p.formFactor === v ? 'checked' : ''}>${v[0].toUpperCase() + v.slice(1)}</label>`).join('')}</div>
      <div class="row">${num('screen.width', 'Width')}${num('screen.height', 'Height')}${num('screen.deviceScaleFactor', 'Pixel ratio')}</div>
      ${txt('userAgent', 'User agent (blank = Lighthouse default)', 'Lighthouse default')}</fieldset>
    <fieldset><legend>Network</legend>
      <div class="row" style="align-items:flex-end"><div class="field" style="flex:2 1 200px"><label for="f-preset">Preset</label><select id="f-preset" data-preset="1">
        ${Object.entries(NETWORK_PRESETS).map(([k, v]) => `<option value="${k}" ${preset === k ? 'selected' : ''}>${v.label}</option>`).join('')}<option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom</option></select></div>
        ${num('throttling.rttMs', 'RTT (ms)')}${num('throttling.downloadKbps', 'Download (Kbps)')}${num('throttling.uploadKbps', 'Upload (Kbps)')}</div>
      <div class="field"><label for="f-tm">Throttling method</label><select id="f-tm" data-f="throttlingMethod">${tm.map(([v, l]) => `<option value="${v}" ${p.throttlingMethod === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></fieldset>
    <fieldset><legend>CPU slowdown</legend><div class="row" style="flex-wrap:nowrap"><input id="f-cpu" type="range" min="1" max="10" step="0.5" data-f="throttling.cpuSlowdownMultiplier" value="${p.throttling.cpuSlowdownMultiplier}" aria-label="CPU slowdown multiplier" style="flex:1;min-width:0"><span class="mono" id="cpuVal" style="min-width:42px">${p.throttling.cpuSlowdownMultiplier}×</span></div>
      <span class="muted small">Compare the benchmark index recorded in each run to confirm "4×" means the same on different machines.</span></fieldset>
    <fieldset><legend>Browser behaviour</legend>
      <div class="row top">${txt('locale', 'Locale', 'en-US')}${txt('timezone', 'Timezone (IANA, blank = machine)', 'Europe/London')}
        <div class="field" style="flex:1 1 160px"><label for="f-cs">Color scheme</label><select id="f-cs" data-f="colorScheme">${['light', 'dark'].map((v) => `<option ${p.colorScheme === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <div class="row"><label class="choice"><input type="checkbox" data-f="reducedMotion" ${p.reducedMotion ? 'checked' : ''}>Reduced motion</label><label class="choice"><input type="checkbox" data-f="saveData" ${p.saveData ? 'checked' : ''}>Save-Data header</label></div>
      <div class="field"><label for="f-blk">Blocked URL patterns, one per line</label><textarea id="f-blk" class="mono" rows="3" data-f="blockedUrlPatterns" data-kind="lines">${esc(p.blockedUrlPatterns.join('\n'))}</textarea></div>
      <div class="field"><label for="f-hdr">Extra request headers, one "Name: value" per line</label><textarea id="f-hdr" class="mono" rows="2" data-f="extraHeaders" data-kind="headers">${esc(headers)}</textarea></div></fieldset>`;
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const el = $('#preview');
    if (!el || !S.editing) return;
    try {
      const r = await api('/api/profile-preview', { method: 'POST', body: S.editing });
      el.textContent = JSON.stringify({ lighthouse: r.lighthouse, chromeFlags: r.chrome, timezone: r.timezone }, null, 2);
      el.classList.remove('err');
    } catch (err) { el.textContent = err.message; }
  }, 250);
}

function pageProfiles() {
  const list = S.config.profiles.map((p) => `<button class="item ${p.id === S.editingOrig ? 'sel' : ''}" data-act="edit-profile" data-id="${esc(p.id)}"><span class="row" style="justify-content:space-between;flex-wrap:nowrap"><strong>${esc(p.name)}</strong>${p.id === S.config.defaultProfileId ? '<span class="pill t-Ideal">Default</span>' : ''}</span><span class="muted small mono">${p.native ? 'your CPU · your network · no emulation' : `${esc(p.formFactor)} · ${p.screen.width}×${p.screen.height} · ${p.throttling.rttMs} ms · ${p.throttling.cpuSlowdownMultiplier}×`}</span></button>`).join('');
  main.innerHTML = `<header class="head"><div><h1>Environment profiles</h1><p>A profile combines device, network, CPU and browser behaviour. Profiles live in the local config file.</p></div>
    <div class="row"><button class="btn" data-act="import-profiles">Import JSON</button><button class="btn" data-act="export-profiles">Export JSON</button><input id="impFile" type="file" accept=".json,application/json" hidden></div></header>
    <div class="split" style="--w:300px">
      <section class="col" style="flex:1 1 260px;max-width:320px"><h3 class="muted">Saved profiles</h3><div class="list">${list}</div>
        <button class="btn" data-act="new-profile" style="border-style:dashed">+ New profile</button></section>
      <section class="card" style="flex:2 1 460px" id="editor">${S.editing ? '' : '<p class="muted">Pick a profile to edit, or create a new one.</p>'}</section>
      <section class="col" style="flex:1 1 320px"><h3 class="muted">Effective settings</h3><pre class="code" id="preview">Select a profile.</pre>
        <p class="muted small">Timezone, color scheme and reduced motion are applied through Chrome launch settings. Everything else is passed to Lighthouse.</p></section>
    </div>`;
  if (S.editing?.native) {
    $('#editor').innerHTML = `<h2>${esc(S.editing.name)}</h2>
      <div class="notice"><span>Built in and read-only. It measures this machine as it is: its real CPU speed, its real network connection and the browser's own user agent, with no emulation or throttling. Results reflect this hardware, so compare them only against baselines recorded on the same machine.</span></div>
      <div class="row">${S.config.defaultProfileId === S.editing.id ? '<span class="pill t-Ideal">Default profile</span>' : '<button class="btn" data-act="make-default">Make default</button>'}</div>`;
    schedulePreview();
  } else if (S.editing) {
    const isDefault = S.editingOrig && S.editingOrig === S.config.defaultProfileId;
    $('#editor').innerHTML = `${editorHtml(S.editing)}<div class="row"><button class="btn primary" data-act="save-profile">Save profile</button><button class="btn" data-act="dup-profile">Duplicate</button>${S.editingOrig && !isDefault ? '<button class="btn" data-act="make-default">Make default</button>' : ''}<button class="btn danger" data-act="del-profile">Delete</button></div>`;
    schedulePreview();
  }
  const imp = $('#impFile');
  imp.addEventListener('change', async () => {
    try {
      const parsed = JSON.parse(await imp.files[0].text());
      const incoming = Array.isArray(parsed) ? parsed : [parsed];
      const cfg = structuredClone(S.config);
      for (const p of incoming) {
        const i = cfg.profiles.findIndex((x) => x.id === p.id);
        if (i >= 0) cfg.profiles[i] = p; else cfg.profiles.push(p);
      }
      await saveConfig(cfg);
      toast(`Imported ${incoming.length} profile${incoming.length === 1 ? '' : 's'}`);
      pageProfiles();
    } catch (err) { toast(`Import failed: ${err.message}`, true); }
    imp.value = '';
  });
}

async function saveConfig(cfg) {
  const r = await api('/api/config', { method: 'PUT', body: cfg });
  S.config = r.config;
  S.selected = new Set([...S.selected].filter((id) => S.config.profiles.some((p) => p.id === id)));
  store.set('profiles', [...S.selected]);
}

async function saveProfile() {
  const cfg = structuredClone(S.config);
  const i = cfg.profiles.findIndex((p) => p.id === S.editingOrig);
  if (i >= 0) cfg.profiles[i] = S.editing; else cfg.profiles.push(S.editing);
  try {
    await saveConfig(cfg);
    S.editingOrig = S.editing.id;
    toast('Profile saved');
    pageProfiles();
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- reports page

async function pageReports() {
  main.innerHTML = '<header class="head"><div><h1>Reports</h1><p>Every batch is a folder in the output directory. Nothing else is stored.</p></div></header><section class="card" id="rep"><p class="muted">Loading…</p></section>';
  try {
    S.batches ??= (await api('/api/batches')).batches;
  } catch (err) { $('#rep').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; return; }
  const rows = S.batches.map((b) => `<tr><td>${esc(when(b.startedAt))}<div class="muted small mono">${esc(b.id)}</div></td><td>${pill(b.status)}</td><td>${pill(b.overall)}</td>
    <td>${b.runs} runs${b.failed ? `<div class="small" style="color:var(--bad-fg)">${b.failed} failed</div>` : ''}<div class="muted small">${b.urls} URL${b.urls === 1 ? '' : 's'} × ${b.profiles} profile${b.profiles === 1 ? '' : 's'}</div></td>
    <td>${b.comparison ? `${b.comparison.regressed} regressed · ${b.comparison.improved} improved` : '<span class="muted">–</span>'}</td>
    <td><div class="row" style="gap:12px"><a href="/out/${b.id}/report.html" target="_blank" rel="noopener">Report</a><a href="/out/${b.id}/results.csv" download>CSV</a><a href="/api/batches/${b.id}/zip" download>ZIP</a><a href="#/compare" data-act="compare-batch" data-id="${b.id}">Compare</a></div></td></tr>`).join('');
  $('#rep').innerHTML = rows ? `<div class="scroll"><table><thead><tr><th>Started</th><th>Status</th><th>Conditions</th><th>Runs</th><th>Vs baseline</th><th>Files</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">Output folder: <span class="mono">${esc(S.state.outputDir)}</span></p>` : '<p class="muted">No batches yet. Start one from New run.</p>';
}

// ---------------------------------------------------------------- compare page

async function pageCompare() {
  main.innerHTML = `<header class="head"><div><h1>Baseline compare</h1><p>Upload a CSV from an earlier run and compare any batch against it. The app keeps no database; the file is read in memory.</p></div></header>
    <div class="split"><section class="card"><h2>Baseline file</h2><div id="bArea"></div></section>
      <section class="card"><h2>Current results</h2>
        <div class="field"><label for="batchSel">A batch in the output folder</label><select id="batchSel"><option value="">Loading…</option></select></div>
        <div class="field"><span class="legend">…or upload a results CSV</span>${dropHtml('curFile', 'Drop a results CSV here', 'or choose a file')}<span class="muted small" id="curName"></span></div>
        <button class="btn primary" data-act="run-compare">Compare</button></section></div>
    <div id="cmpOut"></div>`;
  const drawB = () => {
    $('#bArea').innerHTML = `${baselineInfoHtml()}<div style="margin-top:12px">${dropHtml('baseFile2', 'Drop a baseline CSV here', 'or choose a file. Never stored by the app.')}</div>`;
    wireDrop($('#bArea'), async (f) => { if (await readBaselineFile(f)) drawB(); });
  };
  drawB();
  wireDrop($('#curFile').closest('.field'), async (f) => {
    const csv = await f.text();
    const v = await api('/api/csv/validate', { method: 'POST', body: { csv } });
    if (!v.ok) return toast(`${f.name}: ${v.errors.join(' ')}`, true);
    S.cmp.currentCsv = csv; S.cmp.currentName = f.name; S.cmp.batchId = '';
    $('#curName').textContent = `Loaded ${f.name}`;
    $('#batchSel').value = '';
  });
  try { S.batches ??= (await api('/api/batches')).batches; } catch (err) { toast(err.message, true); S.batches = []; }
  const sel = $('#batchSel');
  sel.innerHTML = `<option value="">Select a batch…</option>${S.batches.map((b) => `<option value="${b.id}" ${S.cmp.batchId === b.id ? 'selected' : ''}>${esc(when(b.startedAt))} · ${b.runs} runs · ${esc(b.overall)}</option>`).join('')}`;
  sel.addEventListener('change', () => { S.cmp.batchId = sel.value; if (sel.value) { S.cmp.currentCsv = null; $('#curName').textContent = ''; } });
  if (S.cmp.result) $('#cmpOut').innerHTML = `<section class="card">${S.cmp.result}</section>`;
}

async function runCompare() {
  if (!S.baseline) return toast('Load a baseline CSV first.', true);
  if (!S.cmp.batchId && !S.cmp.currentCsv) return toast('Choose a batch or upload the current results.', true);
  try {
    const r = await api('/api/compare', { method: 'POST', body: { baselineCsv: S.baseline.csv, batchId: S.cmp.batchId || undefined, currentCsv: S.cmp.currentCsv || undefined } });
    S.cmp.result = `<h2>Current vs ${esc(S.baseline.name)}</h2>${comparisonHtml(r.comparison)}`;
    $('#cmpOut').innerHTML = `<section class="card">${S.cmp.result}</section>`;
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- settings page

const THRESHOLD_LABELS = {
  cpuLoadPct: ['CPU load (%)', 'above'], freeMemGb: ['Free memory (GB)', 'below'], thermalSpeedLimitPct: ['CPU speed limit under thermal throttling (%)', 'below'],
  thermalTempC: ['CPU temperature (°C), where speed limit is unavailable', 'above'], latencyMs: ['Latency (ms)', 'above'], jitterMs: ['Jitter (ms)', 'above'],
  packetLossPct: ['Connection failures (%)', 'above'], otherBrowserCpuPct: ['Other Chrome processes: CPU (%)', 'above'], downloadMbps: ['Download throughput (Mbps)', 'below'], wifiSignalDbm: ['Wi-Fi signal (dBm)', 'below'],
};
const REGRESSION_LABELS = { scorePoints: 'Score drop (points)', lcpPct: 'LCP increase (%)', tbtPct: 'TBT increase (%)', clsAbs: 'CLS increase (absolute)', fcpPct: 'FCP increase (%)', siPct: 'Speed Index increase (%)', minChangeMs: 'Noise floor: ignore time changes under (ms)' };

function pageSettings() {
  const c = S.config;
  const n = (path, label, hint = '') => `<div class="field" style="flex:1 1 150px"><label for="s-${path}">${label}</label><input id="s-${path}" class="mono" type="number" step="any" data-s="${path}" value="${esc(getPath(c, path))}">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const t = (path, label, hint) => `<div class="field" style="flex:1 1 280px"><label for="s-${path}">${label}</label><input id="s-${path}" class="mono" type="text" data-s="${path}" data-null="1" value="${esc(getPath(c, path) ?? '')}"><span class="hint">${hint}</span></div>`;
  const cats = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['best-practices', 'Best practices'], ['seo', 'SEO']];
  const th = Object.entries(THRESHOLD_LABELS).map(([k, [label, dir]]) => `<div class="row" style="align-items:flex-end"><strong style="flex:2 1 240px;font-size:14px;font-weight:500">${label}</strong>${n(`thresholds.${k}.warn`, `Warning ${dir}`)}${n(`thresholds.${k}.poor`, `Poor ${dir}`)}</div>`).join('');
  main.innerHTML = `<header class="head"><div><h1>Settings &amp; thresholds</h1><p>Stored in <span class="mono">${esc(S.state.configPath)}</span>. Edit it by hand or here.</p></div><button class="btn primary" data-act="save-settings">Save settings</button></header>
    <section class="card"><h2>Output</h2>${t('outputDir', 'Output folder', 'Relative paths resolve from the project folder. Each batch gets its own subfolder.')}</section>
    <section class="card"><h2>Run defaults</h2><div class="row">${n('defaults.runs', 'Runs per URL')}${n('defaults.cooldownSec', 'Cooldown (s)')}</div>
      <div class="row"><label class="choice"><input type="radio" name="dc" data-sv="defaults.cache" value="cold" ${c.defaults.cache === 'cold' ? 'checked' : ''}>Cold cache</label><label class="choice"><input type="radio" name="dc" data-sv="defaults.cache" value="warm" ${c.defaults.cache === 'warm' ? 'checked' : ''}>Warm cache</label>
      <label class="choice"><input type="checkbox" data-sc="defaults.headless" ${c.defaults.headless !== false ? 'checked' : ''}>Headless by default</label>
      ${cats.map(([id, l]) => `<label class="choice"><input type="checkbox" data-dcat="${id}" ${c.defaults.categories.includes(id) ? 'checked' : ''}>${l}</label>`).join('')}</div></section>
    <section class="card"><h2>Network probes</h2><div class="row">${t('probes.latencyHost', 'Latency host', 'Blank = the first target URL. Probed by opening TCP connections.')}${t('probes.throughputUrl', 'Throughput download URL', 'Blank disables the check. The default downloads 10 MB from a public speed-test endpoint.')}</div></section>
    <section class="card"><h2>Environment thresholds</h2>
      <div class="row" style="align-items:flex-end"><label class="choice"><input type="checkbox" data-sc="thresholds.power.requireAC" ${c.thresholds.power.requireAC ? 'checked' : ''}>Warn when running on battery</label>${n('thresholds.power.warnPercent', 'Battery warning below (%)')}${n('thresholds.power.poorPercent', 'Battery poor below (%)')}</div>${th}</section>
    <section class="card"><h2>Regression thresholds</h2><p class="muted small">A metric is flagged Regressed when it gets worse by at least this much against the baseline.</p><div class="row">${Object.entries(REGRESSION_LABELS).map(([k, l]) => n(`regression.${k}`, l)).join('')}</div></section>`;
}

function saveSettings() {
  const cfg = structuredClone(S.config);
  for (const el of main.querySelectorAll('[data-s]')) {
    const v = el.type === 'number' ? Number(el.value) : (el.value.trim() || null);
    setPath(cfg, el.dataset.s, el.dataset.null ? v : v);
  }
  for (const el of main.querySelectorAll('[data-sc]')) setPath(cfg, el.dataset.sc, el.checked);
  const cache = main.querySelector('[data-sv]:checked');
  if (cache) cfg.defaults.cache = cache.value;
  cfg.defaults.categories = [...main.querySelectorAll('[data-dcat]:checked')].map((el) => el.dataset.dcat);
  if (!cfg.defaults.categories.length) return toast('Pick at least one default category.', true);
  saveConfig(cfg).then(() => { toast('Settings saved'); S.opts = { ...S.opts }; }).catch((err) => toast(err.message, true));
}

// ---------------------------------------------------------------- events

main.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'env') checkEnv();
  else if (act === 'start') startRun();
  else if (act === 'cancel') { try { await api('/api/runs/current/cancel', { method: 'POST' }); toast('Stopping after the current run…'); } catch (err) { toast(err.message, true); } }
  else if (act === 'add-url') addUrls();
  else if (act === 'rm-url') { S.urls.splice(Number(el.dataset.i), 1); store.set('urls', S.urls); $('#urlList').innerHTML = urlListHtml(); $('#sum').innerHTML = summaryHtml(); }
  else if (act === 'clear-baseline') { S.baseline = null; pageRun(); }
  else if (act === 'edit-profile') { S.editingOrig = el.dataset.id; S.editing = structuredClone(S.config.profiles.find((p) => p.id === el.dataset.id)); pageProfiles(); }
  else if (act === 'new-profile') { S.editingOrig = null; S.editing = newProfile(); pageProfiles(); }
  else if (act === 'dup-profile') {
    const copy = structuredClone(S.editing);
    let id = `${copy.id}-copy`;
    for (let i = 2; S.config.profiles.some((p) => p.id === id); i++) id = `${copy.id}-copy-${i}`;
    Object.assign(copy, { id, name: `${copy.name} (copy)` });
    S.editingOrig = null; S.editing = copy; pageProfiles();
  }
  else if (act === 'save-profile') saveProfile();
  else if (act === 'make-default') {
    const cfg = structuredClone(S.config);
    cfg.defaultProfileId = S.editingOrig;
    try { await saveConfig(cfg); toast('Default profile updated'); pageProfiles(); } catch (err) { toast(err.message, true); }
  }
  else if (act === 'del-profile') {
    if (!S.editingOrig) { S.editing = null; return pageProfiles(); }
    if (S.config.profiles.length < 2) return toast('Keep at least one profile.', true);
    if (!confirm(`Delete "${S.editing.name}"?`)) return;
    const cfg = structuredClone(S.config);
    cfg.profiles = cfg.profiles.filter((p) => p.id !== S.editingOrig);
    try { await saveConfig(cfg); S.editing = null; S.editingOrig = null; pageProfiles(); } catch (err) { toast(err.message, true); }
  }
  else if (act === 'import-profiles') $('#impFile').click();
  else if (act === 'export-profiles') download('tidewatch-profiles.json', JSON.stringify(S.config.profiles, null, 2), 'application/json');
  else if (act === 'compare-batch') { S.cmp.batchId = el.dataset.id; S.cmp.currentCsv = null; S.cmp.result = null; }
  else if (act === 'run-compare') runCompare();
  else if (act === 'save-settings') saveSettings();
});

function onFieldChange(e) {
  const t = e.target;
  if (t.dataset.profile) {
    if (t.checked) S.selected.add(t.dataset.profile); else S.selected.delete(t.dataset.profile);
    store.set('profiles', [...S.selected]);
    $('#sum').innerHTML = summaryHtml();
  } else if (t.dataset.cat) {
    S.opts.categories = [...main.querySelectorAll('[data-cat]:checked')].map((x) => x.dataset.cat);
    store.set('opts', S.opts);
  } else if (t.dataset.opt) {
    const k = t.dataset.opt;
    S.opts[k] = k === 'headless' ? t.value === 'true' : t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    store.set('opts', S.opts);
    $('#sum').innerHTML = summaryHtml();
  } else if (t.dataset.preset) {
    if (t.value !== 'custom') { Object.assign(S.editing.throttling, { rttMs: NETWORK_PRESETS[t.value].rttMs, downloadKbps: NETWORK_PRESETS[t.value].downloadKbps, uploadKbps: NETWORK_PRESETS[t.value].uploadKbps }); pageProfiles(); }
  } else if (t.dataset.f && S.editing) {
    const kind = t.dataset.kind;
    let v;
    if (kind === 'lines') v = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if (kind === 'headers') v = Object.fromEntries(t.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; }));
    else if (t.type === 'checkbox') v = t.checked;
    else if (t.type === 'number' || t.type === 'range') v = Number(t.value);
    else v = t.dataset.null ? (t.value.trim() || null) : t.value;
    setPath(S.editing, t.dataset.f, v);
    if (t.id === 'f-cpu') $('#cpuVal').textContent = `${t.value}×`;
    if (t.dataset.f.startsWith('throttling.') && t.type === 'number') { const sel = $('#f-preset'); if (sel) sel.value = presetOf(S.editing.throttling); }
    schedulePreview();
  }
}
main.addEventListener('input', (e) => { if (!e.target.dataset.preset) onFieldChange(e); });
main.addEventListener('change', onFieldChange);
main.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'newUrl') { e.preventDefault(); addUrls(); } });

// ---------------------------------------------------------------- routing

const ROUTES = { run: pageRun, profiles: pageProfiles, reports: pageReports, compare: pageCompare, settings: pageSettings };

function route() {
  const name = (location.hash.replace(/^#\//, '') || 'run').split('?')[0];
  const page = ROUTES[name] ?? pageRun;
  for (const a of document.querySelectorAll('.nav a[data-route]')) {
    const on = a.dataset.route === (ROUTES[name] ? name : 'run');
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  page();
}

async function boot() {
  try {
    S.state = await api('/api/state');
  } catch (err) {
    main.innerHTML = `<div class="notice err">Could not reach the server: ${esc(err.message)}</div>`;
    return;
  }
  S.config = S.state.config;
  S.selected = new Set([...S.selected].filter((id) => S.config.profiles.some((p) => p.id === id)));
  if (!S.selected.size) S.selected = new Set([S.config.defaultProfileId]);
  S.opts = { ...S.config.defaults, ...S.opts, categories: S.opts.categories?.length ? S.opts.categories : S.config.defaults.categories };
  $('#navFoot').textContent = `${S.state.platform} · ${S.state.outputDir}`;
  if (S.state.running) { S.progress = { status: 'running', id: S.state.running.id, total: 0, done: 0, phase: '', log: [] }; connectEvents(); }
  window.addEventListener('hashchange', route);
  route();
}

boot();
