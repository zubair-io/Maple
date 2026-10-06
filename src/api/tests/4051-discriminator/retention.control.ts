/** Owned #4051 discriminator. Real files/conversions; no sidecar mocks. */
import { test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { callNative, shutdownMaplePool } from 'maple';
import { registerRoot, unregisterRoot } from '../../src/fs/root';
import { commitWorkflowVariant } from '../../src/fs/workflow-variants';
import { writeXmpAtomic } from '../../src/fs/xmp';
import { serializeSidecarWrite } from '../../src/fs/sidecar-write-order';
import {
  startSidecarChronology,
  finishSidecarChronology,
  traceSidecarBytes,
} from '../../src/fs/sidecar-write-chronology';

type Event = {
  event: string;
  destination?: string;
  moduleInstance?: string;
  transaction?: number;
  [key: string]: unknown;
};
function independentRead(file: string): string {
  const child = spawnSync('python3', [
    '-c',
    'import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())',
    file,
  ]);
  if (child.status !== 0) throw Error(child.stderr.toString());
  return child.stdout.toString();
}
const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');
const events = () =>
  (globalThis as typeof globalThis & { [key: symbol]: { events: Event[] } })[
    Symbol.for('maple4051Chronology')
  ].events;

test('4051 deterministic retained-history discriminator after fully published semantic commit', async () => {
  const initial = await fs.readFile(new URL('./initial.xmp', import.meta.url), 'utf8');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), '4051-retention-discriminator-')));
  const raw = join(root, 'photo.dng');
  const sidecar = join(root, 'photo.xmp');
  const original = 'owned synthetic original; never modified by writer controls';
  registerRoot(root);
  await fs.writeFile(raw, original);
  await fs.writeFile(sidecar, initial);
  startSidecarChronology(sidecar);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let publication: Promise<void> | undefined;
  let settled: Promise<unknown> | undefined;
  try {
    const warm = await fs.readFile(sidecar, 'utf8');
    traceSidecarBytes('control-warm-read', warm, { sidecar });
    expect(warm).toBe(initial);
    const checkpoint = await callNative('workflowCheckpointXmp', [initial]);
    if (!checkpoint.ok) throw Error(checkpoint.error);
    const entry = {
      id: crypto.randomUUID(),
      createdAtMs: 3,
      action: 'preset',
      label: 'First fully published semantic action',
      adjustmentXmp: checkpoint.value,
    };
    const published = await commitWorkflowVariant(raw, 'primary', initial, initial, entry);
    const diskBefore = independentRead(sidecar);
    expect(diskBefore).toBe(published);
    const record = await callNative('workflowReadXmp', [diskBefore]);
    if (!record.ok) throw Error(record.error);
    expect(JSON.parse(record.value).history).toEqual([entry]);
    publication = serializeSidecarWrite(sidecar, async () => {
      entered();
      await gate;
    });
    await enteredGate;
    const before = events().filter((e) => e.event === 'queued' && e.destination === sidecar).length;
    const semantic = Array.from({ length: 8 }, (_, index) =>
      commitWorkflowVariant(raw, 'primary', initial, initial, {
        ...entry,
        id: crypto.randomUUID(),
        createdAtMs: index + 10,
      }),
    );
    const ordinary = Array.from({ length: 8 }, () => writeXmpAtomic(raw, initial));
    const semanticResults = Promise.allSettled(semantic);
    const ordinaryResults = Promise.all(ordinary);
    settled = Promise.all([semanticResults, ordinaryResults]);
    // The real held coordinator prevents ordinary native validation from
    // competing with the eight pre-coordinator lookups. No capacity changes.
    const deadline = Date.now() + 5000;
    while (
      events().filter((e) => e.event === 'queued' && e.destination === sidecar).length <
        before + 16 &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const queued = events().filter((e) => e.event === 'queued' && e.destination === sidecar).length;
    release();
    await publication;
    const [sem, ord] = await Promise.all([semanticResults, ordinaryResults]);
    const diskAfter = independentRead(sidecar);
    const chronology = finishSidecarChronology();
    console.log(
      '4051 deterministic discriminator:',
      JSON.stringify({
        warmHash: hash(warm),
        publishedHash: hash(published),
        diskBeforeHash: hash(diskBefore),
        diskAfterHash: hash(diskAfter),
        queued,
        expectedQueued: before + 16,
        semantic: sem.map((x) =>
          x.status === 'fulfilled'
            ? { status: x.status, outputHash: hash(x.value) }
            : { status: x.status, error: String(x.reason) },
        ),
        ordinary: ord.map((x) => ({
          ok: x.ok,
          error: x.error,
          outputHash: x.data === undefined ? null : hash(x.data),
        })),
        moduleInstances: [
          ...new Set(chronology.flatMap((e) => ('moduleInstance' in e ? [e.moduleInstance] : []))),
        ],
        canonicalKeys: [
          ...new Set(chronology.flatMap((e) => ('destination' in e ? [e.destination] : []))),
        ],
        chronology,
      }),
    );
    expect(queued).toBe(before + 16);
    expect(
      sem.every(
        (x) =>
          x.status === 'rejected' &&
          String(x.reason).includes('Variant changed. Reopen it before saving this action.'),
      ),
    ).toBe(true);
    expect(ord.every((x) => x.ok && x.data === published)).toBe(true);
    expect(diskAfter).toBe(published);
    expect(await fs.readFile(raw, 'utf8')).toBe(original);
  } finally {
    release?.();
    await publication?.catch(() => undefined);
    await settled?.catch(() => undefined);
    finishSidecarChronology();
    shutdownMaplePool();
    unregisterRoot(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});
