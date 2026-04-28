import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryPickerComponent } from '../library-picker/library-picker.component';

@Component({
  selector: 'app-library-picker-modal',
  standalone: true,
  imports: [LibraryPickerComponent],
  templateUrl: './library-picker-modal.component.html',
  styleUrl: './library-picker-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerModalComponent {
  readonly state = inject(LibraryStateService);

  onPick(absPath: string): void {
    this.state.addLibraryFolder(absPath);
    // addLibraryFolder closes the picker on success; on failure it stays open.
  }

  onCancel(): void {
    this.state.closeLibraryPicker();
  }

  onBackdropClick(): void {
    this.state.closeLibraryPicker();
  }
}
