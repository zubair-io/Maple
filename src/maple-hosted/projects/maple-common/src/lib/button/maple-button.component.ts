// MapleButton — themed button primitive.
// Used for toolbar actions; variants match the reference's PillButton / SmallBtn styles.

import { Component, input, output } from '@angular/core';
import { MapleIconComponent, MapleIconName } from '../icons/maple-icon.component';

export type MapleButtonVariant = 'primary' | 'secondary' | 'ghost' | 'pill' | 'small';
export type MapleButtonSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'maple-button',
  standalone: true,
  imports: [MapleIconComponent],
  styles: [`
    :host { display: inline-flex; }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-family: var(--maple-font);
      font-size: 11px;
      border: none;
      cursor: pointer;
      transition: background 120ms, color 120ms;
      outline: none;
      white-space: nowrap;
    }

    button:disabled { opacity: 0.45; cursor: default; }

    /* Variants */
    button.primary {
      background: var(--maple-primary);
      color: #fff;
      border-radius: 5px;
      padding: 0 12px;
      height: 28px;
      border: 0.5px solid var(--maple-primary);
    }
    button.primary:not(:disabled):hover { filter: brightness(1.12); }

    button.secondary {
      background: var(--maple-surface);
      color: var(--maple-text-main);
      border: 0.5px solid var(--maple-border);
      border-radius: 5px;
      padding: 0 10px;
      height: 26px;
    }
    button.secondary:not(:disabled):hover { background: var(--maple-surface-hover); }

    button.ghost {
      background: transparent;
      color: var(--maple-text-muted);
      border: none;
      border-radius: 4px;
      padding: 0 8px;
      height: 24px;
    }
    button.ghost:not(:disabled):hover { background: var(--maple-bg-hover); color: var(--maple-text-main); }

    button.pill {
      height: 22px;
      padding: 0 8px;
      border-radius: 4px;
      background: var(--maple-surface);
      color: var(--maple-text-main);
      border: 0.5px solid var(--maple-border);
    }
    button.pill:not(:disabled):hover { background: var(--maple-surface-hover); }
    button.pill.active {
      background: var(--maple-primary-dim);
      color: var(--maple-primary);
      border-color: var(--maple-primary);
    }

    button.small {
      flex: 1;
      height: 26px;
      border-radius: 4px;
      background: var(--maple-input-bg);
      color: var(--maple-text-main);
      border: 0.5px solid var(--maple-border);
    }
    button.small:not(:disabled):hover { background: var(--maple-surface-hover); }

    /* Sizes (override height for primary/secondary) */
    button.size-sm { height: 22px; font-size: 10px; }
    button.size-lg { height: 32px; font-size: 12px; }
  `],
  template: `
    <button
      [class]="variant() + ' size-' + size()"
      [class.active]="active()"
      [disabled]="disabled()"
      (click)="clicked.emit($event)"
    >
      @if (iconLeft()) {
        <maple-icon [name]="iconLeft()!" [size]="11"/>
      }
      <ng-content/>
      @if (iconRight()) {
        <maple-icon [name]="iconRight()!" [size]="11"/>
      }
    </button>
  `,
})
export class MapleButtonComponent {
  variant  = input<MapleButtonVariant>('secondary');
  size     = input<MapleButtonSize>('md');
  active   = input<boolean>(false);
  disabled = input<boolean>(false);
  iconLeft  = input<MapleIconName | null>(null);
  iconRight = input<MapleIconName | null>(null);

  clicked = output<MouseEvent>();
}
