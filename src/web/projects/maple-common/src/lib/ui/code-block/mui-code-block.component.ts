// MuiCodeBlock — the Maple UI design-system Code Block molecule
// (unified-component-catalog.md §2.7; Built from: Text, Button). A
// monospace block with a copy-to-clipboard button; briefly flips to a
// "Copied" state after a successful copy.

import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';

const COPIED_RESET_MS = 1500;

@Component({
  selector: 'mui-code-block',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './mui-code-block.component.html',
  styleUrl: './mui-code-block.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCodeBlockComponent {
  readonly code = input.required<string>();
  readonly language = input<string | null>(null);

  readonly copied = signal(false);
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code());
      this.copied.set(true);
      if (this.resetTimer !== null) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.copied.set(false), COPIED_RESET_MS);
    } catch {
      // Clipboard access can be denied by the browser (permissions,
      // insecure context) — the button silently stays in its un-copied
      // state rather than throwing into the click handler.
    }
  }
}
