// SettingsIconComponent — compact SVG icon set used across the redesigned
// Settings surfaces. The glyphs are copied from the Claude Design handoff
// (`Spec Settings.html` → settings/shared.jsx) so the visual language stays
// faithful to the prototype. Names that aren't recognised render an empty
// circle so callers fail visibly rather than silently.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type SettingsIconName =
  | 'back'
  | 'chev-r'
  | 'chev-d'
  | 'user'
  | 'gear'
  | 'people'
  | 'key'
  | 'play'
  | 'pause'
  | 'retry'
  | 'check'
  | 'x'
  | 'plus'
  | 'dot'
  | 'sparkle'
  | 'pipe'
  | 'globe'
  | 'eye'
  | 'face'
  | 'hash'
  | 'image'
  | 'search'
  | 'exif'
  | 'thumb'
  | 'test'
  | 'copy'
  | 'open'
  | 'kebab'
  | 'edit'
  | 'merge'
  | 'wifi';

@Component({
  selector: 'maple-settings-icon',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 16 16"
      [style.color]="color()"
      aria-hidden="true"
    >
      @switch (name()) {
        @case ('back') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10 2L4 8l6 6"
          />
        }
        @case ('chev-r') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M6 3l5 5-5 5"
          />
        }
        @case ('chev-d') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 6l5 5 5-5"
          />
        }
        @case ('user') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="5"
            r="2.5"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 14c0-3 2-5 5-5s5 2 5 5"
          />
        }
        @case ('gear') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="8"
            r="2.2"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"
          />
        }
        @case ('people') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="5.5"
            cy="6"
            r="2"
          />
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="11"
            cy="6"
            r="2"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 14c0-2 1.5-3.5 3.5-3.5S9 12 9 14M8.5 14c0-2 1.5-3.5 3.5-3.5S15.5 12 15.5 14"
          />
        }
        @case ('key') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="5"
            cy="11"
            r="3"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M7 9l6-6M11 3l2 2M9 5l2 2"
          />
        }
        @case ('play') {
          <path fill="currentColor" d="M4 3l9 5-9 5z" />
        }
        @case ('pause') {
          <rect fill="currentColor" x="4" y="3" width="3" height="10" rx="0.5" />
          <rect fill="currentColor" x="9" y="3" width="3" height="10" rx="0.5" />
        }
        @case ('retry') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2.5 8a5.5 5.5 0 109.5-3.8M12.5 2v3h-3"
          />
        }
        @case ('check') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 8l3.5 3.5L13 4"
          />
        }
        @case ('x') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 3l10 10M13 3L3 13"
          />
        }
        @case ('plus') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M8 3v10M3 8h10"
          />
        }
        @case ('dot') {
          <circle fill="currentColor" cx="8" cy="8" r="3.5" />
        }
        @case ('sparkle') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2"
          />
        }
        @case ('pipe') {
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="2"
            y="5"
            width="3"
            height="6"
            rx=".5"
          />
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="6.5"
            y="5"
            width="3"
            height="6"
            rx=".5"
          />
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="11"
            y="5"
            width="3"
            height="6"
            rx=".5"
          />
        }
        @case ('globe') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="8"
            r="6"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 8h12M8 2c2 1.5 3 4 3 6s-1 4.5-3 6c-2-1.5-3-4-3-6s1-4.5 3-6z"
          />
        }
        @case ('eye') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5S1 8 1 8z"
          />
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="8"
            r="2"
          />
        }
        @case ('face') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="8"
            r="6"
          />
          <circle fill="currentColor" cx="6" cy="7" r=".7" />
          <circle fill="currentColor" cx="10" cy="7" r=".7" />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5.5 10.5c.7.8 1.6 1.2 2.5 1.2s1.8-.4 2.5-1.2"
          />
        }
        @case ('hash') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5 2l-1 12M11 2l-1 12M2 5h12M2 11h12"
          />
        }
        @case ('image') {
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="2"
            y="3"
            width="12"
            height="10"
            rx="1"
          />
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="6"
            cy="7"
            r="1"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 11l3-3 4 4 2-2 3 3"
          />
        }
        @case ('search') {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="7"
            cy="7"
            r="4.5"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10.5 10.5L14 14"
          />
        }
        @case ('exif') {
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="2"
            y="3"
            width="12"
            height="10"
            rx="1"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5 6h6M5 8h6M5 10h4"
          />
        }
        @case ('thumb') {
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="2"
            y="2"
            width="5"
            height="5"
            rx="1"
          />
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="9"
            y="2"
            width="5"
            height="5"
            rx="1"
          />
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="2"
            y="9"
            width="5"
            height="5"
            rx="1"
          />
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="9"
            y="9"
            width="5"
            height="5"
            rx="1"
          />
        }
        @case ('test') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 14h12M8 11V3M5 6l3-3 3 3"
          />
        }
        @case ('copy') {
          <rect
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            x="5"
            y="2"
            width="9"
            height="9"
            rx="1"
          />
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M11 11v2a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1h2"
          />
        }
        @case ('open') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M8 3H4a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M10 2h4v4M14 2l-6 6"
          />
        }
        @case ('kebab') {
          <circle fill="currentColor" cx="8" cy="3" r="1.2" />
          <circle fill="currentColor" cx="8" cy="8" r="1.2" />
          <circle fill="currentColor" cx="8" cy="13" r="1.2" />
        }
        @case ('edit') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 13l1-3 7-7 2 2-7 7-3 1zM10 4l2 2"
          />
        }
        @case ('merge') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5 13V8a3 3 0 013-3h0a3 3 0 013 3v5M11 13V3M11 3l-2 2M11 3l2 2"
          />
        }
        @case ('wifi') {
          <path
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 6c3.3-3 8.7-3 12 0M4.3 8.8c2.2-2 5.2-2 7.4 0M6.7 11.5a3 3 0 012.6 0"
          />
          <circle fill="currentColor" cx="8" cy="13.2" r="1" />
        }
        @default {
          <circle
            [attr.stroke-width]="stroke()"
            stroke="currentColor"
            fill="none"
            cx="8"
            cy="8"
            r="3"
          />
        }
      }
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        line-height: 0;
      }
    `,
  ],
})
export class SettingsIconComponent {
  readonly name = input.required<SettingsIconName>();
  readonly size = input<number>(16);
  readonly color = input<string>('currentColor');
  readonly stroke = input<number>(1.6);
}
