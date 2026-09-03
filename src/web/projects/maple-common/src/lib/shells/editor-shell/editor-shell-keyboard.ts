// Keyboard entry points for EditorShellComponent (#1535 → #2450). The
// shell's `document:keydown` / `document:keyup` host listeners land here;
// resolution and execution live in `editor-command-router.ts`, the command
// table in `editor-commands.ts`. Kept as its own module so the keyboard
// surface stays a two-function seam the specs can drive with a mock shell.
import type { EditorShellComponent } from './editor-shell.component';
import { executeIntent, resolveKeydown, resolveKeyup } from './editor-command-router';

/** Route a keydown through the command router; `preventDefault` only when a
 *  command claimed the key, so unclaimed keys keep their browser default. */
export function handleEditorKeydown(shell: EditorShellComponent, e: KeyboardEvent): void {
  const bound = resolveKeydown(shell, e);
  if (!bound) return;
  e.preventDefault();
  executeIntent(shell, shell.commandRouter, bound);
}

/** Route a keyup — only the before/after release resolves to anything. */
export function handleEditorKeyup(shell: EditorShellComponent, e: KeyboardEvent): void {
  const bound = resolveKeyup(shell, e);
  if (!bound) return;
  executeIntent(shell, shell.commandRouter, bound);
}
