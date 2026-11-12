import { runAttempt } from '../temporal/activity-attempt.ts';
import type { RowRun } from '../temporal/row-workflow.ts';
import { ImportRunner, type ImportRunnerConfig } from './worker.ts';

export interface ImportActivities {
  runImport: (importId: string) => Promise<RowRun>;
}

export function createImportActivities(config: ImportRunnerConfig = {}): ImportActivities {
  const runner = new ImportRunner(config);
  return { runImport: (importId) => runAttempt((attempt) => runner.run(importId, attempt)) };
}
