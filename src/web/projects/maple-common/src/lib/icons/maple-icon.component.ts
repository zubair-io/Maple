// MapleIcon — tiny stroke-icon set ported from _design-reference/lib/primitives.jsx.
// Icon paths live in `maple-icon-registry.ts` so the template stays a tiny
// renderer (single <svg> with three primitive cases).

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ICON_SHAPES, MapleIconName } from './maple-icon-registry';

export type { MapleIconName } from './maple-icon-registry';

@Component({
    selector: 'maple-icon',
    standalone: true,
    imports: [],
    templateUrl: './maple-icon.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleIconComponent {
    name = input.required<MapleIconName>();
    size = input<number>(14);
    color = input<string>('currentColor');
    strokeWidth = input<number>(1.5);

    readonly shapes = computed(() => ICON_SHAPES[this.name()]);
}
