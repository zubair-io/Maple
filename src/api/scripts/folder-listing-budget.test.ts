import { describe, expect, test } from 'bun:test';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuSecondsFromStat } from './bench-library-server.ts';
import {
  budgetFileProblem,
  DEFAULT_BUDGET_FILE,
  describeVerdict,
  judgeListing,
  machineKey,
  observeListing,
  readBudgetFile,
  verdictExitCode,
  type BudgetVerdict,
  type ListingBudgetFile,
  type ListingMedians,
  type ListingResponses,
  type ListingScenario,
} from './folder-listing-budget.ts';

const SCENARIO: ListingScenario = {
  photos: 2000,
  sidecars: 1000,
  indexed: true,
  withThumbs: true,
  runs: 30,
};
const BUDGET: ListingBudgetFile = {
  targetWarmMedianMs: 100,
  scenario: SCENARIO,
  limit500Images: 333,
  machines: {
    'test-machine': {
      measured: 'a test',
      warmMedianMs: 50,
      revalidateMedianMs: 48,
      limit500MedianMs: 14,
    },
  },
};
const RIGHT: ListingResponses = {
  warmStatus: 200,
  revalidateStatus: 304,
  limit500Status: 200,
  imagesListed: 2000,
  limit500Listed: 333,
};
const WITHIN: ListingMedians = { warmMedianMs: 46, revalidateMedianMs: 44, limit500MedianMs: 12 };

const overMetrics = (verdict: BudgetVerdict): string[] =>
  verdict.rows.filter((line) => line.over).map((line) => line.metric);

const judge = (
  change: {
    budget?: ListingBudgetFile;
    machine?: string;
    scenario?: Partial<ListingScenario>;
    responses?: Partial<ListingResponses>;
    measured?: Partial<ListingMedians>;
  } = {},
): BudgetVerdict =>
  judgeListing(
    change.budget ?? BUDGET,
    change.machine ?? 'test-machine',
    { ...SCENARIO, ...change.scenario },
    { ...RIGHT, ...change.responses },
    { ...WITHIN, ...change.measured },
  );

