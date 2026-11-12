/**
 * Placing a backup sidecar re-send onto the stored sidecar's edit history (#5796).
 *
 * A device names the base it last saw: a head entry id (`X-Maple-Sidecar-Head`) or the
 * SHA-256 of the XMP it last delivered (`X-Maple-Sidecar-Base`). A send based on the
 * head replaces the adjustments; any other send is reconciled onto the stored document
 * with the shared Rust three-way merge (#4983), which captures what it displaces as an
 * `external` entry. Either way the send becomes one `backup` history entry, so the edit
 * is applied and recoverable instead of being parked outside the sidecar.
 *
 * Entry ids derive from the base entry and the sent bytes, so a retried send finds its
 * own entry and changes nothing, and a digest base is resolved to the latest entry it
 * produced. The device keeps what it sent, not what the server merged it into, so a
 * merged send's own adjustments are kept beside the sidecar (`sentOf`) and are the merge
 * base of the next send that names it.
 */
import { createHash } from 'node:crypto';
import { nativeValue, record } from '../fs/workflow-variants';
import type { WorkflowHistoryEntry } from '../generated/workflow.generated';

export type SidecarBase =
  | { kind: 'head'; head: string | null }
  | { kind: 'digest'; sha256: string | null };

/** The sent adjustments to keep for a sidecar once a send lands on it. */
export interface SentUpdate {
  /** Entries whose sent adjustments stay: the history the send landed on, and its own. */
  retained: string[];
  /** This send's own, when the server merged it into other adjustments. */
  sent: { entryId: string; checkpoint: string } | null;
}

export type AppliedBackupSidecar =
  | { kind: 'unchanged'; head: string | null }
  | { kind: 'shared' }
  | { kind: 'publish'; xmp: string; head: string; reconciled: boolean; sends: SentUpdate };

