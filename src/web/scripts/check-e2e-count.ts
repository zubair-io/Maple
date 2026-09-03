#!/usr/bin/env bun
// check-e2e-count.ts — assert a Playwright run executed EXACTLY the expected
// number of tests for one spec file in one project (#2451). A required job
// whose test count silently drops to zero (a skip, a renamed file, a project
// filter) is indistinguishable from passing; this makes the count part of
// the gate.
//
// Usage: bun scripts/check-e2e-count.ts <results.json> <spec-basename> <project> <expected>
import { readFileSync } from 'node:fs';

interface JsonResult {
  readonly status: string;
}
interface JsonTest {
  readonly projectName: string;
  readonly status: string;
  readonly results: readonly JsonResult[];
}
interface JsonSpec {
  readonly file: string;
  readonly title: string;
  readonly tests: readonly JsonTest[];
}
interface JsonSuite {
  readonly file?: string;
  readonly specs?: readonly JsonSpec[];
  readonly suites?: readonly JsonSuite[];
}

function collectSpecs(suite: JsonSuite): JsonSpec[] {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(collectSpecs)];
}

/** Passed tests for `specFile` in `project`, with the titles of anything that did not pass. */
function countPassed(
  report: { suites?: readonly JsonSuite[] },
  specFile: string,
  project: string,
): { passed: number; notPassed: string[] } {
  const specs = (report.suites ?? [])
    .flatMap(collectSpecs)
    .filter((s) => s.file.endsWith(specFile));
  const tests = specs.flatMap((s) =>
    s.tests.filter((t) => t.projectName === project).map((t) => ({ title: s.title, test: t })),
  );
  const passed = tests.filter(({ test }) => test.status === 'expected').length;
  const notPassed = tests
    .filter(({ test }) => test.status !== 'expected')
    .map(({ title, test }) => `${title} [${test.status}]`);
  return { passed, notPassed };
}

if (import.meta.main) {
  const [path, specFile, project, expectedArg] = process.argv.slice(2);
  const expected = Number(expectedArg);
  if (!path || !specFile || !project || !Number.isInteger(expected) || expected <= 0) {
    console.error('usage: check-e2e-count.ts <results.json> <spec-basename> <project> <expected>');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(path, 'utf8')) as { suites?: readonly JsonSuite[] };
  const { passed, notPassed } = countPassed(report, specFile, project);
  if (passed !== expected) {
    console.error(
      `FAIL: ${specFile} [${project}] passed ${passed} test(s), expected exactly ${expected}` +
        (notPassed.length ? `\n  not passed:\n  - ${notPassed.join('\n  - ')}` : ''),
    );
    process.exit(1);
  }
  console.log(`OK: ${specFile} [${project}] passed exactly ${expected} test(s)`);
}
