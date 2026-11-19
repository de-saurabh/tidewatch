// Minimal RFC 4180 reader/writer. The CSV is the only persistent record, so it
// carries its own schema version and every column needed to judge comparability.

export const SCHEMA_VERSION = 1;

export const COLUMNS = [
  'schema_version', 'batch_id', 'timestamp', 'row_type', 'url', 'profile_id', 'profile_name', 'run', 'is_median_run', 'error',
  'perf_score', 'a11y_score', 'best_practices_score', 'seo_score',
  'lcp_ms', 'cls', 'tbt_ms', 'fcp_ms', 'speed_index_ms', 'transfer_kb', 'requests',
  'runs_ok', 'runs_degraded', 'perf_score_stddev', 'lcp_min_ms', 'lcp_max_ms',
  'env_verdict_start', 'env_verdict_batch_before', 'env_verdict_batch_after',
  'on_ac', 'battery_pct', 'power_saver', 'cpu_load_pct', 'free_mem_gb', 'thermal', 'latency_ms', 'jitter_ms', 'packet_loss_pct',
  'download_mbps_before', 'download_mbps_after',
  'os', 'os_version', 'arch', 'cpu_model', 'cpu_cores', 'ram_gb',
  'chrome_version', 'lighthouse_version', 'benchmark_index',
  'form_factor', 'throttling_method', 'rtt_ms', 'download_kbps', 'cpu_slowdown', 'cache_mode', 'run_warnings',
  'browser_mode', 'browser_channel', 'browser_arch', 'browser_policies', 'extensions_loaded', 'clean_profile',
];

function encodeCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'boolean' ? String(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => encodeCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function parseCsv(text) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') records.push(row); }
  if (!records.length) return { header: [], rows: [] };
  const header = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, rows };
}

const NUMERIC = new Set([
  'schema_version', 'run', 'perf_score', 'a11y_score', 'best_practices_score', 'seo_score', 'lcp_ms', 'cls', 'tbt_ms', 'fcp_ms',
  'speed_index_ms', 'transfer_kb', 'requests', 'runs_ok', 'runs_degraded', 'perf_score_stddev', 'lcp_min_ms', 'lcp_max_ms',
  'battery_pct', 'cpu_load_pct', 'free_mem_gb', 'latency_ms', 'jitter_ms', 'packet_loss_pct', 'download_mbps_before',
  'download_mbps_after', 'cpu_cores', 'ram_gb', 'benchmark_index', 'rtt_ms', 'download_kbps', 'cpu_slowdown', 'run_warnings',
  'browser_policies', 'extensions_loaded',
]);

const REQUIRED = ['schema_version', 'row_type', 'url', 'profile_id', 'perf_score', 'lcp_ms', 'cls', 'tbt_ms', 'fcp_ms', 'speed_index_ms'];

/** Parse and validate a CSV produced by this tool. Returns { ok, errors, rows, info }. */
export function readResultsCsv(text) {
  const errors = [];
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['The file is empty.'], rows: [], info: null };
  const { header, rows } = parseCsv(text);
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) errors.push(`Missing required columns: ${missing.join(', ')}.`);
  if (!errors.length) {
    const versions = new Set(rows.map((r) => r.schema_version));
    for (const v of versions) {
      if (Number(v) !== SCHEMA_VERSION) errors.push(`Unsupported schema_version "${v}" (this app reads version ${SCHEMA_VERSION}).`);
    }
    if (!rows.some((r) => r.row_type === 'median')) errors.push('No median rows found. Was this file produced by Tidewatch?');
  }
  if (errors.length) return { ok: false, errors, rows: [], info: null };
  const typed = rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = NUMERIC.has(k) ? (v === '' ? null : Number(v)) : v;
    return o;
  });
  const medians = typed.filter((r) => r.row_type === 'median');
  const first = typed[0];
  return {
    ok: true,
    errors,
    rows: typed,
    info: {
      batchId: first.batch_id,
      timestamp: first.timestamp,
      os: first.os,
      arch: first.arch,
      rowCount: typed.length,
      runCount: typed.filter((r) => r.row_type === 'run').length,
      urls: [...new Set(medians.map((r) => r.url))].length,
      profiles: [...new Set(medians.map((r) => r.profile_id))].length,
      verdict: first.env_verdict_batch_before,
    },
  };
}
