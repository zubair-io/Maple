// MapleButton — themed button primitive.
// Used for toolbar actions; variants match the reference's PillButton / SmallBtn styles.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MapleIconComponent, MapleIconName } from '../icons/maple-icon.component';

export type MapleButtonVariant = 'primary' | 'secondary' | 'ghost' | 'pill' | 'small';
export type MapleButtonSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'maple-button',
  standalone: true,
  imports: [MapleIconComponent],
  styles: [
    `
      :host {
        display: inline-flex;
      }
      /* Pill-active state. Tailwind utilities for the base "pill" colors
         (bg-surface / text-text-main / border-border) and the active-state
         overrides (bg-primary-dim / text-primary / border-primary) have
         identical specificity, so the overlap depends on declaration order
         in the compiled stylesheet. Express the active override as a small
         class-scoped rule so the cascade is deterministic regardless of
         utility-class generation order. */
      button.pill-active {
        background: var(--color-primary-dim);
        color: var(--color-primary);
        border-color: var(--color-primary);
      }
    `,
  ],
  template: `
    <button
      class="inline-flex items-center justify-center gap-1 whitespace-nowrap border-none text-[11px] outline-none transition-[background,color] duration-[120ms] cursor-pointer disabled:cursor-default disabled:opacity-45"
      [class]="variantClasses()"
      [class.pill-active]="variant() === 'pill' && active()"
      [disabled]="disabled()"
      (click)="clicked.emit($event)"
    >
      @if (iconLeft()) {
        <maple-icon [name]="iconLeft()!" [size]="11" />
      }
      <ng-content />
      @if (iconRight()) {
        <maple-icon [name]="iconRight()!" [size]="11" />
      }
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleButtonComponent {
  variant = input<MapleButtonVariant>('secondary');
  size = input<MapleButtonSize>('md');
  active = input<boolean>(false);
  disabled = input<boolean>(false);
  iconLeft = input<MapleIconName | null>(null);
  iconRight = input<MapleIconName | null>(null);

  clicked = output<MouseEvent>();

  // Tailwind utility classes per variant + size. Active state for "pill" is
  // applied via separate [class.*] bindings on the template so the override
  // wins regardless of declaration order.
  readonly variantClasses = computed(() => {
    const v = this.variant();
    const s = this.size();

    // Variant base classes (background, color, border, padding, height).
    const variantMap: Record<MapleButtonVariant, string> = {
      primary:
        'bg-primary text-white rounded-[5px] px-3 h-7 border-[0.5px] border-primary not-disabled:hover:brightness-110',
      secondary:
        'bg-surface text-text-main border-[0.5px] border-border rounded-[5px] px-2.5 h-[26px] not-disabled:hover:bg-surface-hover',
      ghost:
        'bg-transparent text-text-muted border-none rounded px-2 h-6 not-disabled:hover:bg-bg-hover not-disabled:hover:text-text-main',
      pill:
        'h-[22px] px-2 rounded bg-surface text-text-main border-[0.5px] border-border not-disabled:hover:bg-surface-hover',
      small:
        'flex-1 h-[26px] rounded bg-input-bg text-text-main border-[0.5px] border-border not-disabled:hover:bg-surface-hover',
    };

    // Size override (height + font-size). md is the variant default; only sm/lg override.
    const sizeMap: Record<MapleButtonSize, string> = {
      sm: 'h-[22px] text-[10px]',
      md: '',
      lg: 'h-8 text-xs',
    };

    return `${variantMap[v]} ${sizeMap[s]}`.trim();
  });
}
