import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomatedSessionFailedError } from '@google/jules-sdk';
import { pollForReview } from '../src/cleanup.ts';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('manual recovery can import lifecycle helpers without action dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maple-jules-recovery-'));
  try {
    const modulePath = join(directory, 'cleanup.ts');
    await copyFile(new URL('../src/cleanup.ts', import.meta.url), modulePath);
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { isFinalReview, verifyPublishedSession, publishThenDelete } from ${JSON.stringify(modulePath)};
       if (!isFinalReview('completed', 'VERDICT: approve')) throw new Error('Invalid verdict');
       if (typeof verifyPublishedSession !== 'function' || typeof publishThenDelete !== 'function') throw new Error('Missing recovery helpers');
       console.log('Recovery import passed');`,
    ]);
    assert.match(stdout, /Recovery import passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function reviewSession({ state = 'inProgress', messages = [], info, hydrate, history } = {}) {
  return {
    id: '2076358440166838858',
    info: info ?? (async () => ({ state })),
    activities: { hydrate: hydrate ?? (async () => 0) },
    history:
      history ??
      async function* () {
        for (const message of messages) yield { type: 'agentMessaged', message };
      },
  };
}

function fastClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
}

async function advancePolling(t) {
  // Allow the asynchronous SDK calls/history iterator to settle before each timer tick.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(20_000);
  }
}

test('failed state stops immediately before hydrating activities', async (t) => {
  fastClock(t);
  const result = assert.rejects(
    pollForReview(
      reviewSession({ state: 'failed', hydrate: async () => assert.fail('Must not hydrate') }),
      60_000,
    ),
    /session 2076358440166838858 failed/,
  );
  await advancePolling(t);
  await result;
});

for (const operation of ['info', 'hydrate', 'history']) {
  test(`SDK terminal failure from ${operation} stops polling with the session ID`, async (t) => {
    fastClock(t);
    let calls = 0;
    const fail = () => {
      calls++;
      throw new AutomatedSessionFailedError('upstream session failure');
    };
    const overrides =
      operation === 'history'
        ? {
            history: async function* () {
              fail();
            },
          }
        : { [operation]: async () => fail() };
    const result = assert.rejects(
      pollForReview(reviewSession(overrides), 60_000),
      /session 2076358440166838858 failed/,
    );
    await advancePolling(t);
    await result;
    assert.equal(calls, 1);
  });
}

test('failure observed after history cannot publish an apparent approval', async (t) => {
  fastClock(t);
  let reads = 0;
  const result = assert.rejects(
    pollForReview(
      reviewSession({
        info: async () => ({ state: ++reads === 1 ? 'inProgress' : 'failed' }),
        messages: ['VERDICT: approve'],
      }),
      60_000,
    ),
    /session 2076358440166838858 failed/,
  );
  await advancePolling(t);
  await result;
});

for (const verdict of ['approve', 'comment', 'block']) {
  test(`completed ${verdict} review returns the latest agent message`, async () => {
    const final = `Findings\nVERDICT: ${verdict}`;
    assert.equal(
      await pollForReview(
        reviewSession({ state: 'completed', messages: ['Progress', final] }),
        60_000,
      ),
      final,
    );
  });
}

for (const operation of ['info', 'hydrate', 'history']) {
  test(`transient ${operation} failure retries and can finish`, async (t) => {
    fastClock(t);
    let calls = 0;
    const overrides = {
      state: 'completed',
      messages: ['VERDICT: approve'],
      [operation]:
        operation === 'history'
          ? async function* () {
              if (++calls === 1) throw new Error('HTTP 503 unavailable');
              yield { type: 'agentMessaged', message: 'VERDICT: approve' };
            }
          : async () => {
              if (++calls === 1) throw new Error('HTTP 503 unavailable');
              return operation === 'info' ? { state: 'completed' } : 0;
            },
    };
    const result = pollForReview(reviewSession(overrides), 60_000);
    await advancePolling(t);
    assert.equal(await result, 'VERDICT: approve');
    assert.equal(calls, 2);
  });
}

for (const status of [401, 403]) {
  test(`authentication HTTP ${status} fails immediately`, async () => {
    await assert.rejects(
      pollForReview(
        reviewSession({
          info: async () => {
            throw new Error(`HTTP ${status} denied`);
          },
        }),
        60_000,
      ),
      /Jules API rejected request/,
    );
  });
}

for (const state of ['inProgress', 'completed']) {
  test(`${state} without a final completed verdict times out`, async (t) => {
    fastClock(t);
    const result = pollForReview(
      reviewSession({
        state,
        messages: [state === 'inProgress' ? 'VERDICT: approve' : 'Progress'],
      }),
      60_000,
    );
    await advancePolling(t);
    assert.equal(await result, '');
  });
}

test('a numeric session ID in a transient error is not mistaken for HTTP 401', async (t) => {
  fastClock(t);
  let calls = 0;
  const result = pollForReview(
    reviewSession({
      state: 'completed',
      messages: ['VERDICT: approve'],
      hydrate: async () => {
        if (++calls === 1) throw new Error('Session 2076358440166838858 temporarily unavailable');
        return 0;
      },
    }),
    60_000,
  );
  await advancePolling(t);
  assert.equal(await result, 'VERDICT: approve');
  assert.equal(calls, 2);
});
