import { ObjectId } from '../db/object-id.ts';
import type { RowQueue, TemporalLane } from '../temporal/row-queue.ts';
import { importWorkflow } from '../temporal/workflows.ts';
import { createImportActivities } from './import-activity.ts';
import { IMPORT_TASK_QUEUE, importWorkflowId } from './import-workflow.ts';
import {
  cancelUnfinishedImport,
  heldImportIds,
  markImportDispatched,
  nextImportId,
} from './repo.ts';
import type { ImportRunnerConfig } from './worker.ts';

const IMPORT_QUEUE: RowQueue = {
  taskQueue: IMPORT_TASK_QUEUE,
  workflow: importWorkflow,
  workflowId: importWorkflowId,
  nextId: () => nextImportId(),
  heldIds: () => heldImportIds(),
  markDispatched: (importId) => markImportDispatched(importId),
  cancelUnfinished: (importId) => cancelUnfinishedImport(new ObjectId(importId)),
};

export const importLane = (config: ImportRunnerConfig = {}): TemporalLane => ({
  queue: IMPORT_QUEUE,
  activities: createImportActivities(config),
});
