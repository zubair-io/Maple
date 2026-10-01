import type { RemovalModelId } from '../../generated/removal-models.generated';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { MuiSegmentedToggleComponent } from '../../ui/segmented-toggle/mui-segmented-toggle.component';
import {
  RemovalEditorSession,
  type RemovalMode,
} from '../../removal/removal-editor-session.service';

@Component({
  selector: 'editor-removal-panel',
  standalone: true,
  imports: [MuiButtonComponent, MuiLivingSliderComponent, MuiSegmentedToggleComponent],
  templateUrl: './removal-panel.component.html',
  styleUrl: './removal-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemovalPanelComponent {
  protected readonly session = inject(RemovalEditorSession);
  protected readonly installing = signal(false);
  protected readonly installError = signal('');
  protected readonly modes = [
    { value: 'paint', label: 'Paint' },
    { value: 'smart', label: 'Smart paint' },
    { value: 'people', label: 'People' },
  ];
  protected setMode(mode: string): void {
    if (mode === 'paint' || mode === 'smart' || mode === 'people')
      this.session.setMode(mode as RemovalMode);
  }
  protected async uninstall(id: RemovalModelId): Promise<void> {
    this.installing.set(true);
    this.installError.set('');
    try {
      await this.session.models.uninstall(id);
      await this.session.modelsChanged();
    } catch (error) {
      this.installError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.installing.set(false);
    }
  }
  protected async install(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    this.installing.set(true);
    this.installError.set('');
    try {
      for (const file of files) await this.session.models.install(file);
      await this.session.modelsChanged();
    } catch (error) {
      this.installError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.installing.set(false);
      input.value = '';
    }
  }
}
