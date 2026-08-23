// MuiDiagnostics — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Validation-check runs plus raw
// output, built from Button, CodeBlock, Badge.
//
// Badge only has two pill tones (`count` = neutral, `signal` = warn), so a
// failing check gets `signal` and pending/passing checks get `count` — the
// pill's text ("Pass"/"Fail"/"Pending") carries the rest of the meaning.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { MuiBadgeVariant } from '../badge/mui-badge.component';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiCodeBlockComponent } from '../code-block/mui-code-block.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiDiagnosticCheckStatus = 'pending' | 'pass' | 'fail';

export interface MuiDiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly status: MuiDiagnosticCheckStatus;
}

const STATUS_LABEL: Record<MuiDiagnosticCheckStatus, string> = {
  pending: 'Pending',
  pass: 'Pass',
  fail: 'Fail',
};

const STATUS_BADGE_VARIANT: Record<MuiDiagnosticCheckStatus, MuiBadgeVariant> = {
  pending: 'count',
  pass: 'count',
  fail: 'signal',
};

@Component({
  selector: 'mui-diagnostics',
  standalone: true,
  imports: [MuiBadgeComponent, MuiButtonComponent, MuiCodeBlockComponent, MuiTextComponent],
  templateUrl: './mui-diagnostics.component.html',
  styleUrl: './mui-diagnostics.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDiagnosticsComponent {
  readonly checks = input.required<readonly MuiDiagnosticCheck[]>();
  readonly output = input<string>('');
  readonly running = input<boolean>(false);

  readonly runRequested = output<void>();

  readonly statusLabel = STATUS_LABEL;
  readonly statusBadgeVariant = STATUS_BADGE_VARIANT;
}
