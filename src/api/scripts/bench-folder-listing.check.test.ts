import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  machineKey,
  type BudgetVerdict,
  type ListingBudgetFile,
  type ListingMedians,
  type ListingScenario,
} from './folder-listing-budget.ts';

const overMetrics = (verdict: BudgetVerdict): string[] =>
  verdict.rows.filter((line) => line.over).map((line) => line.metric);

describe('bench-folder-listing.ts --check', () => {
  const SMALL: ListingScenario = {
    photos: 40,
    sidecars: 20,
    indexed: true,
    withThumbs: true,
    runs: 3,
  };
  const LOOSE: ListingMedians = {
    warmMedianMs: 60_000,
    revalidateMedianMs: 60_000,
    limit500MedianMs: 60_000,
  };
  const SMALL_ARGS = ['--photos', '40', '--sidecars', '20', '--runs', '3'];
  const API_ROOT = join(import.meta.dir, '..');

  interface Run {
    exitCode: number;
    stderr: string;
    elapsedMs: number;
    librariesLeft: string[];
    result: {
      budget?: BudgetVerdict;
      warm?: { wallMedian: number };
      revalidate304?: { wallMedian: number };
      limit500?: { wallMedian: number };
    };
  }

  /** The benchmark gets a temp directory of its own, so a library it leaves behind is seen. */
  async function runBench(args: string[], env: Record<string, string> = {}): Promise<Run> {
    const scratch = await mkdtemp(join(tmpdir(), 'maple-listing-check-'));
    try {
      const started = performance.now();
      const child = Bun.spawn(
        ['bun', join(import.meta.dir, 'bench-folder-listing.ts'), '--json', ...args],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, ...env, TMPDIR: scratch },
          timeout: 90_000,
          killSignal: 'SIGKILL',
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (stdout.trim() === '') throw new Error(`the benchmark printed nothing: ${stderr}`);
      return {
        exitCode,
        stderr,
        elapsedMs: performance.now() - started,
        librariesLeft: (await readdir(scratch)).filter((name) => name.startsWith('maple-bench-')),
        result: JSON.parse(stdout) as Run['result'],
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function withTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'maple-listing-fixture-'));
    try {
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const withBudget = <T>(
    limits: Partial<ListingMedians>,
    use: (file: string) => Promise<T>,
    { machine = machineKey(), limit500Images = SMALL.photos } = {},
  ): Promise<T> =>
    withTempDir(async (dir) => {
      const budget: ListingBudgetFile = {
        targetWarmMedianMs: 60_000,
        scenario: SMALL,
        limit500Images,
        machines: { [machine]: { measured: 'a test', ...LOOSE, ...limits } },
      };
      const file = join(dir, 'budget.json');
      await writeFile(file, JSON.stringify(budget));
      return use(file);
    });

  /** An API root with the real library code and `serverSource` in place of the server, which
   * records its process id so the test can see whether it was stopped. */
  const withFakeServer = <T>(
    serverSource: string,
    use: (apiRoot: string, serverPid: () => Promise<number>) => Promise<T>,
  ): Promise<T> =>
    withTempDir(async (root) => {
      const shared = [
        'src/fs/xmp.ts',
        'src/db/sqlite/ddl/index.ts',
        'src/db/sqlite/migrate.ts',
        'src/db/sqlite/migrations/index.ts',
      ];
      await Promise.all(
        shared.map(async (path) => {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(
            join(root, path),
            `export * from ${JSON.stringify(join(API_ROOT, path))};\n`,
          );
        }),
      );
      const pidFile = join(root, 'server.pid');
      await writeFile(
        join(root, 'src/index.ts'),
        `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\n${serverSource}\n`,
      );
      const serverPid = async () => Number(await Bun.file(pidFile).text());
      try {
        return await use(root, serverPid);
      } finally {
        const pid = await serverPid().catch(() => Number.NaN);
        if (Number.isInteger(pid) && running(pid)) process.kill(pid, 'SIGKILL');
      }
    });

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const rounded = (value: number | undefined): number => Number(value!.toFixed(1));

  test('exits 0, judges each row on the median it reports and removes its library', async () => {
    const { exitCode, stderr, result, librariesLeft } = await withBudget({}, (file) =>
      runBench([...SMALL_ARGS, '--check', '--budget', file]),
    );
    expect(exitCode).toBe(0);
    expect(result.budget!.rows.map((line) => [line.metric, line.measuredMs])).toEqual([
      ['warm median vs target', rounded(result.warm?.wallMedian)],
      ['warm median', rounded(result.warm?.wallMedian)],
      ['304 median', rounded(result.revalidate304?.wallMedian)],
      ['limit=500 median', rounded(result.limit500?.wallMedian)],
    ]);
    expect(result.budget!.notJudged).toBeUndefined();
    expect(stderr).toContain('ok    warm median:');
    expect(librariesLeft).toEqual([]);
  }, 120_000);

  test.each([
    ['warmMedianMs', 'warm median'],
    ['revalidateMedianMs', '304 median'],
    ['limit500MedianMs', 'limit=500 median'],
  ] as const)(
    'exits 1 and names the row when %s is over its budget',
    async (key, metric) => {
      const { exitCode, stderr, result } = await withBudget({ [key]: 0.001 }, (file) =>
        runBench([...SMALL_ARGS, '--check', '--budget', file]),
      );
      expect(exitCode).toBe(1);
      expect(overMetrics(result.budget!)).toEqual([metric]);
      expect(stderr).toContain(`OVER  ${metric}:`);
    },
    120_000,
  );

  test('without --check a run over the budget is not judged and exits 0', async () => {
    const { exitCode, result } = await withBudget({ warmMedianMs: 0.001 }, (file) =>
      runBench([...SMALL_ARGS, '--budget', file]),
    );
    expect(exitCode).toBe(0);
    expect(result.budget).toBeUndefined();
  }, 120_000);

  test('exits 2 with only the target row on a machine the budget does not name', async () => {
    const { exitCode, stderr, result } = await withBudget(
      {},
      (file) => runBench([...SMALL_ARGS, '--check', '--budget', file]),
      { machine: 'some-other-machine' },
    );
    expect(exitCode).toBe(2);
    expect(result.budget!.rows.map((line) => line.metric)).toEqual(['warm median vs target']);
    expect(stderr).toContain(`no budget is recorded for "${machineKey()}"`);
  }, 120_000);

  test('exits 2 when the page does not hold the images the budget records', async () => {
    const { exitCode, stderr, result } = await withBudget(
      {},
      (file) => runBench([...SMALL_ARGS, '--check', '--budget', file]),
      { limit500Images: 39 },
    );
    expect(exitCode).toBe(2);
    expect(result.budget!.rows).toEqual([]);
    expect(stderr).toContain('the limit=500 page listed 40 images, not 39');
  }, 120_000);

  test('judges against the committed budget when no file is named', async () => {
    const { exitCode, stderr, result } = await runBench([...SMALL_ARGS, '--check']);
    expect(exitCode).toBe(2);
    expect(result.warm).toBeUndefined();
    expect(stderr).toContain('the budget is for {"photos":2000,');
  }, 120_000);

  test.each([
    [['--photos', '41', '--sidecars', '20', '--runs', '3'], 'photos'],
    [['--photos', '40', '--sidecars', '21', '--runs', '3'], 'sidecars'],
    [['--photos', '40', '--sidecars', '20', '--runs', '4'], 'runs'],
    [[...SMALL_ARGS, '--indexed', 'no'], 'indexed'],
    [[...SMALL_ARGS, '--thumbs', 'no'], 'withThumbs'],
  ])(
    'exits 2 before running when %j is not the budget scenario',
    async (args, named) => {
      const { exitCode, stderr, result } = await withBudget({}, (file) =>
        runBench([...args, '--check', '--budget', file]),
      );
      expect(exitCode).toBe(2);
      expect(result.budget!.rows).toEqual([]);
      expect(result.warm).toBeUndefined();
      expect(stderr).toContain(`differs in ${named}`);
    },
    120_000,
  );

  test('exits 2 when the listing holds entries the scenario does not count', async () => {
    const { exitCode, stderr } = await withBudget({}, (file) =>
      runBench([...SMALL_ARGS, '--edge', '--check', '--budget', file]),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain('images were listed, not 40');
  }, 120_000);

  test.each([
    [['--check', '--budget'], '--budget needs a file'],
    [['--budget', '--check'], '--budget needs a file'],
    [['--check', '--budget', join(tmpdir(), 'maple-no-such-budget.json')], 'is missing or is not'],
  ])(
    'exits 2 before running for %j',
    async (args, reason) => {
      const { exitCode, stderr, result } = await runBench([...SMALL_ARGS, ...args]);
      expect(exitCode).toBe(2);
      expect(result.warm).toBeUndefined();
      expect(stderr).toContain(reason);
    },
    120_000,
  );

  test('exits 2 and leaves no library when the library cannot be built', async () => {
    const { exitCode, stderr, librariesLeft } = await withBudget({}, (file) =>
      runBench([...SMALL_ARGS, '--check', '--budget', file, '--api-root', tmpdir()]),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain('not judged: the benchmark failed:');
    expect(librariesLeft).toEqual([]);
  }, 120_000);

  test('exits 2 at once, with nothing left, when the server dies on start', async () => {
    const { exitCode, stderr, elapsedMs, librariesLeft } = await withFakeServer(
      'process.exit(3);',
      (apiRoot) =>
        withBudget({}, (file) =>
          runBench([...SMALL_ARGS, '--check', '--budget', file, '--api-root', apiRoot]),
        ),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain('the benchmark server did not become ready');
    expect(elapsedMs).toBeLessThan(8_000);
    expect(librariesLeft).toEqual([]);
  }, 120_000);

  test.each([
    ['never listens', 'await Bun.sleep(600_000);', 'did not become ready'],
    [
      'refuses the sign-in',
      `Bun.serve({ port: Number(process.env.PORT), fetch: (request) =>
         new Response(new URL(request.url).pathname === '/api/health' ? 'ok' : 'not json') });`,
      'refused the development sign-in',
    ],
  ])(
    'exits 2 and stops a server that %s',
    async (_, serverSource, reason) => {
      const { run, serverStillRunning } = await withFakeServer(
        serverSource,
        async (apiRoot, serverPid) => {
          const outcome = await withBudget({}, (file) =>
            runBench([...SMALL_ARGS, '--check', '--budget', file, '--api-root', apiRoot]),
          );
          return { run: outcome, serverStillRunning: running(await serverPid()) };
        },
      );
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(reason);
      expect(serverStillRunning).toBe(false);
      expect(run.librariesLeft).toEqual([]);
    },
    120_000,
  );
});
