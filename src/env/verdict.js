// Turns a raw snapshot into graded checks plus an overall verdict.
// Statuses: Ideal | Warning | Poor | Not assessed. Overall: Ideal | Acceptable | Poor.

import { judgeArch } from './browser.js';

const RANK = { Ideal: 0, 'Not assessed': 0, Warning: 1, Poor: 2 };

function grade(value, { warn, poor }, higherIsBetter = false) {
  if (!Number.isFinite(value)) return 'Not assessed';
  if (higherIsBetter) return value < poor ? 'Poor' : value < warn ? 'Warning' : 'Ideal';
  return value > poor ? 'Poor' : value > warn ? 'Warning' : 'Ideal';
}

const na = (rule) => ({ status: 'Not assessed', display: 'Unavailable', rule });

const CHECKS = [
  {
    id: 'power',
    label: 'Power source',
    run: (s, t) => {
      const p = s.raw.power;
      if (!p) return na('Not provided on this machine');
      if (!p.hasBattery) return { status: 'Ideal', display: 'Mains power (no battery)', rule: 'Needs AC or a charged battery' };
      const pct = p.percent == null ? '' : ` · ${Math.round(p.percent)}%`;
      const rule = t.power.requireAC ? `Needs AC, or battery above ${t.power.warnPercent}%` : `Battery above ${t.power.warnPercent}%`;
      if (p.onAc) return { status: 'Ideal', display: `On AC${pct}`, rule };
      let status = t.power.requireAC ? 'Warning' : 'Ideal';
      if (p.percent != null) {
        const byPct = grade(p.percent, { warn: t.power.warnPercent, poor: t.power.poorPercent }, true);
        if (RANK[byPct] > RANK[status]) status = byPct;
      }
      return { status, display: `On battery${pct}`, rule };
    },
  },
  {
    id: 'powerSaver',
    label: 'Power saver mode',
    run: (s) => {
      const v = s.raw.powerSaver;
      if (v == null) return na('Not provided on this OS');
      return { status: v ? 'Warning' : 'Ideal', display: v ? 'On' : 'Off', rule: 'Must be off' };
    },
  },
  {
    id: 'cpuLoad',
    label: 'CPU load',
    run: (s, t) => {
      const v = s.raw.cpuLoadPct;
      const top = s.topProcesses?.[0];
      return {
        status: grade(v, t.cpuLoadPct),
        display: v == null ? 'Unavailable' : `${v}%${top ? ` · ${top.name} ${top.cpuPct}%` : ''}`,
        rule: `Ideal up to ${t.cpuLoadPct.warn}%, poor above ${t.cpuLoadPct.poor}%`,
      };
    },
  },
  {
    id: 'freeMem',
    label: 'Free memory',
    run: (s, t) => {
      const v = s.raw.freeMemGb;
      return {
        status: grade(v, t.freeMemGb, true),
        display: v == null ? 'Unavailable' : `${v} GB of ${s.raw.totalMemGb} GB`,
        rule: `Ideal above ${t.freeMemGb.warn} GB, poor below ${t.freeMemGb.poor} GB`,
      };
    },
  },
  {
    id: 'thermal',
    label: 'Thermal state',
    run: (s, t) => {
      const th = s.raw.thermal;
      if (!th) return na('Not provided on this OS');
      if (th.speedLimitPct != null) {
        return {
          status: grade(th.speedLimitPct, { warn: t.thermalSpeedLimitPct.warn, poor: t.thermalSpeedLimitPct.poor }, true),
          display: th.speedLimitPct >= 100 ? 'Nominal' : `Throttled to ${th.speedLimitPct}%`,
          rule: 'No CPU throttling',
        };
      }
      return {
        status: grade(th.tempC, t.thermalTempC),
        display: `${th.tempC} °C`,
        rule: `Ideal up to ${t.thermalTempC.warn} °C, poor above ${t.thermalTempC.poor} °C`,
      };
    },
  },
  {
    id: 'latency',
    label: 'Latency to target',
    run: (s, t) => {
      const n = s.raw.net;
      if (!n || n.latencyMs == null) return { status: n ? 'Poor' : 'Not assessed', display: n ? 'Unreachable' : 'Unavailable', rule: `Ideal up to ${t.latencyMs.warn} ms` };
      return { status: grade(n.latencyMs, t.latencyMs), display: `${n.latencyMs} ms`, rule: `Ideal up to ${t.latencyMs.warn} ms, poor above ${t.latencyMs.poor} ms` };
    },
  },
  {
    id: 'jitter',
    label: 'Network jitter',
    run: (s, t) => {
      const n = s.raw.net;
      if (!n || n.jitterMs == null) return na(`Ideal up to ${t.jitterMs.warn} ms`);
      return { status: grade(n.jitterMs, t.jitterMs), display: `${n.jitterMs} ms`, rule: `Ideal up to ${t.jitterMs.warn} ms, poor above ${t.jitterMs.poor} ms` };
    },
  },
  {
    id: 'packetLoss',
    label: 'Connection failures',
    run: (s, t) => {
      const n = s.raw.net;
      if (!n) return na(`Ideal up to ${t.packetLossPct.warn}%`);
      return { status: grade(n.lossPct, t.packetLossPct), display: `${n.lossPct}% of probes`, rule: `Ideal up to ${t.packetLossPct.warn}%, poor above ${t.packetLossPct.poor}%` };
    },
  },
  {
    id: 'download',
    label: 'Download throughput',
    fullOnly: true,
    run: (s, t) => {
      const v = s.raw.downloadMbps;
      if (v == null) return na('Probe disabled or unreachable');
      return { status: grade(v, t.downloadMbps, true), display: `${v} Mbps`, rule: `Ideal above ${t.downloadMbps.warn} Mbps, poor below ${t.downloadMbps.poor} Mbps` };
    },
  },
  {
    id: 'wifi',
    label: 'Wi-Fi signal',
    fullOnly: true,
    run: (s, t) => {
      const w = s.raw.wifi;
      if (!w) return na('Not provided on this OS, or not on Wi-Fi');
      return { status: grade(w.signalDbm, t.wifiSignalDbm, true), display: `${w.signalDbm} dBm`, rule: `Ideal above ${t.wifiSignalDbm.warn} dBm` };
    },
  },
  {
    id: 'browser',
    group: 'browser',
    label: 'Browser',
    fullOnly: true,
    run: (s) => {
      const b = s.raw.browser;
      if (!b) return na('Could not inspect the browser');
      if (!b.found) return { status: 'Poor', display: 'Chrome not found', rule: 'Install Chrome, or set CHROME_PATH' };
      if (!b.version) return { status: 'Not assessed', display: 'Version unknown', rule: 'A stable Chrome build gives comparable baselines' };
      const label = { stable: 'Chrome', chromium: 'Chromium', 'chrome-for-testing': 'Chrome for Testing', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome Canary', unknown: 'Chrome' }[b.channel];
      const pre = ['beta', 'dev', 'canary'].includes(b.channel);
      const pkg = b.packaging ? ` · ${b.packaging} package` : '';
      return {
        status: pre || b.packaging ? 'Warning' : 'Ideal',
        display: `${label} ${b.version}${pkg}`,
        rule: pre ? 'Pre-release builds change often; use a stable build for baselines' : b.packaging ? 'Snap and Flatpak builds restrict the sandbox and temp folders' : 'A stable build gives comparable baselines',
      };
    },
  },
  {
    id: 'browserArch',
    group: 'browser',
    label: 'Browser architecture',
    fullOnly: true,
    run: (s) => {
      const b = s.raw.browser;
      if (!b?.found) return na('Needs a browser');
      return { ...judgeArch({ hardware: b.hardwareArch, binArchs: b.binArchs, nodeTranslated: b.nodeTranslated }), rule: 'Must match the hardware, or Chrome runs under translation' };
    },
  },
  {
    id: 'browserPolicies',
    group: 'browser',
    label: 'Managed policies',
    fullOnly: true,
    run: (s) => {
      const b = s.raw.browser;
      if (!b?.found) return na('Needs a browser');
      const n = b.policies.length;
      return {
        status: n ? 'Warning' : 'Ideal',
        display: n ? `${n} polic${n === 1 ? 'y' : 'ies'}: ${b.policies.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}` : 'None',
        rule: 'Enterprise policies apply even to a fresh profile and can change browser behaviour',
      };
    },
  },
  {
    id: 'otherBrowsers',
    group: 'browser',
    label: 'Other Chrome processes',
    fullOnly: true,
    run: (s, t) => {
      const o = s.raw.otherBrowsers;
      if (!o) return na('Process list unavailable');
      return {
        status: grade(o.cpuPct, t.otherBrowserCpuPct),
        display: o.count ? `${o.count} running · ${o.cpuPct}% CPU · ${o.memMb} MB` : 'None running',
        rule: `Ideal up to ${t.otherBrowserCpuPct.warn}% CPU, poor above ${t.otherBrowserCpuPct.poor}%`,
      };
    },
  },
  {
    id: 'proxyVpn',
    group: 'browser',
    label: 'Proxy and VPN',
    fullOnly: true,
    run: (s) => {
      const p = s.raw.proxyVpn;
      if (!p) return na('Not provided on this OS');
      const found = [p.proxies.length ? `proxy via ${p.proxies.join(' and ')}` : null, p.vpn ? 'VPN connected' : null].filter(Boolean);
      return { status: found.length ? 'Warning' : 'Ideal', display: found.length ? found.join(', ') : 'None detected', rule: 'Proxies and VPNs add latency and variance' };
    },
  },
];

export function evaluate(snapshot, thresholds) {
  const checks = CHECKS.filter((c) => !(snapshot.light && c.fullOnly)).map((c) => {
    const r = c.run(snapshot, thresholds);
    return { id: c.id, group: c.group ?? 'machine', label: c.label, ...r };
  });
  const counts = { Ideal: 0, Warning: 0, Poor: 0, 'Not assessed': 0 };
  for (const c of checks) counts[c.status]++;
  const overall = counts.Poor ? 'Poor' : counts.Warning ? 'Acceptable' : 'Ideal';
  return { overall, assessed: checks.length - counts['Not assessed'], total: checks.length, counts, checks };
}

const OVERALL_RANK = { Ideal: 0, Acceptable: 1, Poor: 2 };
export const worstVerdict = (...verdicts) => verdicts.filter(Boolean).reduce((a, b) => (OVERALL_RANK[b] > OVERALL_RANK[a] ? b : a), 'Ideal');
