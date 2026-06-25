// MaskChipComponent — lower-left glass chip (#1535).
// Present but DISABLED in M1 — no masking exists yet; a fake contour
// would violate CLAUDE.md principle #6. Will be activated in web M3.
// Reference: web-M3 masking milestone (#1538).

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';

@Component({
  selector: 'pro-mask-chip',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './mask-chip.component.html',
  styleUrl: './mask-chip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaskChipComponent {
  // M1: no-op — masking wired in web M3 (#1538)
}
