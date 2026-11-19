// Facts about the browser Lighthouse will drive, and things around it that can quietly skew a run.
// Pure parsing helpers are exported separately so they can be unit-tested without a browser.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Launcher } from 'chrome-launcher';

const run = promisify(execFile);

async function cmd(file, args, timeout = 5000) {
  try {
    const { stdout } = await run(file, args, { timeout, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

const readHead = async (file, bytes = 4096) => {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
};

// ---- pure helpers ----------------------------------------------------------

export function classifyChannel(binPath, versionText = '') {
  const text = versionText.toLowerCase();
  if (text.includes('for testing')) return 'chrome-for-testing';
  if (/canary/.test(text)) return 'canary';
  if (/chrome beta/.test(text)) return 'beta';
  if (/chrome dev/.test(text)) return 'dev';
  const seg = binPath.split(/[\\/]/);
  // Look only at the app bundle or the last few segments, so a folder like "dev" in a home path is ignored.
  const name = (seg.find((s) => s.endsWith('.app')) ?? seg.slice(-3).join(' ')).toLowerCase();
  if (/canary|sxs/.test(name)) return 'canary';
  if (/chrome[ -]?beta/.test(name)) return 'beta';
  if (/chrome[ -]?dev\b|unstable/.test(name)) return 'dev';
  if (name.includes('chrome for testing') || name.includes('chrome-for-testing')) return 'chrome-for-testing';
  if (name.includes('chromium')) return 'chromium';
  if (name.includes('chrome')) return 'stable';
  return 'unknown';
}

export const parseVersion = (text) => /(\d+\.\d+\.\d+\.\d+)/.exec(text ?? '')?.[1] ?? null;

export const detectPackaging = (binPath) => (/[\\/]snap[\\/]/.test(binPath) ? 'snap' : /flatpak/i.test(binPath) ? 'flatpak' : null);

/** macOS `file -b` output for a (possibly universal) Mach-O binary. */
export function parseFileArchs(text) {
  const out = new Set();
  if (/arm64/.test(text)) out.add('arm64');
  if (/x86_64/.test(text)) out.add('x64');
  if (/i386/.test(text)) out.add('x86');
  return [...out];
}

export function parsePeMachine(buf) {
  if (!buf || buf.length < 0x40) return null;
  const off = buf.readUInt32LE(0x3c);
  if (off + 6 > buf.length || buf.toString('latin1', off, off + 4) !== 'PE\0\0') return null;
  return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' }[buf.readUInt16LE(off + 4)] ?? null;
}

export function parseElfMachine(buf) {
  if (!buf || buf.length < 20 || buf.toString('latin1', 0, 4) !== '\x7fELF') return null;
  return { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'x86' }[buf.readUInt16LE(18)] ?? null;
}

export const parsePlutilKeys = (text) => [...(text ?? '').matchAll(/^ {2}"([^"]+)"\s*=>/gm)].map((m) => m[1]);

export function parseRegistryNames(text) {
  const names = new Set();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const value = /^\s{4}(\S+)\s+REG_/.exec(line);
    if (value) names.add(value[1]);
    else if (/^HKEY_/.test(line) && /Policies[\\/]+(Google[\\/]+Chrome|Chromium)[\\/]+\S/i.test(line)) names.add(line.split('\\').pop().trim());
  }
  return [...names];
}

export const proxyEnvVars = (env = process.env) => ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].filter((k) => env[k]);

export const parseScutilProxy = (text) => ['HTTPEnable', 'HTTPSEnable', 'ProxyAutoConfigEnable', 'SOCKSEnable'].some((k) => new RegExp(`${k}\\s*:\\s*1`).test(text ?? ''));

/**
 * Compare the browser binary's architecture with the hardware's.
 * A mismatch means Chrome runs through a translation layer, which slows everything down.
 */
export function judgeArch({ hardware, binArchs, nodeTranslated = false, platform = process.platform }) {
  if (!binArchs?.length || !hardware) return { status: 'Not assessed', display: 'Unavailable' };
  if (!binArchs.includes(hardware)) {
    return {
      status: platform === 'darwin' ? 'Poor' : 'Warning',
      display: `${binArchs.join(' + ')} build on ${hardware} hardware: runs under translation`,
    };
  }
  if (nodeTranslated) return { status: 'Warning', display: `Node runs under Rosetta, so Chrome may launch as Intel` };
  return { status: 'Ideal', display: `${binArchs.join(' + ')} build on ${hardware} hardware` };
}

/** Summarise Chrome/Chromium processes that are already running and competing for the machine. */
export function summarizeBrowserProcesses(list) {
  const mine = list.filter((p) => /chrom(e|ium)/i.test(p.name ?? '') && !/chrome-launcher/i.test(p.name));
  return {
    count: mine.length,
    cpuPct: Math.round(mine.reduce((a, p) => a + (p.cpu ?? 0), 0)),
    memMb: Math.round(mine.reduce((a, p) => a + (p.memRss ?? 0), 0) / 1024),
  };
}

// ---- probes ----------------------------------------------------------------

export function findBrowserPath() {
  try {
    return Launcher.getFirstInstallation() ?? null;
  } catch {
    return null;
  }
}

async function versionText(binPath) {
  if (process.platform === 'win32') {
    const out = await cmd('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${binPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`]);
    return out ? `Chrome ${out.trim()}` : null;
  }
  return cmd(binPath, ['--version'], 8000);
}

async function binaryArchs(binPath) {
  if (process.platform === 'darwin') return parseFileArchs((await cmd('file', ['-b', binPath])) ?? '');
  const head = await readHead(binPath);
  const one = process.platform === 'win32' ? parsePeMachine(head) : parseElfMachine(head);
  return one ? [one] : [];
}

async function hardwareArch() {
  if (process.platform === 'darwin') {
    const arm = await cmd('sysctl', ['-n', 'hw.optional.arm64']);
    return { hardware: arm?.trim() === '1' ? 'arm64' : 'x64' };
  }
  if (process.platform === 'win32') {
    const out = await cmd('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture']);
    const code = Number(out?.trim());
    if (code === 12) return { hardware: 'arm64' };
    if (code === 9) return { hardware: 'x64' };
    return { hardware: null };
  }
  return { hardware: os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x64' : null };
}

async function nodeUnderRosetta() {
  if (process.platform !== 'darwin') return false;
  return (await cmd('sysctl', ['-n', 'sysctl.proc_translated']))?.trim() === '1';
}

async function listPolicies() {
  const names = new Set();
  if (process.platform === 'darwin') {
    const user = os.userInfo().username;
    for (const id of ['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary', 'org.chromium.Chromium']) {
      for (const dir of ['/Library/Managed Preferences', `/Library/Managed Preferences/${user}`]) {
        const file = `${dir}/${id}.plist`;
        const exists = await fs.access(file).then(() => true, () => false);
        if (exists) parsePlutilKeys(await cmd('plutil', ['-p', file])).forEach((k) => names.add(k));
      }
    }
  } else if (process.platform === 'linux') {
    for (const dir of ['/etc/opt/chrome/policies/managed', '/etc/chromium/policies/managed', '/etc/chromium-browser/policies/managed']) {
      let files = [];
      try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        try { Object.keys(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))).forEach((k) => names.add(k)); } catch { /* unreadable policy file */ }
      }
    }
  } else if (process.platform === 'win32') {
    for (const hive of ['HKLM', 'HKCU']) {
      for (const vendor of ['Google\\Chrome', 'Chromium']) {
        parseRegistryNames(await cmd('reg', ['query', `${hive}\\SOFTWARE\\Policies\\${vendor}`, '/s'])).forEach((k) => names.add(k));
      }
    }
  }
  return [...names].sort();
}

