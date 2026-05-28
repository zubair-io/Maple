// layout-service.ts — responsive-program S0a (epic #577, ticket #581).
//
// Single source of truth for the active breakpoint on the web side. Apple's
// `MapleLayout.from(width:)` enum (Sources/MapleCore/Layout/MapleLayout.swift)
// mirrors these thresholds exactly. Any breakpoint change must land on both
// platforms in the same commit.
//
// Components read `LayoutService.layout()` (a computed signal). Do NOT
// branch on `window.innerWidth` directly in components — the layout signal
// is the only source of truth.
//
// Spec: docs/spec/responsive-program-s0-primitives.md §2.

import { Injectable, signal, computed, type Signal } from '@angular/core';

export type MapleLayout = 'phone' | 'tablet' | 'desktop';

/**
 * Single source of truth for the breakpoint thresholds. Mirrors
 * `MapleLayout.from(width:)` in MapleCore/Layout/MapleLayout.swift.
 */
export function mapleLayoutFromWidth(width: number): MapleLayout {
  if (width < 768) return 'phone';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _width = signal<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  readonly layout: Signal<MapleLayout> = computed(() =>
    mapleLayoutFromWidth(this._width()),
  );

  constructor() {
    if (typeof window === 'undefined') {
      // SSR / non-browser env — keep the default-desktop initial signal.
      return;
    }
    window.addEventListener(
      'resize',
      () => this._width.set(window.innerWidth),
      { passive: true },
    );
  }
}
