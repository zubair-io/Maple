// Chrome-recede machinery for EditorShellComponent (#1535). Extracted from
// the component to keep editor-shell.component.ts under the per-file LOC
// budget. Operates on the live component via its public surface; `import
// type` keeps this a type-only (no runtime) dependency on the shell. The
// breakpoint itself is a computed (`isTabletPlus`/`isDesktop`) on the shell,
// derived from `LayoutService.layout()`; `setupResponsive` below only reacts
// to it for the recede timer.
//
// Chrome recede: dims to 30% after 3s idle; restores on pointer move
// (180ms transition, driven by the `.chrome--receded` class in the SCSS).
// Desktop (>1024px) opts out of auto-recede — chrome stays full always.
import type { EditorShellComponent } from './editor-shell.component';

/** Idle timeout before chrome recedes (ms). Desktop: never recedes. */
const RECEDE_IDLE_MS = 3000;

/** Mutable timer/listener handles, owned by the shell and passed by
 *  reference so this module can read/write them without the fields living
 *  directly on the component class. */
export interface ChromeRecedeState {
  recedeTimer: ReturnType<typeof setTimeout> | null;
  pointerMoveBound: ((e: PointerEvent) => void) | null;
}

export function newChromeRecedeState(): ChromeRecedeState {
  return { recedeTimer: null, pointerMoveBound: null };
}

export function restartRecedeTimer(shell: EditorShellComponent, state: ChromeRecedeState): void {
  clearRecedeTimer(state);
  if (shell.isDesktop()) return;
  state.recedeTimer = setTimeout(() => {
    if (!shell.scrubbing()) {
      shell.chromeState.set('receded');
    }
  }, RECEDE_IDLE_MS);
}

export function clearRecedeTimer(state: ChromeRecedeState): void {
  if (state.recedeTimer !== null) {
    clearTimeout(state.recedeTimer);
    state.recedeTimer = null;
  }
}

/** Outside-Angular-zone pointermove listener: restores full chrome on
 *  movement (phone/tablet only — desktop never recedes) and restarts the
 *  idle timer either way. */
export function setupPointerMove(shell: EditorShellComponent, state: ChromeRecedeState): void {
  if (typeof document === 'undefined') return;
  state.pointerMoveBound = (_e: PointerEvent) => {
    // Only re-enter the zone when we need to flip chromeState back to full
    // (i.e. currently receded and not on desktop). Idle-restart always runs.
    if (shell.isDesktop()) return;
    if (shell.scrubbing()) return;
    if (shell.chromeState() === 'receded') {
      shell.ngZone.run(() => {
        shell.chromeState.set('full');
        restartRecedeTimer(shell, state);
      });
    } else {
      // Already full — just restart the timer without a zone re-entry
      // (setTimeout is not tracked by Angular, so this is fine outside).
      restartRecedeTimer(shell, state);
    }
  };
  shell.ngZone.runOutsideAngular(() => {
    document.addEventListener('pointermove', state.pointerMoveBound!);
  });
}

export function teardownPointerMove(state: ChromeRecedeState): void {
  if (state.pointerMoveBound) {
    document.removeEventListener('pointermove', state.pointerMoveBound);
    state.pointerMoveBound = null;
  }
}

/** Chrome-recede reaction to the breakpoint. `isTabletPlus`/`isDesktop` are
 *  computed straight off `LayoutService.layout()` on the shell (>1024px is
 *  desktop); this function reads only `isDesktop()` and manages the auto-
 *  recede idle timer + `chromeState`. Desktop opts out of auto-recede (clear
 *  the timer, keep chrome full); phone/tablet restore full chrome and (re)
 *  start the idle timer. The caller runs this inside an `effect()` that reads
 *  `isDesktop()`, so it re-fires on every desktop↔non-desktop crossing — and
 *  because a boolean computed only notifies on a value flip, phone↔tablet
 *  resizes (which don't change `isDesktop()`) never restart the timer. It
 *  writes only `chromeState` (never a signal it reads), so it cannot self-
 *  trigger the effect. */
export function setupResponsive(shell: EditorShellComponent, state: ChromeRecedeState): void {
  if (shell.isDesktop()) {
    // Desktop opts out of auto-recede — always full.
    clearRecedeTimer(state);
    shell.chromeState.set('full');
    return;
  }
  // Phone/tablet: restore full chrome and (re)start the idle recede timer so
  // chrome auto-recedes again (also covers the initial phone/tablet load and
  // the desktop→non-desktop crossing).
  shell.chromeState.set('full');
  restartRecedeTimer(shell, state);
}
