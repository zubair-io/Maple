import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readContainerMemory } from './container-memory.ts';

const GIB = 1024 ** 3;
const HOST = 64 * GIB;
const roots: string[] = [];

function cgroupRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'maple-cgroup-'));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), body);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readContainerMemory — cgroup v2', () => {
  it('reads memory.max and memory.current as the production container reports them', () => {
    const root = cgroupRoot({
      'memory.max': '47244640256\n',
      'memory.high': 'max\n',
      'memory.current': '21910720512\n',
    });
    expect(readContainerMemory(root, HOST)).toEqual({
      limitBytes: 47244640256,
      currentBytes: 21910720512,
      source: 'cgroup-v2',
    });
  });

  it('uses memory.high when it throttles below memory.max', () => {
    const root = cgroupRoot({
      'memory.max': `${40 * GIB}`,
      'memory.high': `${30 * GIB}`,
    });
    expect(readContainerMemory(root, HOST).limitBytes).toBe(30 * GIB);
  });

  it('falls back to host RAM when the cgroup is unlimited', () => {
    const root = cgroupRoot({
      'memory.max': 'max\n',
      'memory.current': '1048576',
    });
    expect(readContainerMemory(root, HOST)).toEqual({
      limitBytes: HOST,
      currentBytes: 1048576,
      source: 'cgroup-v2',
    });
  });

  it('never reports more than the host has', () => {
    const root = cgroupRoot({ 'memory.max': `${128 * GIB}` });
    expect(readContainerMemory(root, HOST).limitBytes).toBe(HOST);
  });

  it('treats a garbled file as unlimited rather than as zero', () => {
    const root = cgroupRoot({ 'memory.max': 'garbage' });
    expect(readContainerMemory(root, HOST).limitBytes).toBe(HOST);
  });
});

describe('readContainerMemory — cgroup v1', () => {
  it('reads limit_in_bytes and usage_in_bytes', () => {
    const root = cgroupRoot({
      'memory/memory.limit_in_bytes': `${16 * GIB}\n`,
      'memory/memory.usage_in_bytes': `${3 * GIB}\n`,
    });
    expect(readContainerMemory(root, HOST)).toEqual({
      limitBytes: 16 * GIB,
      currentBytes: 3 * GIB,
      source: 'cgroup-v1',
    });
  });

  it('reads the page-rounded 2^63 "no limit" value as host RAM', () => {
    const root = cgroupRoot({
      'memory/memory.limit_in_bytes': '9223372036854771712\n',
    });
    expect(readContainerMemory(root, HOST).limitBytes).toBe(HOST);
  });
});

describe('readContainerMemory — no cgroup', () => {
  it('uses host RAM with no current reading', () => {
    expect(readContainerMemory(cgroupRoot({}), HOST)).toEqual({
      limitBytes: HOST,
      currentBytes: null,
      source: 'host',
    });
  });

  it('handles a cgroup root that does not exist', () => {
    expect(readContainerMemory('/nonexistent/maple-cgroup', HOST).source).toBe('host');
  });
});
