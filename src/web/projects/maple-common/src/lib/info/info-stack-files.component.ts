// InfoStackFilesComponent — Info "Files" section for a RAW+JPEG stack (#5846).
//
// The grid shows one tile for the pair; this lists the two files behind it
// (name, type, size) and marks the RAW as the primary.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Asset } from '../models/asset';
import { MuiTextComponent } from '../ui/text/mui-text.component';
import { stackFileRows } from './info-stack-files.vm';

@Component({
  selector: 'app-info-stack-files',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './info-stack-files.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-stack-files',
  },
})
export class InfoStackFilesComponent {
  readonly asset = input<Asset | null>(null);

  protected readonly rows = computed(() => stackFileRows(this.asset()));
}
