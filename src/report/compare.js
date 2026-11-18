import { worstVerdict } from '../env/verdict.js';
import { round } from '../util.js';

const chromeMajor = (v) => String(v ?? '').split('.')[0] || 'unknown';

/** Worst environment verdict recorded anywhere in a results CSV. */
export function recordedVerdict(rows) {
  return worstVerdict(...rows.flatMap((r) => [r.env_verdict_start, r.env_verdict_batch_before, r.env_verdict_batch_after]));
}

function metricDefs(r) {
  return [
    { key: 'perf_score', label: 'Performance score', kind: 'points', higherBetter: true, threshold: r.scorePoints },
    { key: 'lcp_ms', label: 'LCP', kind: 'pct', threshold: r.lcpPct },
    { key: 'tbt_ms', label: 'TBT', kind: 'pct', threshold: r.tbtPct },
    { key: 'cls', label: 'CLS', kind: 'abs', threshold: r.clsAbs },
    { key: 'fcp_ms', label: 'FCP', kind: 'pct', threshold: r.fcpPct },
    { key: 'speed_index_ms', label: 'Speed Index', kind: 'pct', threshold: r.siPct },
  ];
}

function judge(def, base, cur) {
  const delta = cur - base;
  const pct = base ? (delta / base) * 100 : null;
  let worse;
  let better;
  if (def.kind === 'points') { worse = delta <= -def.threshold; better = delta >= def.threshold; }
  else if (def.kind === 'abs') { worse = delta >= def.threshold; better = delta <= -def.threshold; }
  else if (pct === null) { worse = false; better = false; }
  else { worse = pct >= def.threshold; better = pct <= -def.threshold; }
  return { delta, pct, status: worse ? 'Regressed' : better ? 'Improved' : 'Within threshold' };
}

function sameOrDiffers(ok, same, differs) {
  return { status: ok ? 'Same' : 'Differs', text: ok ? same : differs };
}

const profileShape = (r) => [r.form_factor, r.throttling_method, r.rtt_ms, r.download_kbps, r.cpu_slowdown].join('|');

export function compareRuns(baselineRows, currentRows, regression) {
  const baseMed = baselineRows.filter((r) => r.row_type === 'median');
  const curMed = currentRows.filter((r) => r.row_type === 'median');
  const key = (r) => `${r.url}\u0000${r.profile_id}`;
  const baseByKey = new Map(baseMed.map((r) => [key(r), r]));
  const curByKey = new Map(curMed.map((r) => [key(r), r]));
  const defs = metricDefs(regression);

  const rows = [];
  for (const cur of curMed) {
    const base = baseByKey.get(key(cur));
    if (!base) continue;
    const degraded = cur.runs_degraded ?? 0;
    const total = cur.runs_ok ?? 0;
    for (const def of defs) {
      const b = base[def.key];
      const c = cur[def.key];
      if (b == null || c == null) continue;
      const j = judge(def, b, c);
      rows.push({
        url: cur.url,
        profileId: cur.profile_id,
        profileName: cur.profile_name,
        metric: def.label,
        key: def.key,
        baseline: b,
        current: c,
        delta: round(j.delta, def.key === 'cls' ? 3 : 1),
        pct: j.pct == null ? null : round(j.pct, 1),
        status: j.status,
        unreliable: cur.env_verdict_start === 'Poor' || degraded > 0,
        note: degraded > 0 ? `${degraded} of ${total} runs not ideal` : 'Conditions ideal',
      });
    }
  }

  const matchedProfiles = [...new Set(rows.map((r) => r.profileId))];
  const shapeDiffers = matchedProfiles.filter((id) => {
    const b = baseMed.find((r) => r.profile_id === id);
    const c = curMed.find((r) => r.profile_id === id);
    return profileShape(b) !== profileShape(c);
  });

  const b0 = baselineRows[0] ?? {};
  const c0 = currentRows[0] ?? {};
  const baseVerdict = recordedVerdict(baselineRows);
  const curVerdict = recordedVerdict(currentRows);
  const comparability = [
    sameOrDiffers(b0.os === c0.os && b0.arch === c0.arch, `OS and CPU architecture: ${c0.os} ${c0.arch}`, `OS or architecture differs: ${b0.os} ${b0.arch} vs ${c0.os} ${c0.arch}`),
    sameOrDiffers(b0.cpu_model === c0.cpu_model, `CPU: ${c0.cpu_model}`, `CPU differs: ${b0.cpu_model} vs ${c0.cpu_model}`),
    sameOrDiffers(
      chromeMajor(b0.chrome_version) === chromeMajor(c0.chrome_version) && b0.lighthouse_version === c0.lighthouse_version,
      `Chrome ${chromeMajor(c0.chrome_version)} and Lighthouse ${c0.lighthouse_version}`,
      `Versions differ: Chrome ${chromeMajor(b0.chrome_version)} / Lighthouse ${b0.lighthouse_version} vs Chrome ${chromeMajor(c0.chrome_version)} / Lighthouse ${c0.lighthouse_version}`,
    ),
    sameOrDiffers(
      !shapeDiffers.length,
      'Profile throttling settings match',
      `Throttling settings differ for: ${shapeDiffers.join(', ')}`,
    ),
    sameOrDiffers(
      baseVerdict === curVerdict,
      `Both recorded under ${curVerdict} conditions`,
      `Baseline was recorded under ${baseVerdict} conditions, this batch under ${curVerdict}`,
    ),
  ];

  const baselineOnly = baseMed.filter((r) => !curByKey.has(key(r))).map((r) => ({ url: r.url, profileId: r.profile_id }));
  const currentOnly = curMed.filter((r) => !baseByKey.has(key(r))).map((r) => ({ url: r.url, profileId: r.profile_id }));
  const summary = { regressed: 0, improved: 0, within: 0 };
  for (const r of rows) summary[r.status === 'Regressed' ? 'regressed' : r.status === 'Improved' ? 'improved' : 'within']++;

  return {
    comparable: comparability.every((c) => c.status === 'Same'),
    comparability,
    rows,
    summary,
    baselineOnly,
    currentOnly,
    baseline: { batchId: b0.batch_id, timestamp: b0.timestamp, verdict: baseVerdict },
  };
}
