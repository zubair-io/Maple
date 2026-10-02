// Temporary gesture replay for the editor's single retained RAW owner (#3984).
import { removal_combine_masks, removal_smart_strokes } from '../raw-pipeline/pkg/raw_wasm';
import type { RemovalEditorSession, RemovalStroke } from './removal-editor-session.service';
import { refinePeople, type PersonGesture } from './removal-person-refinement';

export async function paint(
  session: RemovalEditorSession,
  points: readonly (readonly [number, number])[],
  cropInputSize: readonly [number, number],
): Promise<void> {
  const photo = session.photo;
  if (session.phase() !== 'ready' || !photo || !session.canPaint()) return;
  const token = ++session.revision;
  const radius = session.radius(),
    subtract = session.subtract();
  session.phase.set('selecting');
  session.message.set('');
  try {
    const mapping = JSON.parse(
      await session.pipeline.removal.map(
        photo.xml,
        JSON.stringify({ schema: 1, crop_input_size: cropInputSize, points }),
      ),
    ) as { points: ([number, number] | null)[] };
    session.check(token);
    const batches: [number, number][][] = [[]];
    for (const point of mapping.points) {
      if (point) batches[batches.length - 1].push(point);
      else if (batches[batches.length - 1].length) batches.push([]);
    }
    const next = batches
      .filter((batch) => batch.length)
      .map((batch) => ({ points: batch, radius, subtract }));
    if (!next.length) return;
    if (session.mode() === 'people') {
      const index = session.refiningPerson();
      if (index === null) return;
      const gestures = [...session.personGestures, { index, strokes: next }];
      await refreshPeople(session, gestures, token);
      session.personGestures = gestures;
      session.redoPersonGestures = [];
    } else {
      const strokes = [...session.strokes, ...next];
      await refreshSelection(session, strokes, token);
      session.strokes = strokes;
      session.gestureSizes = [...session.gestureSizes, next.length];
      session.redoGestures = [];
    }
    updateHistory(session);
  } catch (error) {
    session.fail(error, token);
  } finally {
    if (token === session.revision) session.phase.set('ready');
  }
}

export async function undoSelection(session: RemovalEditorSession): Promise<void> {
  if (!session.canUndoSelection() || session.phase() !== 'ready') return;
  const token = ++session.revision;
  session.phase.set('selecting');
  try {
    if (session.mode() === 'people') {
      const gesture = session.personGestures.at(-1)!;
      const proposed = session.personGestures.slice(0, -1);
      await refreshPeople(session, proposed, token);
      session.personGestures = proposed;
      session.redoPersonGestures = [...session.redoPersonGestures, gesture];
    } else {
      const count = session.gestureSizes.at(-1) ?? 1;
      const undone = session.strokes.slice(-count),
        proposed = session.strokes.slice(0, -count);
      await refreshSelection(session, proposed, token);
      session.strokes = proposed;
      session.gestureSizes = session.gestureSizes.slice(0, -1);
      session.redoGestures = [...session.redoGestures, undone];
    }
    updateHistory(session);
  } catch (error) {
    session.fail(error, token);
  } finally {
    if (token === session.revision) session.phase.set('ready');
  }
}

export async function redoSelection(session: RemovalEditorSession): Promise<void> {
  if (!session.canRedoSelection() || session.phase() !== 'ready') return;
  const token = ++session.revision;
  session.phase.set('selecting');
  try {
    if (session.mode() === 'people') {
      const gesture = session.redoPersonGestures.at(-1)!;
      const proposed = [...session.personGestures, gesture];
      await refreshPeople(session, proposed, token);
      session.personGestures = proposed;
      session.redoPersonGestures = session.redoPersonGestures.slice(0, -1);
    } else {
      const gesture = session.redoGestures.at(-1)!;
      const proposed = [...session.strokes, ...gesture];
      await refreshSelection(session, proposed, token);
      session.strokes = proposed;
      session.gestureSizes = [...session.gestureSizes, gesture.length];
      session.redoGestures = session.redoGestures.slice(0, -1);
    }
    updateHistory(session);
  } catch (error) {
    session.fail(error, token);
  } finally {
    if (token === session.revision) session.phase.set('ready');
  }
}

async function refreshSelection(
  session: RemovalEditorSession,
  strokes: readonly RemovalStroke[],
  token: number,
) {
  const mask = !strokes.length
    ? new Uint8Array()
    : session.mode() === 'paint'
      ? await session.pipeline.removal.selection(JSON.stringify({ schema: 1, strokes }))
      : await smartMask(session, strokes, token);
  session.check(token);
  session.selection.set(removal_combine_masks(mask, session.protection(), true));
}

async function smartMask(
  session: RemovalEditorSession,
  strokes: readonly RemovalStroke[],
  token: number,
) {
  const tensors = await session.selectionInputs(token);
  const request = removal_smart_strokes(JSON.stringify(session.smartRequest(tensors, strokes)));
  await session.ai().encode(session.photo!.source, request, tensors.encoder.slice());
  return session.ai().refine(session.photo!.source, request);
}

async function refreshPeople(
  session: RemovalEditorSession,
  gestures: readonly PersonGesture[],
  token: number,
) {
  const result = await refinePeople(
    session.personBases(),
    gestures,
    session.protection(),
    session.pipeline.removal,
  );
  session.check(token);
  session.masks = result.masks;
  session.selection.set(result.selection);
}

function updateHistory(session: RemovalEditorSession) {
  session.canUndoSelection.set(
    session.mode() === 'people' ? session.personGestures.length > 0 : session.strokes.length > 0,
  );
  session.canRedoSelection.set(
    session.mode() === 'people'
      ? session.redoPersonGestures.length > 0
      : session.redoGestures.length > 0,
  );
}
