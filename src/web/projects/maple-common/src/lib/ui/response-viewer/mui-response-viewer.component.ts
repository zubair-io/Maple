// MuiResponseViewer — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Formatted response with status, built from Code Block, Badge, Tabs.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiCodeBlockComponent } from '../code-block/mui-code-block.component';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

const TABS: readonly MuiTab[] = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
];

@Component({
  selector: 'mui-response-viewer',
  standalone: true,
  imports: [MuiBadgeComponent, MuiCodeBlockComponent, MuiTabsComponent],
  templateUrl: './mui-response-viewer.component.html',
  styleUrl: './mui-response-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiResponseViewerComponent {
  readonly status = input.required<number>();
  readonly statusText = input<string>('');
  readonly body = input.required<string>();
  readonly headers = input<string>('');

  readonly activeId = model<string>('body');
  readonly tabs = TABS;

  readonly statusLabel = computed(() => `${this.status()} ${this.statusText()}`.trim());
  readonly statusVariant = computed(() => (this.status() < 400 ? 'signal' : 'count'));
  readonly activeContent = computed(() =>
    this.activeId() === 'headers' ? this.headers() : this.body(),
  );
}
