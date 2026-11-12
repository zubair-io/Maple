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
 * own entry and changes nothing, and a digest base is resolved to the latest place the
 * device sent it. The device keeps what it sent, not what the server merged it into, and
 * names it by digest: what the history cannot show (a merged send's own adjustments, a
 * send acknowledged as unchanged) is kept beside the sidecar (`SentRecord`) and is the
 * merge base of the next send that names it.
 */
import { createHash } from 'node:crypto';
import { nativeValue, record } from '../fs/workflow-variants';
import type {
  SidecarWorkflow,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
} from '../generated/workflow.generated';

export type SidecarBase =
  | { kind: 'head'; head: string | null }
  | { kind: 'digest'; sha256: string | null };

/** A send kept beside the sidecar: the device sent `sha256`, whose adjustments are
 * `checkpoint`, and it became, or was acknowledged at, history entry `entryId` (`''`
 * for none). */
export interface SentRecord {
  sha256: string;
  entryId: string;
  checkpoint: string;
}

/** The sends to keep for a sidecar once one was placed on it. */
export interface SentUpdate {
  /** Entries whose sends stay: the sidecar's history, and `''`. */
  retained: string[];
  /** This send, when the history cannot show what the device holds now. */
  sent: SentRecord | null;
}

export type AppliedBackupSidecar =
  | { kind: 'unchanged'; head: string | null; sends?: SentUpdate }
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

export interface BackupSidecarSend {
  current: string;
  incoming: string;
  base: SidecarBase;
  /** A same-stem sibling shares the sidecar (#4692): only the exact base may replace it. */
  shared: boolean;
  now: number;
  /** The kept sends with this digest, or kept for this entry. */
  sentFor: (query: { sha256: string } | { entryId: string }) => Promise<SentRecord[]>;
}

/** Where a send continues from: the entry it names (`known`, its `id`), and `ancestor`,
 * what the device held there: what it sent when the history cannot show it, else the
 * entry's adjustments. */
interface SendParent {
  known: WorkflowHistoryEntry | null;
  fromCurrent: boolean;
  id: string;
  ancestor: string;
  /** The device held exactly the entry's recorded adjustments. */
  exact: boolean;
}

type Found = Omit<SendParent, 'fromCurrent'>;

const landedBy = (entry: WorkflowHistoryEntry, sha256: string) =>
  entry.id === backupEntryId(entry.parentId ?? '', sha256);

/** The entry a head names, from what that send carried when the server merged it. */
async function headParent(
  history: readonly WorkflowHistoryEntry[],
  head: string,
  send: BackupSidecarSend,
): Promise<Found | null> {
  const known = history.find((entry) => entry.id === head);
  if (known === undefined) return null;
  const own = (await send.sentFor({ entryId: head })).find((row) => landedBy(known, row.sha256));
  return { known, id: known.id, ancestor: own?.checkpoint ?? known.adjustmentXmp, exact: !own };
}

/** The latest place in the history the device sent `sha256`: the entry it became, or one
 * it was acknowledged at; else an acknowledgement when the sidecar had no history. */
async function digestParent(
  history: readonly WorkflowHistoryEntry[],
  sha256: string,
  send: BackupSidecarSend,
): Promise<Found | null> {
  const rows = await send.sentFor({ sha256 });
  for (const known of history.toReversed()) {
    const row = rows.find((candidate) => candidate.entryId === known.id);
    if (landedBy(known, sha256)) {
      return { known, id: known.id, ancestor: row?.checkpoint ?? known.adjustmentXmp, exact: !row };
    }
    if (row) return { known, id: known.id, ancestor: row.checkpoint, exact: true };
  }
  const unrecorded = rows.find((row) => row.entryId === '');
  return unrecorded ? { known: null, id: '', ancestor: unrecorded.checkpoint, exact: false } : null;
}

function namedParent(
  history: readonly WorkflowHistoryEntry[],
  send: BackupSidecarSend,
): Promise<Found | null> {
  const { base } = send;
  if (base.kind === 'head') {
    return base.head === null ? Promise.resolve(null) : headParent(history, base.head, send);
  }
  return base.sha256 === null ? Promise.resolve(null) : digestParent(history, base.sha256, send);
}

