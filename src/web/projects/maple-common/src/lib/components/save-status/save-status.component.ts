import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SidecarSaveStateService } from '../../xmp/sidecar-save-state.service';

@Component({
  selector: 'maple-save-status',
  standalone: true,
  templateUrl: './save-status.component.html',
  styleUrl: './save-status.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveStatusComponent {
  protected readonly saveState = inject(SidecarSaveStateService);
}
