import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import si from 'systeminformation';
import { collectBrowserInfo, collectProxyVpn, summarizeBrowserProcesses } from './browser.js';
import { platformProbes } from './platform.js';
import { median, round, sleep } from '../util.js';

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

async function sampleCpuLoad(ms = 1000) {
  const snap = () => os.cpus().reduce((a, c) => {
    const t = c.times;
    return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq };
  }, { idle: 0, total: 0 });
  const a = snap();
  await sleep(ms);
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? round((1 - (b.idle - a.idle) / total) * 100, 1) : null;
}

function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host, port });
    const done = (ms) => { socket.destroy(); resolve(ms); };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('connect', () => done(performance.now() - t0));
    socket.once('error', () => done(null));
  });
}

/** TCP connect time ≈ one round trip; jitter is the mean gap between consecutive samples. */
async function probeNetwork(target, samples = 8) {
  if (!target) return null;
  let host, port;
  try {
    const u = new URL(target);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
  } catch {
    host = target;
    port = 443;
  }
  const times = [];
  for (let i = 0; i < samples; i++) {
    times.push(await connectOnce(host, port, 2000));
    await sleep(80);
  }
  const ok = times.filter((t) => t !== null);
  if (!ok.length) return { host, latencyMs: null, jitterMs: null, lossPct: 100 };
  const diffs = ok.slice(1).map((t, i) => Math.abs(t - ok[i]));
  return {
    host,
    latencyMs: round(median(ok), 1),
    jitterMs: diffs.length ? round(diffs.reduce((a, b) => a + b, 0) / diffs.length, 1) : 0,
    lossPct: round(((times.length - ok.length) / times.length) * 100, 1),
  };
}

async function probeDownload(url, timeoutMs = 15000) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok || !res.body) return null;
    let bytes = 0;
    let start = null;
    for await (const chunk of res.body) {
      if (start === null) { start = performance.now(); continue; }
      bytes += chunk.length;
    }
    if (start === null || bytes === 0) return null;
    const seconds = (performance.now() - start) / 1000;
    return round((bytes * 8) / seconds / 1e6, 1);
  } catch {
    return null;
  }
}

function environmentType() {
  if (process.platform === 'linux') {
    if (os.release().toLowerCase().includes('microsoft')) return 'wsl';
    if (fs.existsSync('/.dockerenv')) return 'container';
  }
  return 'host';
}

let hostCache = null;
async function hostInfo() {
  if (hostCache) return hostCache;
  const info = await safe(() => si.osInfo(), {});
  const sys = await safe(() => si.system(), {});
  hostCache = {
    os: info.distro || os.type(),
    osVersion: info.release || os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
    cpuCores: os.cpus().length,
    ramGb: round(os.totalmem() / 1024 ** 3, 1),
    environmentType: sys.virtual ? 'vm' : environmentType(),
  };
  return hostCache;
}

async function probePower() {
  const b = await safe(() => si.battery());
  if (!b) return null;
  if (!b.hasBattery) return { hasBattery: false, onAc: true, percent: null };
  return { hasBattery: true, onAc: Boolean(b.acConnected), percent: Number.isFinite(b.percent) ? b.percent : null };
}

async function probeWifi() {
  const list = await safe(() => si.wifiConnections(), []);
  const c = list.find((w) => Number.isFinite(w.signalLevel) && w.signalLevel < 0);
  return c ? { signalDbm: c.signalLevel } : null;
}

const topProcesses = (list, n = 3) => list
  .filter((x) => x.pid !== process.pid && x.cpu > 5)
  .sort((a, b) => b.cpu - a.cpu)
  .slice(0, n)
  .map((x) => ({ name: x.name, cpuPct: round(x.cpu, 0) }));

/**
 * Snapshot of the machine. `light` skips the slow probes (throughput, Wi-Fi, process list)
 * so one can be taken before every single Lighthouse run.
 */
export async function collectSnapshot({ light = false, latencyHost = null, throughputUrl = null } = {}) {
  const [cpuLoad, mem, power, powerSaver, thermal, net, host] = await Promise.all([
    sampleCpuLoad(light ? 600 : 1000),
    safe(() => si.mem()),
    probePower(),
    safe(() => platformProbes.powerSaver()),
    safe(() => platformProbes.thermal()),
    probeNetwork(latencyHost, light ? 5 : 8),
    hostInfo(),
  ]);
  const snapshot = {
    takenAt: new Date().toISOString(),
    light,
    host,
    raw: {
      power,
      powerSaver,
      cpuLoadPct: cpuLoad,
      freeMemGb: mem ? round(mem.available / 1024 ** 3, 1) : null,
      totalMemGb: mem ? round(mem.total / 1024 ** 3, 1) : null,
      thermal,
      net,
      downloadMbps: null,
      wifi: null,
      browser: null,
      proxyVpn: null,
      otherBrowsers: null,
    },
    topProcesses: [],
  };
  if (!light) {
    const [dl, wifi, procs, browser, proxyVpn] = await Promise.all([
      probeDownload(throughputUrl),
      probeWifi(),
      safe(() => si.processes(), null),
      safe(() => collectBrowserInfo()),
      safe(() => collectProxyVpn()),
    ]);
    snapshot.raw.downloadMbps = dl;
    snapshot.raw.wifi = wifi;
    snapshot.raw.browser = browser;
    snapshot.raw.proxyVpn = proxyVpn;
    snapshot.raw.otherBrowsers = procs ? summarizeBrowserProcesses(procs.list) : null;
    snapshot.topProcesses = procs ? topProcesses(procs.list) : [];
  }
  return snapshot;
}
