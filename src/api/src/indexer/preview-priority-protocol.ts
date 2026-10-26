/**
 * The two IPC messages that let on-demand previews (API process) and the
 * background `preview` stage (worker child) cooperate (#5433).
 *
 * - `preview-interactive` (API → worker): whether any on-demand render is in
 *   flight. The stage stops admitting new renders while it is `true`, so the
 *   request a viewer is waiting on gets the CPU.
 * - `preview-stage-render` (worker → API): the stage started or finished
 *   rendering one preview path. An on-demand request for that path waits for
 *   the stage's render instead of starting a second one.
 */

export interface PreviewInteractiveMessage {
  type: 'preview-interactive';
  active: boolean;
}

export interface PreviewStageRenderMessage {
  type: 'preview-stage-render';
  previewPath: string;
  phase: 'start' | 'end';
}

export function isPreviewInteractiveMessage(
  message: unknown,
): message is PreviewInteractiveMessage {
  const m = message as Partial<PreviewInteractiveMessage> | null;
  return m?.type === 'preview-interactive' && typeof m.active === 'boolean';
}

export function isPreviewStageRenderMessage(
  message: unknown,
): message is PreviewStageRenderMessage {
  const m = message as Partial<PreviewStageRenderMessage> | null;
  return (
    m?.type === 'preview-stage-render' &&
    typeof m.previewPath === 'string' &&
    (m.phase === 'start' || m.phase === 'end')
  );
}
