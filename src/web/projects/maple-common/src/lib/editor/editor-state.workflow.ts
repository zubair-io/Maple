import type { EditorStateService } from './editor-state.service';
import type { RestoreCommand } from './editor-workflow-commands.service';
import { errorMessage } from '../util/errors';

/** Failed publication keeps both the Undo action and its immutable retry identity. */
export async function replayWorkflow(
  host: EditorStateService,
  direction: 'undo' | 'redo',
): Promise<void> {
  if (!host.ring.peek(direction)?.checkpoint || host.workflowBusy()) return;
  if (host.autoInFlight() || host.wbSampleInFlight()) {
    host.workflowError.set(
      'Wait for image analysis to finish before restoring a complete version.',
    );
    return;
  }
  const generation = host.bindingGeneration;
  host.workflowBusy.set(true);
  host.workflowError.set(null);
  try {
    await publishReplay(host, direction, generation);
  } catch (error) {
    if (host.bindingGeneration === generation) host.workflowError.set(errorMessage(error));
  } finally {
    host.workflowBusy.set(false);
  }
}

function replaySource(host: EditorStateService) {
  const id = host.imageId();
  const model = host.currentAdjustment();
  if (id === null || model === null) throw Error('The selected photo changed. Reopen its history.');
  const source = host.workflowCommands.capture(id, model);
  if (!source) throw Error('Reopen this photo with write access before restoring history.');
  return source;
}

async function publishReplay(
  host: EditorStateService,
  direction: 'undo' | 'redo',
  generation: number,
): Promise<void> {
  const tx = host.ring.peek(direction)!;
  const source = replaySource(host);
  const command =
    host.workflowReplay?.direction === direction
      ? host.workflowReplay.command
      : await host.workflowCommands.prepareReplay(
          source,
          tx.checkpoint![direction === 'undo' ? 'before' : 'after'],
          direction,
          `${direction === 'undo' ? 'Undo' : 'Redo'} ${tx.description}`,
        );
  if (host.bindingGeneration === generation) host.workflowReplay = { direction, command };
  const xml = await host.workflowCommands.restore(command);
  if (host.bindingGeneration !== generation || !host.workflowCommands.history.isCurrent(source))
    return;
  host.workflowCommands.apply(source, xml);
  if (direction === 'undo') host.ring.popUndo();
  else host.ring.popRedo();
  host.workflowReplay = null;
  void host.announcer.announce(command.entry.label);
}

export async function restoreWorkflow(
  host: EditorStateService,
  command: RestoreCommand,
): Promise<void> {
  if (host.workflowBusy()) throw Error('A workflow save is already in progress.');
  if (host.autoInFlight() || host.wbSampleInFlight())
    throw Error('Wait for image analysis to finish before restoring a complete version.');
  const generation = host.bindingGeneration;
  const before = host.currentAdjustment();
  if (
    !before ||
    host.imageId() !== command.source.id ||
    !host.workflowCommands.history.isCurrent(command.source)
  )
    throw Error('The selected photo changed. Reopen its history.');
  host.workflowBusy.set(true);
  host.workflowError.set(null);
  try {
    const xml = await host.workflowCommands.restore(command);
    if (
      host.bindingGeneration !== generation ||
      !host.workflowCommands.history.isCurrent(command.source)
    )
      return;
    const after = host.workflowCommands.model(command.source, xml);
    host.workflowCommands.apply(command.source, xml);
    host.ring.recordCheckpoint(
      host.serializer,
      before,
      after,
      { before: command.before, after: command.entry.adjustmentXmp },
      command.entry.label,
    );
    host.workflowReplay = null;
    void host.announcer.announce(command.entry.label);
  } finally {
    host.workflowBusy.set(false);
  }
}
