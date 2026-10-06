/** Diagnostic-only #4051: distinct real workflow payloads across worker reuse. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  callNative,
  loadNativeBinding,
  shutdownMaplePool,
  getMapleConcurrency,
  getMapleExecutionMode,
} from 'maple';
import type { WorkflowBinding, WorkflowResult } from '../../../maple/src/native-workflow';

type Request = { method: keyof WorkflowBinding; args: string[]; sentinel: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('4051 mixed-method workflow replies retain exact correlation and earlier strings', async () => {
  // Existing supported test switch; one fresh process, no configured-capacity change.
  expect(process.env.MAPLE_NAPI).toBe('0');
  expect(getMapleConcurrency()).toBe(4);
  expect(getMapleExecutionMode()).toBe('worker');
  const native = loadNativeBinding();
  const sync = (request: Request): WorkflowResult => {
    const fn = native[request.method] as (...args: string[]) => WorkflowResult;
    return fn(...request.args);
  };
  const wave = (number: number): Request[] => {
    const label = (index: number) => `4051-wave-${number}-payload-${index}`;
    const xml = (index: number) =>
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Temperature="${5200 + number * 10 + index}" crs:Label="${label(index)}"/></rdf:RDF></x:xmpmeta>`;
    const record = (index: number) =>
      JSON.stringify({
        schemaVersion: 1,
        variantId: 'primary',
        variantName: label(index),
        snapshots: [],
        history: [],
      });
    const readInput = native.workflowEmbedXmp(record(1), xml(1));
    expect(readInput.ok).toBe(true);
    if (!readInput.ok) throw Error(readInput.error);
    const checkpoint = native.workflowCheckpointXmp(xml(7));
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw Error(checkpoint.error);
    const filename = (index: number): Request => ({
      method: 'workflowVariantFilename',
      args: [
        `${label(index)}.xmp`,
        `00000000-0000-0000-0000-${String(number * 10 + index).padStart(12, '0')}`,
      ],
      sentinel: label(index),
    });
    const requests: Request[] = [
      filename(0),
      { method: 'workflowReadXmp', args: [readInput.value], sentinel: label(1) },
      filename(2),
      { method: 'workflowEmbedXmp', args: [record(3), xml(3)], sentinel: label(3) },
      filename(4),
      { method: 'workflowCheckpointXmp', args: [xml(5)], sentinel: label(5) },
      filename(6),
      {
        method: 'workflowCommitXmp',
        args: [
          xml(7),
          JSON.stringify({
            id: `00000000-0000-0000-0000-${String(number * 10 + 7).padStart(12, '0')}`,
            createdAtMs: number * 10 + 7,
            action: 'preset',
            label: label(7),
            adjustmentXmp: checkpoint.value,
          }),
        ],
        sentinel: label(7),
      },
    ];
    return number === 1 ? requests : requests.reverse();
  };
  const results: unknown[] = [];
  const completedWaveHashes: string[] = [];
  try {
    for (const number of [1, 2]) {
      const requests = wave(number);
      const expected = requests.map(sync);
      expect(expected.every((x) => x.ok)).toBe(true);
      expect(expected.every((x, index) => x.ok && x.value.includes(requests[index].sentinel))).toBe(
        true,
      );
      const settled = await Promise.allSettled(
        requests.map((request) => callNative(request.method, request.args as never)),
      );
      results.push({ number, requests, expected, settled });
      completedWaveHashes.push(hash(results.at(-1)));
      console.log('4051 mixed-method wave:', JSON.stringify(results.at(-1)));
      expect(settled.every((x) => x.status === 'fulfilled')).toBe(true);
      expect(
        settled.map((x) => (x.status === 'fulfilled' ? x.value : { error: String(x.reason) })),
      ).toEqual(expected);
    }
    const snapshot = JSON.stringify(results[0]);
    expect(hash(results[0])).toBe(completedWaveHashes[0]);
    // Wave1 results were retained while wave2 reused the worker/native bindings.
    // Compare them again against their independent synchronous references.
    const first = results[0] as {
      expected: WorkflowResult[];
      settled: PromiseSettledResult<WorkflowResult>[];
    };
    expect(first.settled.map((x) => (x.status === 'fulfilled' ? x.value : null))).toEqual(
      first.expected,
    );
    console.log(
      '4051 mixed-method retained:',
      JSON.stringify({
        module: import.meta.resolve('maple'),
        runtime: { bun: Bun.version, platform: process.platform },
        requests: 16,
        completedWaveHashes,
        firstWaveAfterHash: hash(results[0]),
        priorStringsAfterHash: hash(first.settled),
        firstWaveSnapshot: snapshot,
      }),
    );
  } finally {
    shutdownMaplePool();
  }
});
