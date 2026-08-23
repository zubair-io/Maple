// MuiSuggestionPreview — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Proposed change with accept/reject, built from Text, Button.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-suggestion-preview',
  standalone: true,
  imports: [MuiButtonComponent, MuiTextComponent],
  templateUrl: './mui-suggestion-preview.component.html',
  styleUrl: './mui-suggestion-preview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSuggestionPreviewComponent {
  readonly description = input.required<string>();
  readonly resolved = input<'accepted' | 'rejected' | null>(null);

  readonly accepted = output<void>();
  readonly rejected = output<void>();
}
