/**
 * The workflow behind every import row. This file is bundled into Temporal's
 * workflow sandbox, so it may import nothing but `@temporalio/workflow` and types.
 */

import { proxyActivities } from '@temporalio/workflow';
import { ROW_ACTIVITY_OPTIONS, runRow, type RowRun } from '../temporal/row-workflow.ts';
import type { ImportActivities } from './import-activity.ts';

export const IMPORT_TASK_QUEUE = 'maple-imports';

export const importWorkflowId = (importId: string): string => `import-${importId}`;

const { runImport } = proxyActivities<ImportActivities>(ROW_ACTIVITY_OPTIONS);

export async function importWorkflow(importId: string): Promise<RowRun['outcome']> {
  return runRow(() => runImport(importId), 'ImportFailed');
}
