/**
 * The regression budget for `bench-folder-listing.ts --check`: the product target every machine
 * must meet, plus medians a run must stay under on the machine the budget was recorded on.
 */
import { cpus } from 'node:os';
import { join } from 'node:path';

export interface ListingScenario {
  photos: number;
  sidecars: number;
  indexed: boolean;
  withThumbs: boolean;
  runs: number;
}

export interface ListingMedians {
  warmMedianMs: number;
  revalidateMedianMs: number;
  limit500MedianMs: number;
}

/** What the requests answered, so a listing that got fast by breaking is not judged. */
export interface ListingResponses {
  warmStatus: number;
  revalidateStatus: number;
  limit500Status: number;
  imagesListed: number;
  limit500Listed: number;
}

interface TimedResponse {
  status: number;
  wallMs: number;
}

interface MachineBudget extends ListingMedians {
  measured: string;
}

export interface ListingBudgetFile {
  targetWarmMedianMs: number;
  scenario: ListingScenario;
  /** How many images the scenario's `?limit=500` page holds: fewer or more is a broken page. */
  limit500Images: number;
  machines: Record<string, MachineBudget>;
}

interface BudgetRow {
  metric: string;
  measuredMs: number;
  limitMs: number;
  over: boolean;
}

export interface BudgetVerdict {
  machine: string;
  rows: BudgetRow[];
  notJudged?: string;
}

export const DEFAULT_BUDGET_FILE = join(import.meta.dir, 'folder-listing-budget.json');

const UNKNOWN_CPU = 'unknown CPU';

/** Timings only compare on the same hardware, so a budget entry names the CPU as well. Some
 * systems report no model; they share one key, which no budget entry may use. */
export function machineKey(model: string | undefined = cpus()[0]?.model): string {
  const named = model?.trim() ?? '';
  const cpu = named === '' || named.toLowerCase() === 'unknown' ? UNKNOWN_CPU : named;
  return `${process.platform}-${process.arch} ${cpu}`;
}

const SCENARIO_KEYS = ['photos', 'sidecars', 'indexed', 'withThumbs', 'runs'] as const;
const MEDIAN_KEYS = ['warmMedianMs', 'revalidateMedianMs', 'limit500MedianMs'] as const;

const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns what is wrong with a parsed budget file, or null when it can be judged against. */
export function budgetFileProblem(parsed: unknown): string | null {
  if (!isRecord(parsed)) return 'the budget file is not a JSON object';
  if (!isLimit(parsed.targetWarmMedianMs)) return 'targetWarmMedianMs is not a positive number';
  const scenario = parsed.scenario;
  if (!isRecord(scenario)) return 'scenario is missing';
  const missing = SCENARIO_KEYS.filter((key) => scenario[key] === undefined);
  if (missing.length > 0) return `scenario lacks ${missing.join(', ')}`;
  if (!isLimit(parsed.limit500Images)) return 'limit500Images is not a positive number';
  if (!isRecord(parsed.machines)) return 'machines is missing';
  const unnamed = Object.keys(parsed.machines).filter((name) => name.endsWith(UNKNOWN_CPU));
  if (unnamed.length > 0) return `a machine with no CPU model cannot hold a budget: ${unnamed[0]}`;
  const broken = Object.entries(parsed.machines).flatMap(([name, limits]) =>
    MEDIAN_KEYS.filter((key) => !isRecord(limits) || !isLimit(limits[key])).map(
      (key) => `${name}.${key}`,
    ),
  );
  return broken.length > 0 ? `not a positive number: ${broken.join(', ')}` : null;
}

export async function readBudgetFile(
  file: string,
): Promise<{ budget: ListingBudgetFile } | { problem: string }> {
  const parsed: unknown = await Bun.file(file)
    .json()
    .catch(() => undefined);
  if (parsed === undefined) return { problem: `${file} is missing or is not JSON` };
  const problem = budgetFileProblem(parsed);
  return problem === null ? { budget: parsed as ListingBudgetFile } : { problem };
}