const BACKUP_WRITER = 'backup';
const BACKUP_LABEL = 'Backed up from device';

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A UUID (version 5 layout, lowercase) derived from the base entry and the sent bytes. */
function backupEntryId(parentId: string, sentSha256: string): string {
  const bytes = createHash('sha256').update(`${parentId}\0${sentSha256}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validates the body as a complete XMP document; throws when it is not. */
export function checkpointOf(xmp: string): Promise<string> {
  return nativeValue('workflowCheckpointXmp', [xmp]);
}

async function commitBackupEntry(
  merged: string,
  parentId: string,
  sentSha256: string,
  now: number,
): Promise<{ xmp: string; head: string; adjustments: string }> {
  const head = backupEntryId(parentId, sentSha256);
  const adjustments = await checkpointOf(merged);
  const entry: WorkflowHistoryEntry = {
    id: head,
    createdAtMs: now,
    action: 'adjustment',
    label: BACKUP_LABEL,
    parentId,
    writer: BACKUP_WRITER,
    adjustmentXmp: adjustments,
  };
  const xmp = await nativeValue('workflowCommitXmp', [merged, JSON.stringify(entry)]);
  return { xmp, head, adjustments };
}

/** The sidecar a first send creates: the sent document, keeping the authoring record
 * (history and named snapshots) the device published into it, plus the send's entry. */
export async function firstBackupSidecar(
  incoming: string,
  now: number,
): Promise<{ xmp: string; head: string }> {
  const { xmp, head } = await commitBackupEntry(incoming, '', sha256Hex(incoming), now);
  return { xmp, head };
}

/** The entry `base` names; a digest a device sent more than once names its latest send. */
function baseEntry(
  history: readonly WorkflowHistoryEntry[],
  base: SidecarBase,
): WorkflowHistoryEntry | null {
  if (base.kind === 'head') {
    return base.head === null ? null : (history.find((entry) => entry.id === base.head) ?? null);
  }
  const sent = base.sha256;
  if (sent === null) return null;
  return (
    history.findLast((entry) => entry.id === backupEntryId(entry.parentId ?? '', sent)) ?? null
  );
}

export interface BackupSidecarSend {
  current: string;
  incoming: string;
  base: SidecarBase;
  /** A same-stem sibling shares the sidecar (#4692): only the exact base may replace it. */
  shared: boolean;
  now: number;
  /** What the device sent for an entry the server merged into other adjustments. */
  sentOf: (entryId: string) => Promise<string | null>;
}

/** The entry a send continues from: the base it named, or the head when it was
 * built from the current bytes. `ancestor` is what the device held there: what it
 * sent when the server merged that send, else the entry's adjustments. */
interface SendParent {
  known: WorkflowHistoryEntry | null;
  fromCurrent: boolean;
  id: string;
  ancestor: string;
  /** The device held exactly the entry's recorded adjustments. */
  exact: boolean;
}

async function sendParent(
  history: readonly WorkflowHistoryEntry[],
  send: BackupSidecarSend,
  currentSha256: string,
): Promise<SendParent> {
  const known = baseEntry(history, send.base);
  const fromCurrent = send.base.kind === 'digest' && send.base.sha256 === currentSha256;
  if (known !== null) {
    const sent = await send.sentOf(known.id);
    const ancestor = sent ?? known.adjustmentXmp;
    return { known, fromCurrent, id: known.id, ancestor, exact: sent === null };
  }
  if (!fromCurrent) return { known, fromCurrent, id: '', ancestor: '', exact: false };
  return { known, fromCurrent, id: history.at(-1)?.id ?? '', ancestor: send.current, exact: true };
}

/** Whether the merge recorded an entry `history` lacks: an outside edit it captured. */
async function capturedOutsideEdit(
  merged: string,
  history: readonly WorkflowHistoryEntry[],
): Promise<boolean> {
  const prior = new Set(history.map((entry) => entry.id));
  const entries = (await record(merged))?.history ?? [];
  return entries.some((entry) => !prior.has(entry.id));
}

/** The sent adjustments to keep once a send landed as `landed`: its own when the merge
 * made them something other than the send applied as is (`reconcile_xmp` from `current`
 * itself, so both sides carry the same record layout). */
async function sentUpdate(
  send: BackupSidecarSend,
  history: readonly WorkflowHistoryEntry[],
  landed: { head: string; adjustments: string },
  sent: string,
): Promise<SentUpdate> {
  const { current, incoming, now } = send;
  const applied = await nativeValue('workflowReconcileXmp', [current, current, incoming, `${now}`]);
  const merged = landed.adjustments !== (await checkpointOf(applied));
  return {
    retained: [...history.map((entry) => entry.id), landed.head],
    sent: merged ? { entryId: landed.head, checkpoint: sent } : null,
  };
}

/** What publishing `incoming` over the stored `current` does. */
export async function reconcileBackupSidecar(
  send: BackupSidecarSend,
): Promise<AppliedBackupSidecar> {
  const { current, incoming, now } = send;
  const sentSha256 = sha256Hex(incoming);
  const currentSha256 = sha256Hex(current);
  const history = (await record(current))?.history ?? [];
  const head = history.at(-1)?.id ?? null;
  if (currentSha256 === sentSha256) return { kind: 'unchanged', head };

  const parent = await sendParent(history, send, currentSha256);
  const ownEntry = backupEntryId(parent.id, sentSha256);
  if (history.some((entry) => entry.id === ownEntry)) return { kind: 'unchanged', head: ownEntry };
  const sent = await checkpointOf(incoming);
  if (sent === (await checkpointOf(current))) return { kind: 'unchanged', head };

  const merged = await nativeValue('workflowReconcileXmp', [
    parent.ancestor,
    current,
    incoming,
    String(now),
  ]);
  // Only the head names the stored sidecar, and only while the file still holds what
  // that entry recorded and the device held: an outside edit makes the merge capture it.
  const fresh =
    parent.fromCurrent ||
    (parent.known?.id === head && parent.exact && !(await capturedOutsideEdit(merged, history)));
  if (!fresh && send.shared) return { kind: 'shared' };
  const landed = await commitBackupEntry(merged, parent.id, sentSha256, now);
  const sends = await sentUpdate(send, history, landed, sent);
  return { kind: 'publish', xmp: landed.xmp, head: landed.head, reconciled: !fresh, sends };
}