async function sendParent(
  history: readonly WorkflowHistoryEntry[],
  send: BackupSidecarSend,
  currentSha256: string,
): Promise<SendParent> {
  const fromCurrent = send.base.kind === 'digest' && send.base.sha256 === currentSha256;
  const found = await namedParent(history, send);
  if (found?.known) return { ...found, fromCurrent };
  if (fromCurrent) {
    const id = history.at(-1)?.id ?? '';
    return { known: null, fromCurrent, id, ancestor: send.current, exact: true };
  }
  return { known: null, fromCurrent, id: '', ancestor: found?.ancestor ?? '', exact: false };
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

const retainedBy = (history: readonly WorkflowHistoryEntry[]) => [
  ...history.map((entry) => entry.id),
  '',
];

/** Whether the file holds adjustments no history head records: an outside edit, or a
 * sidecar without history (a legacy upload, another app). `reconcile_xmp` from the head's
 * adjustments (none without history) then captures the file as an `external` entry. */
async function aheadOfHistory(
  current: string,
  history: readonly WorkflowHistoryEntry[],
  now: number,
): Promise<boolean> {
  const recorded = history.at(-1)?.adjustmentXmp ?? '';
  const probe = await nativeValue('workflowReconcileXmp', [recorded, current, current, `${now}`]);
  return capturedOutsideEdit(probe, history);
}

/** Acknowledged without a write, at a head that holds the file's adjustments: kept, so
 * the digest the device now holds names that head even once another writer moved on. */
function acknowledged(
  history: readonly WorkflowHistoryEntry[],
  sha256: string,
  checkpoint: string,
): AppliedBackupSidecar {
  const head = history.at(-1)?.id ?? null;
  const sent = { sha256, entryId: head ?? '', checkpoint };
  return { kind: 'unchanged', head, sends: { retained: retainedBy(history), sent } };
}

/** Whether `send` asks for nothing the stored sidecar and its head do not already hold:
 * the same adjustments, no new named snapshot, and a head that records the file. A
 * send of what an outside edit left ahead of the history lands as an entry instead,
 * so the head it is answered with holds what it acknowledged. */
async function alreadyHeld(
  send: BackupSidecarSend,
  history: readonly WorkflowHistoryEntry[],
  sent: string,
  added: readonly WorkflowSnapshot[],
): Promise<boolean> {
  if (added.length > 0 || sent !== (await checkpointOf(send.current))) return false;
  return !(await aheadOfHistory(send.current, history, send.now));
}

/** The sends to keep once a send landed as `landed` over `history`: its own when the
 * merge made it something other than the send applied as is (`reconcile_xmp` from
 * `current` itself, so both sides carry the same record layout). The rows of `history`
 * stay too, since a publish that fails leaves that history on disk. */
async function sentUpdate(
  send: BackupSidecarSend,
  history: readonly WorkflowHistoryEntry[],
  landed: { xmp: string; adjustments: string },
  sent: SentRecord,
): Promise<SentUpdate> {
  const { current, incoming, now } = send;
  const applied = await nativeValue('workflowReconcileXmp', [current, current, incoming, `${now}`]);
  const merged = landed.adjustments !== (await checkpointOf(applied));
  const after = (await record(landed.xmp))?.history ?? [];
  return { retained: retainedBy([...history, ...after]), sent: merged ? sent : null };
}

/** The named snapshots the device sent that the stored record lacks. Snapshots are
 * immutable and keyed by id, so one already stored is never replaced, and none is
 * removed: snapshot creation never discards another (`xmp-canonical-format.md`). */
async function sentSnapshots(
  incoming: string,
  stored: SidecarWorkflow | null,
): Promise<WorkflowSnapshot[]> {
  const known = new Set(stored?.snapshots.map((snapshot) => snapshot.id));
  const sent = (await record(incoming))?.snapshots ?? [];
  return sent.filter((snapshot) => !known.has(snapshot.id));
}

/** `xmp` with `added` after the named snapshots it holds. */
async function withSnapshots(xmp: string, added: readonly WorkflowSnapshot[]): Promise<string> {
  const landed = await record(xmp);
  if (added.length === 0 || landed === null) return xmp;
  const snapshots = [...landed.snapshots, ...added];
  return nativeValue('workflowEmbedXmp', [JSON.stringify({ ...landed, snapshots }), xmp]);
}

/** What publishing `incoming` over the stored `current` does. */
export async function reconcileBackupSidecar(
  send: BackupSidecarSend,
): Promise<AppliedBackupSidecar> {
  const { current, incoming, now } = send;
  const sentSha256 = sha256Hex(incoming);
  const currentSha256 = sha256Hex(current);
  const stored = await record(current);
  const history = stored?.history ?? [];
  const head = history.at(-1)?.id ?? null;
  const sent = await checkpointOf(incoming);

  const parent = await sendParent(history, send, currentSha256);
  const ownEntry = backupEntryId(parent.id, sentSha256);
  if (history.some((entry) => entry.id === ownEntry)) return { kind: 'unchanged', head: ownEntry };
  const added = await sentSnapshots(incoming, stored);
  if (await alreadyHeld(send, history, sent, added)) {
    return acknowledged(history, sentSha256, sent);
  }

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
  const xmp = await withSnapshots(landed.xmp, added);
  const own = { sha256: sentSha256, entryId: landed.head, checkpoint: sent };
  const sends = await sentUpdate(send, history, { xmp, adjustments: landed.adjustments }, own);
  return { kind: 'publish', xmp, head: landed.head, reconciled: !fresh, sends };
}
