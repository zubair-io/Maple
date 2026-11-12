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
 * own entry and changes nothing, and a digest base is resolved to the entry it produced.
 */
import { createHash } from 'node:crypto';
import { nativeValue, record } from '../fs/workflow-variants';
import type { WorkflowHistoryEntry } from '../generated/workflow.generated';

export type SidecarBase =
  | { kind: 'head'; head: string | null }
  | { kind: 'digest'; sha256: string | null };

export type AppliedBackupSidecar =
  | { kind: 'unchanged'; head: string | null }
  | { kind: 'shared' }
  | { kind: 'publish'; xmp: string; head: string; reconciled: boolean };

const BACKUP_WRITER = 'backup';
const BACKUP_LABEL = 'Backed up from device';

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A UUID (version 5 layout, lowercase) derived from the base entry and the sent bytes. */
export function backupEntryId(parentId: string, sentSha256: string): string {
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
): Promise<{ xmp: string; head: string }> {
  const head = backupEntryId(parentId, sentSha256);
  const entry: WorkflowHistoryEntry = {
    id: head,
    createdAtMs: now,
    action: 'adjustment',
    label: BACKUP_LABEL,
    parentId,
    writer: BACKUP_WRITER,
    adjustmentXmp: await checkpointOf(merged),
  };
  return { xmp: await nativeValue('workflowCommitXmp', [merged, JSON.stringify(entry)]), head };
}

/** The sidecar a first send creates: its adjustments with a one-entry history. */
export async function firstBackupSidecar(
  incoming: string,
  now: number,
): Promise<{ xmp: string; head: string }> {
  return commitBackupEntry(await checkpointOf(incoming), '', sha256Hex(incoming), now);
}

function baseEntry(
  history: readonly WorkflowHistoryEntry[],
  base: SidecarBase,
): WorkflowHistoryEntry | null {
  if (base.kind === 'head') {
    return base.head === null ? null : (history.find((entry) => entry.id === base.head) ?? null);
  }
  const sent = base.sha256;
  if (sent === null) return null;
  return history.find((entry) => entry.id === backupEntryId(entry.parentId ?? '', sent)) ?? null;
}

export interface BackupSidecarSend {
  current: string;
  incoming: string;
  base: SidecarBase;
  /** A same-stem sibling shares the sidecar (#4692): only the exact base may replace it. */
  shared: boolean;
  now: number;
}

/** What publishing `incoming` over the stored `current` does. */
export async function reconcileBackupSidecar(
  send: BackupSidecarSend,
): Promise<AppliedBackupSidecar> {
  const { current, incoming, base, now } = send;
  const sentSha256 = sha256Hex(incoming);
  const currentSha256 = sha256Hex(current);
  const stored = await record(current);
  const history = stored?.history ?? [];
  const head = history.at(-1)?.id ?? null;
  if (currentSha256 === sentSha256) return { kind: 'unchanged', head };

  const known = baseEntry(history, base);
  const sentFromCurrent = base.kind === 'digest' && base.sha256 === currentSha256;
  const parentId = known?.id ?? (sentFromCurrent ? (head ?? '') : '');
  const ownEntry = backupEntryId(parentId, sentSha256);
  if (history.some((entry) => entry.id === ownEntry)) return { kind: 'unchanged', head: ownEntry };
  if ((await checkpointOf(incoming)) === (await checkpointOf(current))) {
    return { kind: 'unchanged', head };
  }

  const merged = await nativeValue('workflowReconcileXmp', [
    known?.adjustmentXmp ?? (sentFromCurrent ? current : ''),
    current,
    incoming,
    String(now),
  ]);
  // Only the head names the stored sidecar, and only while the file still holds what
  // that entry recorded: an outside edit makes the merge capture it as a new entry.
  const captured = (await record(merged))?.history.some(
    (entry) => !history.some((prior) => prior.id === entry.id),
  );
  const fresh = sentFromCurrent || (known !== null && known.id === head && !captured);
  if (!fresh && send.shared) return { kind: 'shared' };
  const landed = await commitBackupEntry(merged, parentId, sentSha256, now);
  return { kind: 'publish', ...landed, reconciled: !fresh };
}
