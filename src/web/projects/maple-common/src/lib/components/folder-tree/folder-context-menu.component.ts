// FolderContextMenuComponent — floating right-click/long-press/keyboard
// menu for a folder-tree row (#2643).
//
// Positioned at a caller-supplied viewport point (`x`/`y`), clamped to stay
// on-screen. Keyboard-navigable per WAI-ARIA menu pattern: ArrowUp/Down
// cycle focus, Home/End jump to the ends, Escape and outside-click close.
// Disabled items stay in the DOM (so screen readers announce them) but are
// skipped by arrow navigation and inert to click.
//
// The caller owns focus-return: it should record the element that opened
// the menu and re-focus it from the `closeMenu` handler. This component
// only focuses its own first enabled item on open.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  AfterViewInit,
  input,
  output,
} from '@angular/core';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';

export interface FolderMenuItem {
  id: string;
  label: string;
  icon: MapleIconName;
  destructive?: boolean;
  disabled?: boolean;
  /** Shown as a `title` tooltip on a disabled item — the "disabled with an
   * explanation, never a silent omission" rule from the file-management
   * design doc. */
  disabledReason?: string;
}

const MENU_MARGIN = 8;

@Component({
  selector: 'app-folder-context-menu',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './folder-context-menu.component.html',
  styleUrl: './folder-context-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderContextMenuComponent implements AfterViewInit {
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly items = input.required<FolderMenuItem[]>();
  readonly menuLabel = input<string>('Folder actions');

  readonly action = output<string>();
  readonly closeMenu = output<void>();

  @ViewChild('menuRoot') private menuRootRef?: ElementRef<HTMLElement>;

  /** Outside-mousedown handling is suppressed for one tick after open —
   * otherwise the same physical click/long-press that opened the menu can
   * immediately close it again before the browser finishes dispatching. */
  private acceptOutsideClicks = false;

  ngAfterViewInit(): void {
    this.clampToViewport();
    this.focusItemAt(0);
    queueMicrotask(() => {
      this.acceptOutsideClicks = true;
    });
  }

  private get root(): HTMLElement | null {
    return this.menuRootRef?.nativeElement ?? null;
  }

  /** Keep the menu fully on-screen — a row near the right/bottom edge
   * would otherwise open a menu that's partly clipped and unreachable by
   * mouse or touch. */
  private clampToViewport(): void {
    const el = this.root;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN);
    const maxTop = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN);
    el.style.left = `${Math.min(this.x(), maxLeft)}px`;
    el.style.top = `${Math.min(this.y(), maxTop)}px`;
  }

  private enabledButtons(): HTMLButtonElement[] {
    const el = this.root;
    if (!el) return [];
    return Array.from(
      el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])'),
    );
  }

  private focusItemAt(index: number): void {
    const buttons = this.enabledButtons();
    if (buttons.length === 0) return;
    const clamped = ((index % buttons.length) + buttons.length) % buttons.length;
    buttons[clamped]?.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    const buttons = this.enabledButtons();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusItemAt(current + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.focusItemAt(current - 1);
        return;
      case 'Home':
        event.preventDefault();
        this.focusItemAt(0);
        return;
      case 'End':
        event.preventDefault();
        this.focusItemAt(buttons.length - 1);
        return;
      case 'Escape':
        event.preventDefault();
        this.closeMenu.emit();
        return;
      case 'Tab':
        // The menu has no natural next tab stop — close rather than let
        // focus leak to whatever's rendered behind it.
        event.preventDefault();
        this.closeMenu.emit();
        return;
      default:
        return;
    }
  }

  onItemClick(item: FolderMenuItem): void {
    if (item.disabled) return;
    this.action.emit(item.id);
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMousedown(event: MouseEvent): void {
    if (!this.acceptOutsideClicks) return;
    const el = this.root;
    if (el && !el.contains(event.target as Node)) {
      this.closeMenu.emit();
    }
  }
}