export async function collectBrowserInfo() {
  const binPath = findBrowserPath();
  if (!binPath) return { found: false };
  const [text, archs, hw, translated, policies] = await Promise.all([versionText(binPath), binaryArchs(binPath), hardwareArch(), nodeUnderRosetta(), listPolicies()]);
  return {
    found: true,
    path: binPath,
    version: parseVersion(text),
    channel: classifyChannel(binPath, text ?? ''),
    packaging: detectPackaging(binPath),
    binArchs: archs,
    hardwareArch: hw.hardware,
    nodeTranslated: translated,
    policies,
  };
}

/** Proxy and VPN settings change latency and add variance, and Chrome inherits the system proxy. */
export async function collectProxyVpn() {
  const proxies = [];
  const env = proxyEnvVars();
  if (env.length) proxies.push(`environment (${env[0].toUpperCase()})`);
  let vpn = false;
  if (process.platform === 'darwin') {
    if (parseScutilProxy(await cmd('scutil', ['--proxy']))) proxies.push('system');
    vpn = /\(Connected\)/.test((await cmd('scutil', ['--nc', 'list'])) ?? '');
  } else if (process.platform === 'win32') {
    const reg = await cmd('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
    if (reg && (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg) || /AutoConfigURL\s+REG_SZ/i.test(reg))) proxies.push('system');
  }
  if (process.platform !== 'darwin') {
    vpn = Object.entries(os.networkInterfaces()).some(([name, addrs]) => /^(tun|tap|wg|ppp|tailscale|zt)\w*$/i.test(name) || (process.platform === 'win32' && /vpn|wireguard|tailscale/i.test(name))
      ? (addrs ?? []).some((a) => !a.internal)
      : false);
  }
  return { proxies, vpn };
}
