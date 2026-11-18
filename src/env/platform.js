// OS-specific probes. Each returns a value, or null when the OS cannot provide it,
// so the verdict marks the check "Not assessed" instead of failing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import si from 'systeminformation';

const run = promisify(execFile);

async function cmd(file, args, timeout = 4000) {
  try {
    const { stdout } = await run(file, args, { timeout, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

const darwin = {
  async powerSaver() {
    const out = await cmd('pmset', ['-g']);
    const m = out && /lowpowermode\s+(\d)/.exec(out);
    return m ? m[1] === '1' : null;
  },
  async thermal() {
    const out = await cmd('pmset', ['-g', 'therm']);
    if (out === null) return null;
    const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out);
    // No limit recorded means the OS has not throttled the CPU.
    return { speedLimitPct: m ? Number(m[1]) : 100 };
  },
};

const linux = {
  async powerSaver() {
    const out = await cmd('powerprofilesctl', ['get']);
    return out === null ? null : out.trim() === 'power-saver';
  },
  async thermal() {
    try {
      const t = await si.cpuTemperature();
      return Number.isFinite(t.main) && t.main > 0 ? { tempC: t.main } : null;
    } catch {
      return null;
    }
  },
};

const win32 = {
  async powerSaver() {
    const out = await cmd('powercfg', ['/getactivescheme']);
    if (out === null) return null;
    // GUID of the built-in "Power saver" plan; the plan name itself is localised.
    return out.toLowerCase().includes('a1841308-3541-4fab-bc81-f71556f20b4a');
  },
  // Windows exposes no reliable throttling signal without admin tooling.
  async thermal() {
    return null;
  },
};

const none = { powerSaver: async () => null, thermal: async () => null };

export const platformProbes = { darwin, linux, win32 }[process.platform] ?? none;
