// MuiTimestamp — the Maple UI design-system Timestamp atom
// (docs/design/maple-ui/components/timestamp.md). Formats a point in time
// four ways (relative / short / long / time-only); the relative format
// degrades just-now → Nm → Nh → Nd → absolute date once the delta passes a
// week, so a two-year-old photo never renders as "731d ago". The full
// absolute date+time always rides along as the `title` attribute, so
// hovering any format reveals the exact instant.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiTimestampFormat = 'relative' | 'short' | 'long' | 'time-only';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Beyond this many days, relative format falls back to an absolute date
// rather than growing an ever-larger "Nd ago" count.
const RELATIVE_DAY_CEILING = 6;

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatShort(target: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(target);
}

function formatLong(target: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(target);
}

function formatTimeOnly(target: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(target);
}

function formatAbsolute(target: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(target);
}

function formatRelative(target: Date, now: Date): string {
  const deltaMs = now.getTime() - target.getTime();
  const isPast = deltaMs >= 0;
  const magnitude = Math.abs(deltaMs);

  if (magnitude < MINUTE_MS) return 'just now';

  const minutes = Math.floor(magnitude / MINUTE_MS);
  if (minutes < 60) return isPast ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.floor(magnitude / HOUR_MS);
  if (hours < 24) return isPast ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.floor(magnitude / DAY_MS);
  if (days <= RELATIVE_DAY_CEILING) return isPast ? `${days}d ago` : `in ${days}d`;

  return formatShort(target);
}

@Component({
  selector: 'mui-timestamp',
  standalone: true,
  templateUrl: './mui-timestamp.component.html',
  styleUrl: './mui-timestamp.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTimestampComponent {
  readonly value = input.required<Date | number | string>();
  readonly format = input<MuiTimestampFormat>('relative');
  /** Reference "now" for relative formatting. Defaults to the real clock at
   * construction time; tests pass a fixed value so assertions are
   * deterministic instead of racing `Date.now()`. */
  readonly now = input<Date | number>(Date.now());

  readonly date = computed(() => toDate(this.value()));

  readonly display = computed(() => {
    const target = this.date();
    switch (this.format()) {
      case 'short':
        return formatShort(target);
      case 'long':
        return formatLong(target);
      case 'time-only':
        return formatTimeOnly(target);
      case 'relative':
      default:
        return formatRelative(target, toDate(this.now()));
    }
  });

  readonly absoluteTitle = computed(() => formatAbsolute(this.date()));
}
