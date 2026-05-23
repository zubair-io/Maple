/**
 * Face-clustering quality harness — runs the pure `clusterEmbeddings`
 * core over a labelled fixture set and scores it against committed
 * budgets.
 *
 * Mirrors the color-pipeline harness pattern:
 *   - JSONL fixture is the contract (`test-fixtures/face-clustering/embeddings.jsonl`).
 *   - Committed budgets in `test-fixtures/face-clustering/budgets.json`.
 *   - One-way ratchet: budgets can only get tighter.
 *   - Skip-pass behaviour is driven by the shell wrapper
 *     (`src/scripts/test_face_clustering.sh`) — if the fixture file is
 *     missing, the wrapper exits 0 without invoking this script.
 *
 * Standalone — no Mongo, no Elysia bootstrap. Run via:
 *
 *     bun src/api/src/people/clustering-quality-harness.ts \\
 *         --fixtures test-fixtures/face-clustering/embeddings.jsonl \\
 *         --budgets  test-fixtures/face-clustering/budgets.json
 *
 * Exit codes:
 *   0  — all budgets met
 *   1  — at least one budget breached
 *   2  — input error (fixture file unreadable, etc.)
 */

import { readFileSync, existsSync } from 'node:fs';
// Import the pure clustering core directly so the harness doesn't load
// the Mongo client / pino logger chain (`clustering-job.ts` pulls those
// in transitively). The pure module has no I/O.
import { clusterEmbeddings } from './cluster-embeddings.ts';
import { allMetrics, type ClusteringMetrics } from './clustering-metrics.ts';

interface FixtureRow {
  embedding: number[];
  identity: string;
  asset_id: string;
  face_index: number;
}

interface Budgets {
  // Floors — clustering must meet OR EXCEED each threshold.
  purity_min: number;
  nmi_min: number;
  v_measure_min: number;
  ari_min: number;
  recall_at_1_min: number;
  /** Free-form notes (e.g. "synthetic — real LFW will differ"). */
  notes?: string;
  /** What mode the fixtures were generated in. */
  fixtures_mode?: 'synthetic' | 'lfw';
  /** Optional similarity threshold to pass into clustering. Default
   * matches the production runtime (0.5). */
  similarity_threshold?: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function fail(msg: string, code = 2): never {
  console.error(`clustering-quality-harness: ${msg}`);
  process.exit(code);
}

function loadFixtures(path: string): FixtureRow[] {
  if (!existsSync(path)) fail(`fixture file not found: ${path}`, 2);
  const text = readFileSync(path, 'utf8');
  const rows: FixtureRow[] = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    let row: FixtureRow;
    try {
      row = JSON.parse(line);
    } catch (e) {
      fail(`bad JSON on line ${lineNo}: ${e}`, 2);
    }
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
      fail(`row ${lineNo}: missing or empty embedding`, 2);
    }
    if (typeof row.identity !== 'string' || row.identity.length === 0) {
      fail(`row ${lineNo}: missing identity`, 2);
    }
    rows.push(row);
  }
  if (rows.length === 0) fail(`no rows in ${path}`, 2);
  // Sanity: every embedding must be the same length (no mixed-dim
  // fixtures, no truncated rows).
  const dim = rows[0].embedding.length;
  for (const r of rows) {
    if (r.embedding.length !== dim) {
      fail(
        `mixed embedding dimensions: row ${r.asset_id} has ${r.embedding.length}, expected ${dim}`,
        2,
      );
    }
  }
  return rows;
}

function loadBudgets(path: string): Budgets {
  if (!existsSync(path)) fail(`budgets file not found: ${path}`, 2);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Budgets;
  const required: (keyof Budgets)[] = [
    'purity_min',
    'nmi_min',
    'v_measure_min',
    'ari_min',
    'recall_at_1_min',
  ];
  for (const k of required) {
    if (typeof raw[k] !== 'number') fail(`budgets.json missing numeric ${String(k)}`, 2);
  }
  return raw;
}

