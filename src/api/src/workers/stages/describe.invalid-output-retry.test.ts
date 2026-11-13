import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObjectId } from '../../db/object-id.ts';
import { DescribeServerPool } from '../../enrichment/describe-server-pool.ts';
import { getDescribeProvider } from '../../enrichment/describe-providers/index.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { describeHandler, setDescribeDepsForTests } from './describe.ts';
import { DESCRIBE_INVALID_OUTPUT_RETRIES } from './describe-parse-retry.ts';
import { VALID_VISION, patchFields, recordingCtx, stageDocIn } from './describe.fixtures.ts';

const BAD_ENUM = JSON.stringify({ ...VALID_VISION, lighting: 'indoor' });
const RETRY_MSG = 'describe: model output failed validation, re-asking';
const STALL_TIMEOUT_MS = 200;
const ANSWER_TIMEOUT_MS = 10_000;

/** An OpenAI-compatible model server answering `/chat/completions` with the
 * queued contents in order (repeating the last), or stalling past the
 * client timeout when `stall` is set. */
function stubModelServer(contents: readonly string[], stall = false) {
  const hits = { count: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch() {
      const content = contents[Math.min(hits.count, contents.length - 1)];
      hits.count += 1;
      if (stall) await Bun.sleep(STALL_TIMEOUT_MS * 5);
      return Response.json({
        model: 'stub-vl',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  return { url: `http://localhost:${server.port}/v1`, hits, stop: () => server.stop(true) };
}

function poolFor(url: string, requestTimeoutMs: number): DescribeServerPool {
  return new DescribeServerPool(
    [{ url, concurrency: 1 }],
    (serverUrl) =>
      getDescribeProvider('openai', {
        url: serverUrl,
        apiKey: 'sk-test',
        requestTimeoutMs,
      }),
    { failureThreshold: 1, openDurationMs: 3_600_000 },
  );
}

let tmpRoot: string;
let libraryId: ObjectId;
let stops: Array<() => void> = [];
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-describe-retry-'));
  libraryId = new ObjectId();
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpRoot]]));
});
afterEach(() => {
  stops.forEach((stop) => stop());
  stops = [];
  rmSync(tmpRoot, { recursive: true, force: true });
  setDescribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

function serve(contents: readonly string[], stall = false) {
  const stub = stubModelServer(contents, stall);
  stops.push(stub.stop);
  const pool = poolFor(stub.url, stall ? STALL_TIMEOUT_MS : ANSWER_TIMEOUT_MS);
  setDescribeDepsForTests({ pool, systemPrompt: 'p', model: 'stub-vl', provider: 'openai' });
  return { hits: stub.hits, pool };
}

const loudLogs = (logged: ReadonlyArray<{ level: string }>) =>
  logged.filter((entry) => entry.level === 'warn' || entry.level === 'error');

describe('describeHandler — invalid model output is re-asked', () => {
  it.each([
    ['an off-list enum', BAD_ENUM],
    ['malformed JSON', '{"is_screenshot": false, "caption": '],
    ['a missing field', JSON.stringify({ ...VALID_VISION, caption: undefined })],
  ])('recovers from %s on the next call without surfacing an error', async (_, invalid) => {
    const { hits } = serve([invalid, JSON.stringify(VALID_VISION)]);
    const { ctx, logged } = recordingCtx();
    const doc = await stageDocIn(join(tmpRoot, 'img.dng'), libraryId, tmpRoot);

    const fields = patchFields(await describeHandler(doc, ctx));

    expect(fields.description).toBe(VALID_VISION.caption);
    expect(hits.count).toBe(2);
    expect(logged.filter((entry) => entry.msg === RETRY_MSG).map((e) => e.level)).toEqual(['info']);
    expect(loudLogs(logged)).toEqual([]);
  });

  it('throws the validation error once every call is invalid', async () => {
    const { hits } = serve([BAD_ENUM]);
    const { ctx, logged } = recordingCtx();
    const doc = await stageDocIn(join(tmpRoot, 'img.dng'), libraryId, tmpRoot);

    await expect(describeHandler(doc, ctx)).rejects.toThrow(
      'vision-parse[bad-enum:lighting]: got "indoor"',
    );

    expect(hits.count).toBe(1 + DESCRIBE_INVALID_OUTPUT_RETRIES);
    expect(logged.filter((entry) => entry.msg === RETRY_MSG)).toHaveLength(
      DESCRIBE_INVALID_OUTPUT_RETRIES,
    );
    expect(loudLogs(logged)).toEqual([]);
  });

  it('does not re-ask after a timeout — the pool and breaker own that', async () => {
    const { hits } = serve([JSON.stringify(VALID_VISION)], true);
    const { ctx, logged } = recordingCtx();
    const doc = await stageDocIn(join(tmpRoot, 'img.dng'), libraryId, tmpRoot);

    await expect(describeHandler(doc, ctx)).rejects.toThrow(
      `OpenAI request timed out after ${STALL_TIMEOUT_MS}ms`,
    );

    expect(hits.count).toBe(1);
    expect(logged.filter((entry) => entry.msg === RETRY_MSG)).toEqual([]);
  });

  it('never counts invalid answers against the server breaker', async () => {
    const { pool } = serve([BAD_ENUM]);
    const doc = await stageDocIn(join(tmpRoot, 'img.dng'), libraryId, tmpRoot);
    await expect(describeHandler(doc, recordingCtx().ctx)).rejects.toThrow('vision-parse');

    // A one-failure breaker with an hour-long open window: had any of those
    // invalid answers been recorded as a failure, this call would park.
    const admitted = pool.run(async () => 'admitted');
    const parked = Bun.sleep(1_000).then(() => 'parked');
    expect(await Promise.race([admitted, parked])).toBe('admitted');
  });
});
