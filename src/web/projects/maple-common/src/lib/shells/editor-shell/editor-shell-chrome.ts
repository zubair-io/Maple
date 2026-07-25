// Chrome-recede + responsive-breakpoint observer for EditorShellComponent
// (#1535). Extracted from the component to keep editor-shell.component.ts
// under the per-file LOC budget. Operates on the live component via its
// public surface; `import type` keeps this a type-only (no runtime)
// dependency on the shell.
//
// Chrome recede: dims to 30% after 3s idle; restores on pointer move
// (180ms transition, driven by the `.chrome--receded` class in the SCSS).
// Desktop (>1024px) opts out of auto-recede — chrome stays full always.
import type { EditorShellComponent } from './editor-shell.component';
import type { MapleLayout } from '../../layout-service';

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

/** Responsive breakpoint observer: flips `isTabletPlus`/`isDesktop` from the
 *  shared `LayoutService.layout()` signal and manages the chrome-recede idle
 *  timer across breakpoint crossings. Desktop (`layout() === 'desktop'`,
 *  >1024px) opts out of auto-recede entirely. The caller (the shell's
 *  constructor `effect`) re-invokes this on every layout signal change —
 *  this module has no window/ResizeObserver dependency of its own. */
export function setupResponsive(
  shell: EditorShellComponent,
  state: ChromeRecedeState,
  layout: () => MapleLayout,
): void {
  const update = () => {
    const wasDesktop = shell.isDesktop();
    const l = layout();
    shell.isTabletPlus.set(l !== 'phone');
    shell.isDesktop.set(l === 'desktop');
    if (l === 'desktop') {
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
  update();
  // On initial phone/tablet load the idle recede timer must start even if
  // the user never moves the pointer or the layout never crosses back from
  // desktop (the branch above only (re)starts it on such a crossing).
  // Desktop opts out.
  if (!shell.isDesktop()) {
    shell.chromeState.set('full');
    restartRecedeTimer(shell, state);
  }
}
