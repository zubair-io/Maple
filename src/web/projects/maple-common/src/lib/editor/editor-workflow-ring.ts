import type { AdjustmentModel } from '../models/adjustment-model';
import type { SidecarWorkflow, WorkflowHistoryEntry } from '../generated/workflow.generated';
import type { WorkflowCursor } from '../xmp/workflow-xmp.service';

/** One Undo or Redo step between two complete documents of the persisted history. */
export interface RingStep {
  readonly description: string;
  readonly before: AdjustmentModel;
  readonly after: AdjustmentModel;
  readonly checkpoint: { readonly before: string; readonly after: string };
}

/** A sidecar's record with the cursor `cursor_xmp` derived from it. */
export interface RingSource {
  readonly record: SidecarWorkflow;
  readonly cursor: WorkflowCursor;
  readonly current: string;
}

/** `redo` is ordered nearest first. */
export interface RingSteps {
  readonly undo: readonly RingStep[];
  readonly redo: readonly RingStep[];
}

const OUTSIDE_LABEL = 'Changes outside the history';

const isReplay = (entry: WorkflowHistoryEntry): boolean =>
  entry.action === 'undo' || entry.action === 'redo';

/**
 * The Undo/Redo steps a reopened editor offers for a sidecar's retained
 * history (#4983). `states` runs oldest undo state, the sidecar itself
 * (`current`, its complete document without the record), then the nearest redo
 * state outward; each step moves between neighbours.
 */
export function historyRingSteps(
  { record, cursor, current }: RingSource,
  modelOf: (xml: string) => AdjustmentModel,
): RingSteps {
  const entry = (id: string): WorkflowHistoryEntry => {
    const found = record.history.find((candidate) => candidate.id === id);
    if (!found) throw Error('The history cursor names an entry the sidecar does not hold.');
    return found;
  };
  // An Undo/Redo entry repeats an earlier state; name it after the action that made it.
  const label = (candidate: WorkflowHistoryEntry): string => {
    const origin = isReplay(candidate)
      ? record.history.find(
          (other) => other.adjustmentXmp === candidate.adjustmentXmp && !isReplay(other),
        )
      : candidate;
    return origin ? origin.label : candidate.label.replace(/^(Undo|Redo) /, '');
  };
  const undo = cursor.undo.map(entry);
  const redo = cursor.redo.map(entry);
  const head = record.history.at(-1);
  const states = [
    ...undo.map((candidate) => candidate.adjustmentXmp),
    current,
    ...redo.map((candidate) => candidate.adjustmentXmp),
  ];
  const labels = [
    ...undo.map(label),
    cursor.synced && head ? label(head) : OUTSIDE_LABEL,
    ...redo.map(label),
  ];
  const models = states.map(modelOf);
  const steps = states.slice(1).map(
    (after, index): RingStep => ({
      description: labels[index + 1],
      before: models[index],
      after: models[index + 1],
      checkpoint: { before: states[index], after },
    }),
  );
  const moving = (step: RingStep) => step.checkpoint.before !== step.checkpoint.after;
  return {
    undo: steps.slice(0, undo.length).filter(moving),
    redo: steps.slice(undo.length).filter(moving),
  };
}
