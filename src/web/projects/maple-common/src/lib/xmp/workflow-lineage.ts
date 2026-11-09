import type { SidecarWorkflow } from '../generated/workflow.generated';

/** The `writer` label every history entry built by the Web hosts carries (#4983). */
export const WEB_WRITER = 'web';

/** Id of the newest history entry, or `''` when the record has none; the `parentId` of the next write. */
export function headId(record: SidecarWorkflow | null): string {
  return record?.history.at(-1)?.id ?? '';
}
