// editor-page.component.ts — responsive-program S5 (#625).
//
// Route surface for `/library/editor/:id`. Pulls the asset id from the
// route, looks up the filename via LibraryStateService, and renders the
// editor. On dismiss, navigates back to `/library`.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { LibraryStateService } from '../state/library-state.service';
import { EditorComponent } from './editor.component';

@Component({
  selector: 'app-editor-page',
  standalone: true,
  imports: [EditorComponent],
  template: `
    @if (assetId()) {
      <app-editor
        [assetId]="assetId()!"
        [filename]="filename()"
        (dismiss)="onDismiss()"
        (info)="onInfo()"
        (share)="onShare()"
      ></app-editor>
    }
  `,
  styles: `
    :host {
      display: block;
      height: 100vh;
      width: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly library = inject(LibraryStateService);

  protected readonly paramMap = toSignal(this.route.paramMap, { requireSync: true });

  protected readonly assetId = computed(() => this.paramMap().get('id'));

  protected readonly filename = computed(() => {
    const id = this.assetId();
    if (!id) return '';
    // Best-effort lookup against the existing store. If the asset isn't
    // loaded into the store yet (e.g. direct URL navigation in dev),
    // fall back to the id itself.
    try {
      const adj = this.library.adjustmentFor(id);
      // adjustment signal proves the id exists; filename isn't on the
      // model — fall back to id for v0.1.
      void adj;
    } catch {
      /* asset not loaded */
    }
    return id;
  });

  protected onDismiss(): void {
    // Return to Preview for the current asset so Back lands where the user
    // came from (Preview → Edit → Back), rather than always bouncing to the
    // library grid.
    const id = this.assetId();
    void this.router.navigate(id ? ['/view', id] : ['/library']);
  }

  protected onInfo(): void {
    // S6 bottom-sheet wiring lands in the Info / Inspector sub-project.
    // v0.1 placeholder: no-op.
  }

  protected onShare(): void {
    // Share is a stub for v0.1 per spec §2.
  }
}
