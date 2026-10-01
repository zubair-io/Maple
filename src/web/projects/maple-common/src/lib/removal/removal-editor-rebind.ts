// Export retires the CPU mosaic, but it must not discard an editor draft,
// selection, dedicated undo, or the photographer's viewport (#3984).
import type { RemovalEditorSession } from './removal-editor-session.service';
import { bundleRemovalCompanions } from './removal-companion-bundle';

export async function rebindAfterExport(
  session: RemovalEditorSession,
  read: () => Promise<Uint8Array>,
): Promise<void> {
  const photo = session.photo;
  if (!photo) return;
  const interrupted = session.phase();
  const token = ++session.revision;
  session.inference?.cancel();
  session.phase.set('loading');
  try {
    const bytes = await read();
    session.check(token);
    const source = await session.pipeline.removal.open({
      sourceId: photo.asset.id,
      bytes,
      ext: photo.asset.filename.split('.').at(-1)?.toLowerCase() ?? '',
    });
    session.check(token);
    if (source !== photo.source)
      throw new Error('The original RAW changed during export. Reopen the photo.');
    const draft = session.draft;
    await session.pipeline.removal.prepareSaved(
      draft?.xml ?? photo.xml,
      bundleRemovalCompanions(draft?.companions ?? photo.companions),
    );
    session.check(token);
    session.phase.set(draft ? 'review' : 'ready');
    if (interrupted === 'generating')
      session.message.set('Generation was interrupted by export. Select Remove to try again.');
  } catch (error) {
    session.fail(error, token);
    if (token === session.revision) session.phase.set('closed');
  }
}