describe('judgeListing', () => {
  test('a run inside every limit passes with all four rows', () => {
    const verdict = judge();
    expect(verdict.rows.map((line) => [line.metric, line.measuredMs, line.limitMs])).toEqual([
      ['warm median vs target', 46, 100],
      ['warm median', 46, 50],
      ['304 median', 44, 48],
      ['limit=500 median', 12, 14],
    ]);
    expect(overMetrics(verdict)).toEqual([]);
    expect(verdict.notJudged).toBeUndefined();
    expect(verdictExitCode(verdict)).toBe(0);
  });

  test('a run exactly on its limits passes', () => {
    const onLimit = { warmMedianMs: 50, revalidateMedianMs: 48, limit500MedianMs: 14 };
    expect(verdictExitCode(judge({ measured: onLimit }))).toBe(0);
  });

  test.each([
    ['warmMedianMs', 50.1, 'warm median'],
    ['revalidateMedianMs', 48.1, '304 median'],
    ['limit500MedianMs', 14.1, 'limit=500 median'],
  ] as const)('%s over its limit fails that row only', (key, value, metric) => {
    const verdict = judge({ measured: { [key]: value } });
    expect(overMetrics(verdict)).toEqual([metric]);
    expect(verdictExitCode(verdict)).toBe(1);
    expect(describeVerdict(verdict)).toContain(`OVER  ${metric}: ${value} ms (limit`);
  });

  test('the printed value and the verdict agree at the rounding edge', () => {
    const verdict = judge({ measured: { warmMedianMs: 50.04 } });
    expect(overMetrics(verdict)).toEqual([]);
    expect(describeVerdict(verdict)).toContain('ok    warm median: 50 ms (limit 50 ms)');
    expect(overMetrics(judge({ measured: { warmMedianMs: 50.06 } }))).toEqual(['warm median']);
  });

  test('a median that is not a number is over, never a pass', () => {
    const verdict = judge({ measured: { revalidateMedianMs: Number.NaN } });
    expect(overMetrics(verdict)).toEqual(['304 median']);
    expect(verdictExitCode(verdict)).toBe(1);
  });

  test('the product target fails a run even when the machine budget is looser', () => {
    const loose: ListingBudgetFile = {
      ...BUDGET,
      machines: { 'test-machine': { ...BUDGET.machines['test-machine']!, warmMedianMs: 500 } },
    };
    const verdict = judge({ budget: loose, measured: { warmMedianMs: 120 } });
    expect(overMetrics(verdict)).toEqual(['warm median vs target']);
    expect(verdictExitCode(verdict)).toBe(1);
  });

  test('a machine with no recorded budget is still held to the target', () => {
    const met = judge({ machine: 'other-machine' });
    expect(met.rows.map((line) => line.metric)).toEqual(['warm median vs target']);
    expect(describeVerdict(met)).toContain('no budget is recorded for "other-machine"');
    expect(verdictExitCode(met)).toBe(2);
    const missed = judge({ machine: 'other-machine', measured: { warmMedianMs: 100.1 } });
    expect(overMetrics(missed)).toEqual(['warm median vs target']);
    expect(verdictExitCode(missed)).toBe(1);
  });

  const OTHER_SCENARIOS: Array<[Partial<ListingScenario>, string]> = [
    [{ photos: 500 }, 'photos'],
    [{ sidecars: 0 }, 'sidecars'],
    [{ indexed: false }, 'indexed'],
    [{ withThumbs: false }, 'withThumbs'],
    [{ runs: 5 }, 'runs'],
  ];
  test.each(OTHER_SCENARIOS)('a run of another scenario %j is not judged', (change, named) => {
    const verdict = judge({ scenario: change, responses: { imagesListed: change.photos ?? 2000 } });
    expect(verdict.rows).toEqual([]);
    expect(describeVerdict(verdict)).toContain(`differs in ${named}`);
    expect(verdictExitCode(verdict)).toBe(2);
  });

  test.each([
    [{ warmStatus: 500 }, 'the warm request answered 500'],
    [{ revalidateStatus: 200 }, 'the revalidation answered 200'],
    [{ limit500Status: 404 }, 'the limit=500 page answered 404'],
    [{ imagesListed: 0 }, '0 images were listed, not 2000'],
    [{ imagesListed: 1999 }, '1999 images were listed, not 2000'],
    [{ limit500Listed: 0 }, 'the limit=500 page listed 0 images, not 333'],
    [{ limit500Listed: 332 }, 'the limit=500 page listed 332 images, not 333'],
    [{ limit500Listed: 334 }, 'the limit=500 page listed 334 images, not 333'],
  ] as const)('a run whose responses were wrong %j is not judged', (change, reason) => {
    const verdict = judge({ responses: change });
    expect(verdict.rows).toEqual([]);
    expect(describeVerdict(verdict)).toContain(reason);
    expect(verdictExitCode(verdict)).toBe(2);
  });
});

describe('observeListing', () => {
  const timed = (status: number, ...wallMs: number[]) =>
    wallMs.map((ms) => ({ status, wallMs: ms }));
  const RUN = {
    warm: timed(200, 40, 50, 60),
    revalidate: timed(304, 4, 5, 6),
    page: timed(200, 0.4, 0.5, 0.6),
  };

  test('takes each median from its own samples and the counts as given', () => {
    expect(observeListing(RUN, { images: 2000, pageImages: 333 })).toEqual({
      responses: { ...RIGHT, imagesListed: 2000, limit500Listed: 333 },
      medians: { warmMedianMs: 50, revalidateMedianMs: 5, limit500MedianMs: 0.5 },
    });
  });

  test.each([
    ['warm', 500, 'warmStatus'],
    ['revalidate', 200, 'revalidateStatus'],
    ['page', 404, 'limit500Status'],
  ] as const)('one wrong %s answer after the first is reported', (kind, status, key) => {
    const samples = [...RUN[kind].slice(0, 2), { status, wallMs: 1 }];
    const { responses } = observeListing({ ...RUN, [kind]: samples }, { images: 1, pageImages: 1 });
    expect(responses[key]).toBe(status);
  });

  test('a run with no samples has no median to pass on', () => {
    const { medians } = observeListing(
      { warm: [], revalidate: [], page: [] },
      { images: 0, pageImages: 0 },
    );
    expect(medians.warmMedianMs).toBeNaN();
  });
});

describe('cpuSecondsFromStat', () => {
  test('reads user and system ticks past a process name holding spaces and brackets', () => {
    const stat = '4242 (bun (worker) 1) S 1 4242 4242 0 -1 4194304 900 0 0 0 150 75 0 0 20 0 9 0 1';
    expect(cpuSecondsFromStat(stat)).toBe(2.25);
  });
});

