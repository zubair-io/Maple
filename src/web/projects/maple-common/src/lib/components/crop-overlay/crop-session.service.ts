// crop-session.service.ts — shared state for the crop tool (#638).
//
// `active` is derived from the editor's armed tool, so the crop overlay shows
// (and the live canvas renders UNCROPPED) exactly while the Crop pill is armed —
// no imperative open/close to keep in sync. The aspect lock is session-only
// transient UI state (never persisted to XMP), mirroring how the Apple side
// keeps the crop aspect on `EditorState`.

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { ASPECT_PRESETS, type AspectId, type AspectPreset } from './crop-aspect';

@Injectable({ providedIn: 'root' })
export class CropSessionService {
  private readonly editor = inject(EditorStateService);

  /** True while the Crop tool is armed — drives overlay visibility and the
   *  uncropped live render. */
  readonly active = computed(() => this.editor.armedTool() === 'crop');

  /** Selected aspect-ratio lock (transient; reset to Free on each crop entry —
   *  see the effect below — and never persisted to XMP). */
  readonly aspectId = signal<AspectId>('free');

  constructor() {
    // Reset the aspect lock to Free on every inactive→active transition so a
    // ratio chosen on one image doesn't silently carry into the next crop
    // session (the comment on `aspectId` promised this).
    let wasActive = false;
    effect(() => {
      const now = this.active();
      if (now && !wasActive) this.aspectId.set('free');
      wasActive = now;
    });
  }

  readonly aspectPreset = computed<AspectPreset>(
    () => ASPECT_PRESETS.find((p) => p.id === this.aspectId()) ?? ASPECT_PRESETS[0],
  );

  setAspect(id: AspectId): void {
    this.aspectId.set(id);
  }
}