function runHarness(fixturesPath: string, budgetsPath: string): number {
  const rows = loadFixtures(fixturesPath);
  const budgets = loadBudgets(budgetsPath);

  const embeddings = rows.map((r) => Float32Array.from(r.embedding));
  const truth = rows.map((r) => r.identity);

  const threshold = budgets.similarity_threshold;
  const t0 = performance.now();
  const result = clusterEmbeddings(
    embeddings,
    threshold !== undefined ? { similarityThreshold: threshold } : {},
  );
  const elapsedMs = performance.now() - t0;

  const metrics = allMetrics(result.assignments, truth);

  const report = {
    fixtures: fixturesPath,
    budgets: budgetsPath,
    n: metrics.n,
    n_clusters_pred: metrics.n_clusters_pred,
    n_classes_true: metrics.n_classes_true,
    similarity_threshold: threshold ?? 'default',
    elapsed_ms: Number(elapsedMs.toFixed(2)),
    metrics: {
      purity: metrics.purity,
      nmi: metrics.nmi,
      v_measure: metrics.v_measure,
      ari: metrics.ari,
      recall_at_1: metrics.recall_at_1,
    },
    budgets_floor: {
      purity_min: budgets.purity_min,
      nmi_min: budgets.nmi_min,
      v_measure_min: budgets.v_measure_min,
      ari_min: budgets.ari_min,
      recall_at_1_min: budgets.recall_at_1_min,
    },
    notes: budgets.notes ?? null,
  } as const;

  const breaches: string[] = [];
  const check = (name: string, value: number, floor: number) => {
    if (value < floor) breaches.push(`${name} ${value.toFixed(4)} < floor ${floor.toFixed(4)}`);
  };
  check('purity', metrics.purity, budgets.purity_min);
  check('nmi', metrics.nmi, budgets.nmi_min);
  check('v_measure', metrics.v_measure, budgets.v_measure_min);
  check('ari', metrics.ari, budgets.ari_min);
  check('recall_at_1', metrics.recall_at_1, budgets.recall_at_1_min);

  // Pretty table on stderr for humans (matches color-pipeline output style).
  const fmt = (v: number, w = 7) => v.toFixed(4).padStart(w);
  console.error(
    `face-clustering: n=${metrics.n} (${metrics.n_classes_true} identities) → ${metrics.n_clusters_pred} clusters in ${report.elapsed_ms}ms`,
  );
  console.error(`  metric        value     floor     verdict`);
  console.error(
    `  purity      ${fmt(metrics.purity)}  ${fmt(budgets.purity_min)}  ${metrics.purity >= budgets.purity_min ? 'PASS' : 'FAIL'}`,
  );
  console.error(
    `  nmi         ${fmt(metrics.nmi)}  ${fmt(budgets.nmi_min)}  ${metrics.nmi >= budgets.nmi_min ? 'PASS' : 'FAIL'}`,
  );
  console.error(
    `  v_measure   ${fmt(metrics.v_measure)}  ${fmt(budgets.v_measure_min)}  ${metrics.v_measure >= budgets.v_measure_min ? 'PASS' : 'FAIL'}`,
  );
  console.error(
    `  ari         ${fmt(metrics.ari)}  ${fmt(budgets.ari_min)}  ${metrics.ari >= budgets.ari_min ? 'PASS' : 'FAIL'}`,
  );
  console.error(
    `  recall@1    ${fmt(metrics.recall_at_1)}  ${fmt(budgets.recall_at_1_min)}  ${metrics.recall_at_1 >= budgets.recall_at_1_min ? 'PASS' : 'FAIL'}`,
  );

  // Single-line JSON on stdout (CI scrapers can grep it).
  process.stdout.write(JSON.stringify({ ...report, breaches }) + '\n');

  if (breaches.length > 0) {
    console.error(`face-clustering: ${breaches.length} budget breach(es):`);
    for (const b of breaches) console.error(`  - ${b}`);
    return 1;
  }
  console.error('face-clustering: all budgets met');
  return 0;
}

function captureBudgetSuggestion(fixturesPath: string, threshold?: number, margin = 0.03): number {
  // Helper mode: capture current numbers and print a budgets.json block
  // with the requested margin below them. Lets bootstrap of new fixtures
  // be one command. Threshold falls back to whatever the algorithm uses.
  const rows = loadFixtures(fixturesPath);
  const embeddings = rows.map((r) => Float32Array.from(r.embedding));
  const truth = rows.map((r) => r.identity);
  const result = clusterEmbeddings(
    embeddings,
    threshold !== undefined ? { similarityThreshold: threshold } : {},
  );
  const m: ClusteringMetrics = allMetrics(result.assignments, truth);
  const floor = (v: number) => Math.max(0, +(v - margin).toFixed(4));
  const block = {
    purity_min: floor(m.purity),
    nmi_min: floor(m.nmi),
    v_measure_min: floor(m.v_measure),
    ari_min: floor(m.ari),
    recall_at_1_min: floor(m.recall_at_1),
    similarity_threshold: threshold ?? 0.5,
    fixtures_mode: 'synthetic',
    notes:
      'Initial budgets seeded from a synthetic-mode fixture run. Real-LFW fixtures will produce different numbers — re-seed when LFW embeddings are committed.',
  };
  console.error('# suggested budgets.json content (margin = -' + margin + ' below current):');
  console.error(
    `# measured: purity=${m.purity.toFixed(4)} nmi=${m.nmi.toFixed(4)} v=${m.v_measure.toFixed(4)} ari=${m.ari.toFixed(4)} recall@1=${m.recall_at_1.toFixed(4)}`,
  );
  process.stdout.write(JSON.stringify(block, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const fixturesPath = args.fixtures ?? 'test-fixtures/face-clustering/embeddings.jsonl';
const budgetsPath = args.budgets ?? 'test-fixtures/face-clustering/budgets.json';

if (args['suggest-budgets'] === 'true') {
  const threshold = args.threshold !== undefined ? Number(args.threshold) : undefined;
  const margin = args.margin !== undefined ? Number(args.margin) : 0.03;
  process.exit(captureBudgetSuggestion(fixturesPath, threshold, margin));
}

process.exit(runHarness(fixturesPath, budgetsPath));