describe('budgetFileProblem', () => {
  const without = (path: string[]): unknown => {
    const copy = structuredClone(BUDGET) as unknown as Record<string, unknown>;
    const parent = path.slice(0, -1).reduce((at, key) => at[key] as Record<string, unknown>, copy);
    delete parent[path.at(-1)!];
    return copy;
  };

  test('accepts a complete budget', () => {
    expect(budgetFileProblem(BUDGET)).toBeNull();
  });

  test.each([
    [['targetWarmMedianMs'], 'targetWarmMedianMs'],
    [['scenario'], 'scenario is missing'],
    [['scenario', 'runs'], 'scenario lacks runs'],
    [['limit500Images'], 'limit500Images'],
    [['machines'], 'machines is missing'],
    [['machines', 'test-machine', 'warmMedianMs'], 'test-machine.warmMedianMs'],
    [['machines', 'test-machine', 'revalidateMedianMs'], 'test-machine.revalidateMedianMs'],
    [['machines', 'test-machine', 'limit500MedianMs'], 'test-machine.limit500MedianMs'],
  ])('names a budget missing %j', (path, named) => {
    expect(budgetFileProblem(without(path))).toContain(named);
  });

  test.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], ['51'], [null]])(
    'rejects a limit of %p',
    (limit) => {
      const broken = structuredClone(BUDGET) as unknown as {
        machines: Record<string, Record<string, unknown>>;
      };
      broken.machines['test-machine']!.warmMedianMs = limit;
      expect(budgetFileProblem(broken)).toContain('test-machine.warmMedianMs');
    },
  );

  test.each([[null], [51], ['51'], [[51, 49, 14]]])('rejects a machine entry of %p', (entry) => {
    const broken = { ...BUDGET, machines: { 'test-machine': entry } };
    expect(budgetFileProblem(broken)).toContain('test-machine.warmMedianMs');
  });

  test('refuses an entry for a machine that reports no CPU model', () => {
    const unnamed = { ...BUDGET, machines: { [machineKey('')]: BUDGET.machines['test-machine'] } };
    expect(budgetFileProblem(unnamed)).toContain('cannot hold a budget');
  });

  test.each([[null], [[]], ['budget'], [7]])('rejects a file that is %p', (parsed) => {
    expect(budgetFileProblem(parsed)).toBe('the budget file is not a JSON object');
  });
});

describe('the committed budget', () => {
  test('is readable, covers the 2,000-photo scenario and stays under the target', async () => {
    const read = await readBudgetFile(DEFAULT_BUDGET_FILE);
    if ('problem' in read) throw new Error(read.problem);
    const committed = read.budget;
    expect(committed.targetWarmMedianMs).toBe(100);
    expect(committed.scenario).toEqual(SCENARIO);
    expect(committed.limit500Images).toBe(333);
    const machines = Object.entries(committed.machines);
    expect(machines.map(([name]) => name)).toContain('darwin-arm64 Apple M5 Max');
    for (const [name, limits] of machines) {
      expect(name).toMatch(/^(darwin|linux)-(arm64|x64) \S/);
      expect(limits.measured.length).toBeGreaterThan(0);
      expect(limits.warmMedianMs).toBeLessThan(committed.targetWarmMedianMs);
    }
  });

  test('a missing file is a problem, not a crash', async () => {
    const read = await readBudgetFile(join(tmpdir(), `no-such-budget-${crypto.randomUUID()}.json`));
    expect('problem' in read && read.problem).toContain('is missing or is not JSON');
  });

  test('the machine key names the platform, the architecture and the CPU model', () => {
    const prefix = `${process.platform}-${process.arch}`;
    expect(machineKey('Some CPU 9000')).toBe(`${prefix} Some CPU 9000`);
    expect(machineKey(' Padded Model ')).toBe(`${prefix} Padded Model`);
    expect(machineKey()).toBe(machineKey(cpus()[0]?.model));
  });

  test.each([[''], ['  '], ['unknown'], ['Unknown']])(
    'a CPU model of %p shares the key no budget may use',
    (model) => {
      expect(machineKey(model)).toBe(`${process.platform}-${process.arch} unknown CPU`);
    },
  );
});
