// MuiAvatar — the Maple UI design-system Avatar atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/avatar.md). Shows a user's photo when one
// loads; otherwise falls back to 1–2 initials derived from `name` on a
// deterministically hashed background so the same person always gets the
// same fallback color, without needing per-user color storage anywhere.

import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';

export type MuiAvatarSize = 'xs' | 'sm' | 'md' | 'lg';
export type MuiAvatarPresence = 'online' | 'offline';

// Small token-derived palette — each entry pairs a themed background with a
// legible foreground, no invented hex values. Cycled deterministically by
// name hash so a given name always lands on the same swatch.
const FALLBACK_PALETTE: readonly { bg: string; fg: string }[] = [
  { bg: 'var(--color-primary)', fg: 'var(--color-text-main)' },
  { bg: 'var(--color-primary-dim)', fg: 'var(--color-text-main)' },
  { bg: 'var(--color-surface-hover)', fg: 'var(--color-text-main)' },
  { bg: 'var(--color-warn)', fg: 'var(--color-bg)' },
  { bg: 'var(--color-border-hi)', fg: 'var(--color-text-main)' },
];

/** Simple deterministic string hash (djb2) — same input always yields the
 * same output, across runs and platforms, unlike relying on object identity
 * or insertion order. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash);
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

@Component({
  selector: 'mui-avatar',
  standalone: true,
  templateUrl: './mui-avatar.component.html',
  styleUrl: './mui-avatar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAvatarComponent {
  readonly name = input.required<string>();
  readonly src = input<string | null>(null);
  readonly size = input<MuiAvatarSize>('md');
  readonly presence = input<MuiAvatarPresence | null>(null);

  readonly broken = signal(false);

  readonly initials = computed(() => initialsOf(this.name()));
  readonly fallbackColor = computed(
    () => FALLBACK_PALETTE[hashString(this.name()) % FALLBACK_PALETTE.length],
  );
  readonly showImage = computed(() => !!this.src() && !this.broken());

  constructor() {
    effect(() => {
      this.src();
      this.broken.set(false);
    });
  }

  onError(): void {
    this.broken.set(true);
  }
}
