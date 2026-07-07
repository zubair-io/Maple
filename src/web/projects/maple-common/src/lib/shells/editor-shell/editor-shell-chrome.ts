// Chrome-recede + responsive-breakpoint observer for EditorShellComponent
// (#1535). Extracted from the component to keep editor-shell.component.ts
// under the per-file LOC budget. Operates on the live component via its
// public surface; `import type` keeps this a type-only (no runtime)
// dependency on the shell.
//
// Chrome recede: dims to 30% after 3s idle; restores on pointer move
// (180ms transition, driven by the `.chrome--receded` class in the SCSS).
// Desktop (≥1100px) opts out of auto-recede — chrome stays full always.
import type { EditorShellComponent } from './editor-shell.component';

/** Idle timeout before chrome recedes (ms). Desktop: never recedes. */
const RECEDE_IDLE_MS = 3000;

/** Mutable timer/listener handles, owned by the shell and passed by
 *  reference so this module can read/write them without the fields living
 *  directly on the component class. */
export interface ChromeRecedeState {
  recedeTimer: ReturnType<typeof setTimeout> | null;
  resizeObserver: ResizeObserver | null;
  pointerMoveBound: ((e: PointerEvent) => void) | null;
}

export function newChromeRecedeState(): ChromeRecedeState {
  return { recedeTimer: null, resizeObserver: null, pointerMoveBound: null };
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

/** Responsive breakpoint observer: flips `isTabletPlus`/`isDesktop` and
 *  manages the chrome-recede idle timer across breakpoint crossings.
 *  Desktop (≥1100px) opts out of auto-recede entirely. */
export function setupResponsive(shell: EditorShellComponent, state: ChromeRecedeState): void {
  if (typeof window === 'undefined') return;
  const update = () => {
    const w = window.innerWidth;
    const wasDesktop = shell.isDesktop();
    shell.isTabletPlus.set(w >= 768);
    shell.isDesktop.set(w >= 1100);
    if (w >= 1100) {
      // Desktop opts out of auto-recede — always full
      clearRecedeTimer(state);
      shell.chromeState.set('full');
    } else if (wasDesktop) {
      // Crossed back below the desktop breakpoint: restart the idle
      // recede timer so chrome auto-recedes again on phone/tablet.
      shell.chromeState.set('full');
      restartRecedeTimer(shell, state);
    }
  };
  state.resizeObserver = new ResizeObserver(update);
  state.resizeObserver.observe(document.documentElement);
  update();
  // On initial phone/tablet load the idle recede timer must start even if
  // the user never moves the pointer or resizes (the resize handler only
  // (re)starts it when crossing back from desktop). Desktop opts out.
  if (!shell.isDesktop()) {
    shell.chromeState.set('full');
    restartRecedeTimer(shell, state);
  }
}
