/** UUID branches share their original's stem, never a catalog-only identity (#4044). */
import { WORKFLOW_UUID_PATTERN } from '../generated/workflow.generated';

const siblingPattern = new RegExp('^(.+)\\.v(' + WORKFLOW_UUID_PATTERN + ')\\.xmp$');

/** Only canonical UUID siblings pair. Foreign .v2 files and backups retain their own names. */
export function workflowSidecarBase(filename: string): string | null {
  return siblingPattern.exec(filename)?.[1] ?? null;
}