export function scenarioProblem(
  budget: ListingBudgetFile,
  scenario: ListingScenario,
): string | null {
  const differing = SCENARIO_KEYS.filter((key) => scenario[key] !== budget.scenario[key]);
  return differing.length > 0
    ? `the budget is for ${JSON.stringify(budget.scenario)}; this run differs in ${differing.join(', ')}`
    : null;
}

function responsesProblem(budget: ListingBudgetFile, responses: ListingResponses): string | null {
  const { scenario } = budget;
  const wrong = [
    responses.warmStatus === 200 ? null : `the warm request answered ${responses.warmStatus}`,
    responses.revalidateStatus === 304
      ? null
      : `the revalidation answered ${responses.revalidateStatus}`,
    responses.limit500Status === 200
      ? null
      : `the limit=500 page answered ${responses.limit500Status}`,
    responses.imagesListed === scenario.photos
      ? null
      : `${responses.imagesListed} images were listed, not ${scenario.photos}`,
    responses.limit500Listed === budget.limit500Images
      ? null
      : `the limit=500 page listed ${responses.limit500Listed} images, not ${budget.limit500Images}`,
  ].filter((problem) => problem !== null);
  return wrong.length > 0 ? wrong.join('; ') : null;
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

const statusOf = (samples: TimedResponse[], expected: number): number =>
  samples.find((sample) => sample.status !== expected)?.status ?? expected;

/** The medians and the response facts of one run, from every timed sample rather than the first. */
export function observeListing(
  timed: { warm: TimedResponse[]; revalidate: TimedResponse[]; page: TimedResponse[] },
  listed: { images: number; pageImages: number },
): { responses: ListingResponses; medians: ListingMedians } {
  return {
    responses: {
      warmStatus: statusOf(timed.warm, 200),
      revalidateStatus: statusOf(timed.revalidate, 304),
      limit500Status: statusOf(timed.page, 200),
      imagesListed: listed.images,
      limit500Listed: listed.pageImages,
    },
    medians: {
      warmMedianMs: median(timed.warm.map((sample) => sample.wallMs)),
      revalidateMedianMs: median(timed.revalidate.map((sample) => sample.wallMs)),
      limit500MedianMs: median(timed.page.map((sample) => sample.wallMs)),
    },
  };
}

const row = (metric: string, measuredMs: number, limitMs: number): BudgetRow => {
  const shown = Number(measuredMs.toFixed(1));
  return { metric, measuredMs: shown, limitMs, over: !(shown <= limitMs) };
};

export function judgeListing(
  budget: ListingBudgetFile,
  machine: string,
  scenario: ListingScenario,
  responses: ListingResponses,
  measured: ListingMedians,
): BudgetVerdict {
  const unusable = scenarioProblem(budget, scenario) ?? responsesProblem(budget, responses);
  if (unusable !== null) return { machine, rows: [], notJudged: unusable };
  const target = row('warm median vs target', measured.warmMedianMs, budget.targetWarmMedianMs);
  const limits = budget.machines[machine];
  if (!limits) {
    return {
      machine,
      rows: [target],
      notJudged: `no budget is recorded for "${machine}"; measure it while idle and add an entry`,
    };
  }
  return {
    machine,
    rows: [
      target,
      row('warm median', measured.warmMedianMs, limits.warmMedianMs),
      row('304 median', measured.revalidateMedianMs, limits.revalidateMedianMs),
      row('limit=500 median', measured.limit500MedianMs, limits.limit500MedianMs),
    ],
  };
}

export const describeVerdict = (verdict: BudgetVerdict): string =>
  [
    ...verdict.rows.map(
      (line) =>
        `${line.over ? 'OVER ' : 'ok   '} ${line.metric}: ${line.measuredMs} ms (limit ${line.limitMs} ms)`,
    ),
    ...(verdict.notJudged === undefined ? [] : [`not judged: ${verdict.notJudged}`]),
  ].join('\n');

export const verdictExitCode = (verdict: BudgetVerdict): number =>
  verdict.rows.some((line) => line.over) ? 1 : verdict.notJudged === undefined ? 0 : 2;
