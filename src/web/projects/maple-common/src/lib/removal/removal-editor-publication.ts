// Generation, inspection and confirmed publication use the session's single
// source/revision owner. Split for the source budget, not a second edit state.
import {
  removal_content_digest,
  removal_generation_plan,
  removal_prepare,
} from '../raw-pipeline/pkg/raw_wasm';
import { bundleRemovalCompanions } from './removal-companion-bundle';
import type { RemovalProposal } from './removal-inference.types';
import type { RemovalEditorSession } from './removal-editor-session.service';
import { REMOVAL_AUTHORING_DEFAULTS } from '../generated/removal-models.generated';
import {
  replacementPrefix,
  replaceRecords,
  companionsFor,
  savedEntries,
} from './removal-editor-saved';

export async function remove(session: RemovalEditorSession): Promise<void> {
  const photo = session.photo;
  if (!photo || session.phase() !== 'ready' || !session.selection().length) return;
  const token = ++session.revision;
  session.phase.set('generating');
  session.message.set('');
  try {
    let records = replacementPrefix(session, photo.prior);
    const companions = new Map(photo.companions),
      proposals: RemovalProposal[] = [];
    const masks = session.mode() === 'people' ? session.masks : [session.selection()];
    for (const mask of masks) {
      session.check(token);
      const plan = JSON.parse(
        removal_generation_plan(
          photo.source,
          mask,
          REMOVAL_AUTHORING_DEFAULTS.holeRadius,
          REMOVAL_AUTHORING_DEFAULTS.fringeRadius,
        ),
      ) as {
        window: { x: number; y: number; width: number; height: number };
      };
      const { x, y, width, height } = plan.window;
      const xml = session.recipe(photo, records);
      const scene = await session.pipeline.removal.generationContext(
        xml,
        [x, y, width, height],
        bundleRemovalCompanions(companionsFor(records, companions)),
      );
      session.check(token);
      const proposal = await session
        .ai()
        .propose(
          JSON.stringify({ schema: 1, source: JSON.parse(photo.source), masks: plan }),
          records,
          scene,
          mask,
          session.protection(),
        );
      session.check(token);
      records = removal_prepare(proposal.request, records, proposal.mask, proposal.patch);
      companions.set(removal_content_digest(proposal.mask).slice(7) + '.mask', proposal.mask);
      companions.set(removal_content_digest(proposal.patch).slice(7) + '.f16', proposal.patch);
      proposals.push(proposal);
    }
    records = replaceRecords(session, photo.prior, records);
    const xml = session.recipe(photo, records);
    await session.pipeline.removal.prepareSaved(
      xml,
      bundleRemovalCompanions(companionsFor(records, companions)),
    );
    session.check(token);
    const preview = await session.pipeline.removal.renderSaved(xml, 1280);
    session.check(token);
    session.draft = { records, xml, proposals, companions };
    session.preview.set(preview);
    session.compare.set(false);
    session.phase.set('review');
    session.message.set(
      'Inspect the result. Keep saves the replacement; Cancel restores the current edit.',
    );
  } catch (error) {
    if (token !== session.revision) return;
    try {
      await session.restore(photo);
    } catch (restoreError) {
      session.fail(restoreError, token);
      session.phase.set('recovery');
      return;
    }
    session.fail(error, token);
    if (token === session.revision) session.phase.set('ready');
  }
}
export async function cancel(session: RemovalEditorSession): Promise<void> {
  const photo = session.photo;
  if (session.phase() === 'saving') return;
  const token = ++session.revision;
  session.inference?.cancel();
  try {
    if (photo) await session.restore(photo);
  } catch (error) {
    session.fail(error, token);
    if (token === session.revision) session.phase.set('recovery');
    return;
  }
  if (token !== session.revision) return;
  session.draft = undefined;
  session.preview.set(null);
  session.compare.set(false);
  session.phase.set(photo ? 'ready' : 'closed');
  session.message.set('');
}
export async function keep(session: RemovalEditorSession): Promise<void> {
  const photo = session.photo,
    draft = session.draft;
  if (!photo || !draft || session.phase() !== 'review') return;
  const token = session.revision;
  session.phase.set('saving');
  session.message.set('');
  try {
    let published = replacementPrefix(session, photo.prior);
    for (const proposal of draft.proposals) {
      published = await photo.assets.publish(
        proposal.request,
        published,
        proposal.mask,
        proposal.patch,
      );
      session.check(token);
    }
    published = replaceRecords(session, photo.prior, published);
    if (published !== draft.records) throw new Error('Published removal records changed.');
    await session.pipeline.removal.prepareSaved(
      draft.xml,
      bundleRemovalCompanions(companionsFor(draft.records, draft.companions)),
    );
    session.check(token);
    session.committingXml = draft.xml;
    session.cullingFor(photo);
    const sidecarRevision = await session.editor.acceptRemoval(
      draft.records,
      photo.model,
      session.replacingRemoval()
        ? 'Replace removal'
        : draft.proposals.length === 1
          ? 'Remove object'
          : `Remove ${draft.proposals.length} objects`,
      photo.sidecarRevision,
    );
    if (token !== session.revision) return;
    session.photo = {
      ...photo,
      prior: draft.records,
      xml: draft.xml,
      companions: companionsFor(draft.records, draft.companions),
      model: { ...photo.model, inpaintRemovals: draft.records },
      sidecarRevision,
    };
    session.key = session.keyFor(photo.asset, draft.xml);
    session.resetProxy();
    session.savedRemovals.set(savedEntries(draft.records));
    session.replacingRemoval.set(null);
    session.replacementBase = new Uint8Array();
    session.draft = undefined;
    session.preview.set(null);
    session.phase.set('ready');
    session.clearSelection();
    session.message.set('Removal saved.');
  } catch (error) {
    session.fail(error, token);
    if (token === session.revision) session.phase.set('review');
  }
}
export async function undoKeep(session: RemovalEditorSession): Promise<void> {
  if (session.phase() !== 'ready' || !session.canUndoKeep()) return;
  session.editor.undo();
  try {
    await session.editor.settleRemovalSave();
  } catch (error) {
    session.message.set(error instanceof Error ? error.message : String(error));
  }
}
