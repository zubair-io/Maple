// MapleIcon — tiny stroke-icon set ported verbatim from _design-reference/lib/primitives.jsx.
// Every path/rect/circle below matches the reference exactly.

import { Component, input } from '@angular/core';

export type MapleIconName =
  | 'chevron-right' | 'chevron-down'
  | 'folder' | 'folder-open'
  | 'photos' | 'heart' | 'check' | 'x' | 'plus'
  | 'search' | 'star' | 'star-filled'
  | 'flag' | 'dot' | 'sort' | 'filter'
  | 'grid-sm' | 'grid-lg'
  | 'info' | 'droplet' | 'tag' | 'scope'
  | 'back' | 'zoom-in' | 'zoom-out' | 'split'
  | 'export' | 'eyedrop' | 'map-pin' | 'camera'
  | 'history' | 'copy' | 'paste' | 'revert'
  | 'sidebar' | 'inspector' | 'filmstrip';

@Component({
  selector: 'maple-icon',
  standalone: true,
  imports: [],
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 16 16"
      [style.display]="'block'"
      [style.color]="color()"
    >
      <!-- chevron-right -->
      @if (name() === 'chevron-right') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M6 3l5 5-5 5"/>
      }
      <!-- chevron-down -->
      @if (name() === 'chevron-down') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M3 6l5 5 5-5"/>
      }
      <!-- folder -->
      @if (name() === 'folder') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/>
      }
      <!-- folder-open -->
      @if (name() === 'folder-open') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v.5H2.5L2 12a1 1 0 001 1h10l1-5.5"/>
      }
      <!-- photos -->
      @if (name() === 'photos') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2.5" y="3.5" width="11" height="9" rx="1.5"/>
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="6" cy="7" r="1"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M13 10l-3-3-5 5"/>
      }
      <!-- heart -->
      @if (name() === 'heart') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 13s-5-2.8-5-6.3A2.7 2.7 0 018 5a2.7 2.7 0 015 1.7C13 10.2 8 13 8 13z"/>
      }
      <!-- check -->
      @if (name() === 'check') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M3 8l3.5 3.5L13 5"/>
      }
      <!-- x -->
      @if (name() === 'x') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M4 4l8 8M12 4l-8 8"/>
      }
      <!-- plus -->
      @if (name() === 'plus') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 3v10M3 8h10"/>
      }
      <!-- search -->
      @if (name() === 'search') {
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="7" cy="7" r="4"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M10 10l3 3"/>
      }
      <!-- star (outline) -->
      @if (name() === 'star') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z"/>
      }
      <!-- star-filled -->
      @if (name() === 'star-filled') {
        <path [attr.fill]="color()" stroke="none"
          d="M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z"/>
      }
      <!-- flag -->
      @if (name() === 'flag') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M4 2v12M4 3h8l-2 2.5L12 8H4"/>
      }
      <!-- dot -->
      @if (name() === 'dot') {
        <circle [attr.fill]="color()" stroke="none" cx="8" cy="8" r="2.5"/>
      }
      <!-- sort -->
      @if (name() === 'sort') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M4 4l2-2 2 2M6 2v10M12 12l-2 2-2-2M10 14V4"/>
      }
      <!-- filter -->
      @if (name() === 'filter') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2.5 3.5h11l-4 5v4l-3 1.5V8.5l-4-5z"/>
      }
      <!-- grid-sm -->
      @if (name() === 'grid-sm') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="2.5"  y="2.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="6.5"  y="2.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="10.5" y="2.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="2.5"  y="6.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="6.5"  y="6.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="10.5" y="6.5"  width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="2.5"  y="10.5" width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="6.5"  y="10.5" width="3" height="3"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="10.5" y="10.5" width="3" height="3"/>
      }
      <!-- grid-lg -->
      @if (name() === 'grid-lg') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="2.5" y="2.5" width="4.5" height="4.5"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="9"   y="2.5" width="4.5" height="4.5"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="2.5" y="9"   width="4.5" height="4.5"/>
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()" fill="none" x="9"   y="9"   width="4.5" height="4.5"/>
      }
      <!-- info -->
      @if (name() === 'info') {
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="8" cy="8" r="5.5"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 7.5v3.5M8 5.5v.01"/>
      }
      <!-- droplet -->
      @if (name() === 'droplet') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 2.5S3.5 7 3.5 10A4.5 4.5 0 008 14.5 4.5 4.5 0 0012.5 10C12.5 7 8 2.5 8 2.5z"/>
      }
      <!-- tag -->
      @if (name() === 'tag') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2.5 8.5l6 6 6-6V2.5h-6l-6 6z"/>
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="10" cy="6" r="1"/>
      }
      <!-- scope -->
      @if (name() === 'scope') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2 13h2l1-4 1 6 1-8 1 10 1-7 1 5 1-3 1 2h3"/>
      }
      <!-- back -->
      @if (name() === 'back') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M10 3L5 8l5 5M5 8h9"/>
      }
      <!-- zoom-in -->
      @if (name() === 'zoom-in') {
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="7" cy="7" r="4"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M10 10l3 3M7 5v4M5 7h4"/>
      }
      <!-- zoom-out -->
      @if (name() === 'zoom-out') {
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="7" cy="7" r="4"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M10 10l3 3M5 7h4"/>
      }
      <!-- split -->
      @if (name() === 'split') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2.5" y="3.5" width="11" height="9" rx="1"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 3.5v9"/>
      }
      <!-- export -->
      @if (name() === 'export') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 2.5v8M5 5.5l3-3 3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2"/>
      }
      <!-- eyedrop -->
      @if (name() === 'eyedrop') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M11 2.5l2.5 2.5-1.5 1.5L10.5 5l-5.5 5.5L3 12l-.5 1.5 1.5-.5 1.5-1.5L11 6l-1-1 1.5-1.5z"/>
      }
      <!-- map-pin -->
      @if (name() === 'map-pin') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 14s-4.5-4-4.5-7.5A4.5 4.5 0 018 2a4.5 4.5 0 014.5 4.5C12.5 10 8 14 8 14z"/>
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="8" cy="6.5" r="1.5"/>
      }
      <!-- camera -->
      @if (name() === 'camera') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2.5" y="4.5" width="11" height="8" rx="1.5"/>
        <circle [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          cx="8" cy="8.5" r="2.5"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M6 4.5l1-1.5h2l1 1.5"/>
      }
      <!-- history -->
      @if (name() === 'history') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2.5 8a5.5 5.5 0 105.5-5.5c-1.8 0-3.4.9-4.4 2.3M2.5 2.5v2.5H5"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M8 5v3.2l2 1.3"/>
      }
      <!-- copy -->
      @if (name() === 'copy') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="5.5" y="5.5" width="8" height="8" rx="1"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M3.5 10.5v-7a1 1 0 011-1h7"/>
      }
      <!-- paste -->
      @if (name() === 'paste') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="3.5" y="4.5" width="9" height="9" rx="1"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M6 4.5V3h4v1.5M6 3h4"/>
      }
      <!-- revert -->
      @if (name() === 'revert') {
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M2.5 3v3.5H6"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M3 6.5A5.5 5.5 0 118 13.5"/>
      }
      <!-- sidebar -->
      @if (name() === 'sidebar') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2" y="3.5" width="12" height="9" rx="1.5"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M6 3.5v9"/>
        <path [attr.fill]="color()" stroke="none" opacity="0.3"
          d="M2.5 4.5H5.5v7H2.5z"/>
      }
      <!-- inspector -->
      @if (name() === 'inspector') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2" y="3.5" width="12" height="9" rx="1.5"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M10 3.5v9"/>
        <path [attr.fill]="color()" stroke="none" opacity="0.3"
          d="M10.5 4.5H13.5v7H10.5z"/>
      }
      <!-- filmstrip -->
      @if (name() === 'filmstrip') {
        <rect [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          x="2.5" y="2.5" width="11" height="11" rx="1"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M4 4v8M12 4v8"/>
        <path [attr.stroke]="color()" [attr.stroke-width]="strokeWidth()"
          fill="none" stroke-linecap="round" stroke-linejoin="round"
          d="M4 7h1M4 9h1M11 7h1M11 9h1"/>
      }
    </svg>
  `,
})
export class MapleIconComponent {
  name        = input.required<MapleIconName>();
  size        = input<number>(14);
  color       = input<string>('currentColor');
  strokeWidth = input<number>(1.5);
}
