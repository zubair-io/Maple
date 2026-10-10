// Concrete saved-row controls (#3984), outside inference and slider ticks.
import {
  removal_saved_edit,
  removal_saved_list,
  removal_saved_prefix,
  removal_asset_names,
} from '../raw-pipeline/pkg/raw_wasm';
import {
  SAVED_REMOVAL_ACTIONS,
  SAVED_REMOVAL_EDIT_VERSION,
  type SavedRemovalEntry,
} from '../generated/removal-models.generated';
import type { RemovalEditorSession } from './removal-editor-session.service';
import { bundleRemovalCompanions } from './removal-companion-bundle';

export function savedEntries(records: string): readonly SavedRemovalEntry[] {
  return JSON.parse(removal_saved_list(records)) as SavedRemovalEntry[];
}

export function replacementPrefix(session: RemovalEditorSession, records: string): string {
  const replacing = session.replacingRemoval();
  return replacing ? removal_saved_prefix(records, replacing.id) : records;
}

export function replaceRecords(
  session: RemovalEditorSession,
  prior: string,
  candidate: string,
): string {
  const replacing = session.replacingRemoval();
  return replacing
    ? removal_saved_edit(
        prior,
        JSON.stringify({
          schema: SAVED_REMOVAL_EDIT_VERSION,
          id: replacing.id,
          action: SAVED_REMOVAL_ACTIONS.replace,
          replacement: candidate,
        }),
      )
    : candidate;
}

export function companionsFor(
  records: string,
  companions: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array> {
  const names = JSON.parse(removal_asset_names(records)) as string[];
  return new Map(
    names.map((name) => {
      const bytes = companions.get(name);
      if (!bytes) throw new Error(`A saved removal asset is missing: ${name}`);
      return [name, bytes];
    }),
  );
}

export function beginReplace(session: RemovalEditorSession, id: string): void {
  const photo = session.photo;
  const entry = session.savedRemovals().find((row) => row.id === id);
  if (
    !photo ||
    !entry?.editable ||
    !entry.mask ||
    session.phase() !== 'ready' ||
    session.replacingRemoval()
  )
    return;
  try {
    // Validate the generation prefix before publishing temporary editing intent.
    removal_saved_prefix(photo.prior, id);
    const mask = photo.companions.get(entry.mask.slice(7) + '.mask');
    if (!mask) throw new Error('The saved selection mask is missing.');
    session.setMode('paint');
    session.clearSelection();
    session.replacementBase = mask.slice();
    session.selection.set(mask.slice());
    session.replacingRemoval.set(entry);
    session.message.set('Refine this saved selection, then Remove and Keep to replace it.');
  } catch (error) {
    session.message.set(error instanceof Error ? error.message : String(error));
  }
}

export async function cancelReplacement(session: RemovalEditorSession): Promise<void> {
  if (session.busy() || !session.replacingRemoval()) return;
  await session.cancel();
  if (session.phase() !== 'ready') return;
  session.replacingRemoval.set(null);
  session.clearSelection();
}

export async function changeSaved(
  session: RemovalEditorSession,
  id: string,
  active?: boolean,
): Promise<void> {
  const photo = session.photo;
  if (!photo || session.phase() !== 'ready' || session.replacingRemoval()) return;
  const token = session.revision;
  session.phase.set('saving');
  session.message.set('');
  try {
    const records = removal_saved_edit(
      photo.prior,
      JSON.stringify({
        schema: SAVED_REMOVAL_EDIT_VERSION,
        id,
        action:
          active === undefined ? SAVED_REMOVAL_ACTIONS.delete : SAVED_REMOVAL_ACTIONS.setActive,
        active,
      }),
    );
    session.committingXml = session.recipe(photo, records);
    session.cullingFor(photo);
    const revision = await session.editor.acceptRemoval(
      records,
      photo.model,
      active === undefined ? 'Delete removal' : active ? 'Enable removal' : 'Disable removal',
      photo.sidecarRevision,
    );
    if (token !== session.revision) return;
    const xml = session.recipe(photo, records);
    // The authoritative model has committed. Any restoration failure must now
    // recover this new stack, rather than pretending the previous save won.
    session.photo = {
      ...photo,
      prior: records,
      xml,
      model: { ...photo.model, inpaintRemovals: records === '[]' ? undefined : records },
      sidecarRevision: revision,
    };
    session.key = session.keyFor(photo.asset, xml);
    session.savedRemovals.set(savedEntries(records));
    session.clearSelection();
    const committedToken = session.revision;
    session.resetProxy();
    try {
      await session.pipeline.removal.prepareSaved(
        xml,
        bundleRemovalCompanions(companionsFor(records, photo.companions)),
      );
      session.check(committedToken);
      session.phase.set('ready');
      session.message.set('Removal saved.');
    } catch (error) {
      session.fail(error, committedToken);
      if (committedToken === session.revision) session.phase.set('recovery');
    }
  } catch (error) {
    session.fail(error, token);
    if (token === session.revision && session.phase() === 'saving') session.phase.set('ready');
  }
}
