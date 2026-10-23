import { ChangeDetectionStrategy, Component, effect, inject, OnDestroy } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryPickerComponent } from '../library-picker/library-picker.component';
import { MuiOverlayShellComponent } from '../../ui/overlay-shell/mui-overlay-shell.component';

@Component({
  selector: 'app-library-picker-modal',
  standalone: true,
  imports: [LibraryPickerComponent, MuiOverlayShellComponent],
  templateUrl: './library-picker-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerModalComponent implements OnDestroy {
  readonly state = inject(LibraryStateService);
  private opener: HTMLElement | null = null;

  constructor() {
    effect(() => {
      if (this.state.pickerVisible()) {
        this.opener ??=
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      } else this.restoreFocus();
    });
  }

  ngOnDestroy(): void {
    this.restoreFocus();
  }

  private restoreFocus(): void {
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }

  onPick(absPath: string): void {
    this.state.addLibraryFolder(absPath);
    // addLibraryFolder closes the picker on success; on failure it stays open.
  }

  onCancel(): void {
    this.state.closeLibraryPicker();
  }
}
