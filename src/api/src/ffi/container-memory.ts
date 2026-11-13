/**
 * The memory ceiling this process actually runs under (#5467).
 *
 * In a container the kernel enforces the cgroup limit, not the host's RAM, so
 * the decode memory budget is a share of that limit. cgroup v2 exposes it as
 * `memory.max` (and an optional lower throttling point, `memory.high`); v1 as
 * `memory/memory.limit_in_bytes`, where "no limit" reads as a page-rounded
 * 2^63. Outside a cgroup, or when a file is unreadable, the host's total RAM
 * is the ceiling. The result never exceeds host RAM: a limit larger than the
 * machine cannot be used.
 */

import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import path from 'node:path';

export type ContainerMemorySource = 'cgroup-v2' | 'cgroup-v1' | 'host';

export interface ContainerMemory {
  limitBytes: number;
  /** Memory charged to the cgroup right now (page cache included), or null on a host. */
  currentBytes: number | null;
  source: ContainerMemorySource;
}

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
const UNLIMITED_FLOOR = 2 ** 60;

/** A byte count, or null for `max`, an unlimited v1 value, or an unreadable file. */
function readBytes(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return value > 0 && value < UNLIMITED_FLOOR ? value : null;
  } catch {
    return null;
  }
}

export function readContainerMemory(
  cgroupRoot: string = DEFAULT_CGROUP_ROOT,
  hostTotalBytes: number = totalmem(),
): ContainerMemory {
  const v2 = (name: string) => path.join(cgroupRoot, name);
  if (existsSync(v2('memory.max'))) {
    return {
      limitBytes: Math.min(
        readBytes(v2('memory.max')) ?? hostTotalBytes,
        readBytes(v2('memory.high')) ?? hostTotalBytes,
        hostTotalBytes,
      ),
      currentBytes: readBytes(v2('memory.current')),
      source: 'cgroup-v2',
    };
  }
  const v1 = (name: string) => path.join(cgroupRoot, 'memory', name);
  if (existsSync(v1('memory.limit_in_bytes'))) {
    return {
      limitBytes: Math.min(
        readBytes(v1('memory.limit_in_bytes')) ?? hostTotalBytes,
        hostTotalBytes,
      ),
      currentBytes: readBytes(v1('memory.usage_in_bytes')),
      source: 'cgroup-v1',
    };
  }
  return { limitBytes: hostTotalBytes, currentBytes: null, source: 'host' };
}
