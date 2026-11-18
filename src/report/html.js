import { escapeHtml as h } from '../util.js';

const TONE = {
  Ideal: ['#0B6B3A', '#E2F4EA'],
  Acceptable: ['#7A4B00', '#FFF0CF'],
  Warning: ['#7A4B00', '#FFF0CF'],
  Poor: ['#A52019', '#FDE6E3'],
  'Not assessed': ['#4A5463', '#ECEEF2'],
  Regressed: ['#A52019', '#FDE6E3'],
  Improved: ['#0B6B3A', '#E2F4EA'],
  'Within threshold': ['#4A5463', '#ECEEF2'],
  Same: ['#0B6B3A', '#E2F4EA'],
  Differs: ['#7A4B00', '#FFF0CF'],
};

const pill = (label) => {
  const [fg, bg] = TONE[label] ?? TONE['Not assessed'];
  return `<span class="pill" style="color:${fg};background:${bg}">${h(label)}</span>`;
};

const scoreBand = (s) => (s == null ? 'Not assessed' : s >= 90 ? 'Ideal' : s >= 50 ? 'Warning' : 'Poor');
const scoreCell = (s) => {
  const [fg, bg] = TONE[scoreBand(s)];
  return `<span class="score" style="color:${fg};background:${bg}">${s ?? '–'}</span>`;
};
const secs = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const val = (v, unit = '') => (v == null || v === '' ? '–' : `${v}${unit}`);
const when = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#F4F5F7;color:#12161C;font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px;display:flex;flex-direction:column;gap:24px}
h1{margin:0;font-size:28px;letter-spacing:-.01em}h2{margin:0;font-size:18px}
.muted{color:#566070;font-size:14px}.mono{font-family:ui-monospace,"IBM Plex Mono",Menlo,monospace;font-size:13px}
section{background:#fff;border:1px solid #E1E4EA;border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:16px}
.banner{border-width:1px;border-style:solid}
.banner.bad{background:#FFF8E6;border-color:#E8C26A}.banner.good{background:#F0FAF4;border-color:#9AD3B1}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px;white-space:nowrap}
.score{font-family:ui-monospace,Menlo,monospace;font-weight:600;border-radius:6px;padding:3px 8px}
.scroll{overflow-x:auto;border:1px solid #E1E4EA;border-radius:10px;background:#fff}
table{border-collapse:collapse;width:100%;min-width:720px}
th{background:#F8F9FB;font-size:12px;color:#566070;text-align:left;padding:10px 14px;border-bottom:1px solid #E1E4EA}
td{padding:11px 14px;border-bottom:1px solid #F0F2F5;vertical-align:top;font-size:14px}
tr:last-child td{border-bottom:0}tr.median td{background:#F3F6FF}
a{color:#2848D6}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
ul.cmp{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
@media print{body{background:#fff}section{break-inside:avoid}}
`;

function envTable(batch) {
  const b = batch.envBefore.verdict.checks;
  const a = batch.envAfter?.verdict.checks ?? [];
  const rank = { Ideal: 0, 'Not assessed': 0, Warning: 1, Poor: 2 };
  const rows = b.map((c) => {
    const after = a.find((x) => x.id === c.id);
    const worst = after && rank[after.status] > rank[c.status] ? after.status : c.status;
    return `<tr><td>${h(c.label)}</td><td class="mono">${h(c.display)}</td><td class="mono">${h(after?.display ?? '–')}</td><td>${pill(worst)}</td></tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th>Check</th><th>Before the batch</th><th>After the batch</th><th>Worst</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function conditionsBanner(batch) {
  const ok = batch.overall === 'Ideal';
  const all = [...batch.envBefore.verdict.checks, ...(batch.envAfter?.verdict.checks ?? [])];
  const counts = { Poor: 0, Warning: 0 };
  for (const label of new Set(all.filter((c) => c.status === 'Poor' || c.status === 'Warning').map((c) => `${c.id}`))) {
    const worst = all.filter((c) => c.id === label).some((c) => c.status === 'Poor') ? 'Poor' : 'Warning';
    counts[worst]++;
  }
  const degraded = batch.runs.filter((r) => r.envStart.overall !== 'Ideal').length;
  const hogs = [...(batch.envBefore.snapshot.topProcesses ?? []), ...(batch.envAfter?.snapshot.topProcesses ?? [])];
  const hogText = hogs.length ? ` Busiest background processes: ${[...new Set(hogs.map((p) => `${p.name} (${p.cpuPct}%)`))].join(', ')}.` : '';
  if (ok) {
    return `<section class="banner good"><div class="row"><h2>Ran under ideal conditions</h2>${pill('Ideal')}</div>
      <p class="muted" style="margin:0">All assessed checks passed before and after the batch, and every run started under ideal conditions.</p>
      ${envTable(batch)}</section>`;
  }
  return `<section class="banner bad"><div class="row"><h2 style="color:#5C3900">Ran under non-ideal conditions</h2>${pill(batch.overall)}
      ${counts.Poor ? `<span class="pill" style="color:#A52019;background:#FDE6E3">${counts.Poor} poor</span>` : ''}
      ${counts.Warning ? `<span class="pill" style="color:#7A4B00;background:#FFF0CF">${counts.Warning} warning${counts.Warning > 1 ? 's' : ''}</span>` : ''}</div>
      <p style="margin:0;max-width:860px">${degraded} of ${batch.runs.length} runs started in a degraded state and are flagged below.${h(hogText)}
      Treat these scores with caution, and only compare this batch with baselines recorded under similar conditions.</p>
      ${envTable(batch)}
      <p class="muted" style="margin:0">Snapshots are also stored per run, so the CSV records the exact conditions each result was measured in.</p></section>`;
}

function resultsTable(medianRows) {
  const body = medianRows.map((r) => {
    const degraded = r.runs_degraded ?? 0;
    const total = r.runs_ok;
    return `<tr><td class="mono">${h(r.url)}</td><td>${h(r.profile_name)}</td><td>${scoreCell(r.perf_score)}</td>
      <td class="mono">${secs(r.lcp_ms)}</td><td class="mono">${val(r.cls)}</td><td class="mono">${secs(r.tbt_ms)}</td>
      <td class="mono">${secs(r.fcp_ms)}</td><td class="mono">${secs(r.speed_index_ms)}</td>
      <td class="mono muted">${r.lcp_min_ms == null ? '–' : `${secs(r.lcp_min_ms)} – ${secs(r.lcp_max_ms)}`}</td>
      <td>${pill(r.env_verdict_start)}<div class="muted" style="font-size:12px">${h(degraded ? `${degraded} of ${total} runs not ideal` : 'Runs ideal')}</div></td></tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th>URL</th><th>Profile</th><th>Score</th><th>LCP</th><th>CLS</th><th>TBT</th><th>FCP</th><th>SI</th><th>LCP range</th><th>Conditions</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}

function runsTable(batch, rows) {
  const out = [];
  const groups = new Map();
  for (const r of rows.filter((x) => x.row_type === 'run')) {
    const k = `${r.url}\u0000${r.profile_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [, list] of groups) {
    const head = `${list[0].url} · ${list[0].profile_name}`;
    const trs = list.map((r) => {
      const rec = batch.runs.find((x) => x.url === r.url && x.profileId === r.profile_id && x.run === r.run);
      const bad = rec.envStart.checks.filter((c) => c.status === 'Warning' || c.status === 'Poor').map((c) => `${c.label} ${c.display}`);
      const link = rec.files ? `<a href="${h(rec.files.html)}">Open full report</a>` : `<span class="muted">${h(rec.error ?? 'failed')}</span>`;
      return `<tr class="${r.is_median_run ? 'median' : ''}"><td class="mono">Run ${r.run}${r.is_median_run ? ' · median' : ''}</td><td>${rec.ok ? scoreCell(r.perf_score) : pill('Poor')}</td>
        <td class="mono">${secs(r.lcp_ms)}</td><td class="mono">${secs(r.tbt_ms)}</td>
        <td>${pill(r.env_verdict_start)} <span class="muted" style="font-size:12px">${h(bad.join(', '))}</span></td><td>${link}</td></tr>`;
    });
    out.push(`<h3 style="margin:8px 0 0;font-size:15px" class="mono">${h(head)}</h3><div class="scroll"><table><thead><tr><th>Run</th><th>Score</th><th>LCP</th><th>TBT</th><th>Conditions at start</th><th>Lighthouse report</th></tr></thead><tbody>${trs.join('')}</tbody></table></div>`);
  }
  return out.join('');
}

export function comparisonSection(c) {
  const fmt = (r, v) => (r.key === 'perf_score' ? v : r.key === 'cls' ? v : secs(v));
  const rows = c.rows.map((r) => {
    const sign = r.delta > 0 ? '+' : r.delta < 0 ? '−' : '';
    const change = r.key === 'perf_score' || r.key === 'cls' ? `${sign}${Math.abs(r.delta)}` : `${r.pct > 0 ? '+' : r.pct < 0 ? '−' : ''}${Math.abs(r.pct ?? 0)}%`;
    return `<tr><td><span class="mono">${h(r.url)}</span><div class="muted" style="font-size:12px">${h(r.profileName)} · ${h(r.metric)}</div></td>
      <td class="mono">${fmt(r, r.baseline)}</td><td class="mono">${fmt(r, r.current)}</td><td class="mono"><b>${change}</b></td>
      <td>${pill(r.status)}<div class="muted" style="font-size:12px">${h(r.note)}${r.unreliable && r.status === 'Regressed' ? ', treat as unreliable' : ''}</div></td></tr>`;
  });
  const notes = c.comparability.map((x) => `<li class="row">${pill(x.status)}<span>${h(x.text)}</span></li>`).join('');
  const unmatched = [...c.baselineOnly.map((x) => `In baseline only: ${x.url} · ${x.profileId}`), ...c.currentOnly.map((x) => `In this batch only: ${x.url} · ${x.profileId}`)];
  return `<section class="banner ${c.comparable ? 'good' : 'bad'}"><div class="row"><h2>${c.comparable ? 'Comparison with baseline' : 'Comparison with baseline: may be unreliable'}</h2></div>
    <p class="muted" style="margin:0">Baseline ${h(c.baselineName || c.baseline.batchId || '')} · recorded ${h(c.baseline.timestamp ? when(c.baseline.timestamp) : 'unknown')} ·
      ${c.summary.regressed} regressed, ${c.summary.improved} improved, ${c.summary.within} within threshold</p>
    <ul class="cmp">${notes}</ul>
    ${unmatched.length ? `<p class="muted" style="margin:0">${unmatched.map(h).join('<br>')}</p>` : ''}
    <div class="scroll"><table><thead><tr><th>URL · profile · metric</th><th>Baseline</th><th>Current</th><th>Change</th><th>Result</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>`;
}

export function renderReportHtml(batch, rows) {
  const medians = rows.filter((r) => r.row_type === 'median');
  const o = batch.options;
  const dur = batch.durationSec == null ? '' : ` · ${Math.max(1, Math.round(batch.durationSec / 60))} min`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lighthouse batch ${h(batch.id)}</title><style>${CSS}</style></head><body><main>
<header><h1>Batch report</h1>
<p class="muted" style="margin:6px 0 0">${h(when(batch.startedAt))} · ${batch.runs.length} runs${dur} · ${o.urls.length} URL${o.urls.length > 1 ? 's' : ''} × ${o.profileIds.length} profile${o.profileIds.length > 1 ? 's' : ''} × ${o.runs} runs · ${h(o.cache)} cache${batch.status === 'cancelled' ? ' · <b>cancelled early</b>' : ''}</p>
<p class="muted" style="margin:4px 0 0">${h(batch.envBefore.snapshot.host.os)} ${h(batch.envBefore.snapshot.host.osVersion)} · ${h(batch.envBefore.snapshot.host.cpuModel)} · ${batch.envBefore.snapshot.host.ramGb} GB · ${h(medians[0]?.chrome_version ? `Chrome ${medians[0].chrome_version}` : '')} · Lighthouse ${h(medians[0]?.lighthouse_version ?? '')}</p>
<p style="margin:10px 0 0"><a href="results.csv" download>results.csv</a> (usable as a baseline) · <a href="batch.json">batch.json</a></p></header>
${conditionsBanner(batch)}
${batch.comparison ? comparisonSection(batch.comparison) : ''}
<section><h2>Results · median of ${o.runs} runs</h2><p class="muted" style="margin:0">Score bands: 90–100 good, 50–89 needs work, below 50 poor.</p>${resultsTable(medians)}</section>
<section><h2>Individual runs</h2>${runsTable(batch, rows)}</section>
</main></body></html>`;
}
