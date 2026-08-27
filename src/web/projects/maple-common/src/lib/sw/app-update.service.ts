// AppUpdateService — service-worker-driven "lazy install in the background"
// app-update flow, shared by the Hosted (maple-syrup) and Self-Hosted (maple)
// apps.
//
// Lifecycle:
//   1. The Angular service worker downloads a freshly-deployed app version on
//      its own (lazy, in the background). We only listen for the VERSION_READY
//      signal it emits once the download is complete.
//   2. On VERSION_READY we arm `updatePending` and pop the install toast
//      (`showToast`). The user can install immediately ("Install" → activate +
//      reload) or dismiss the toast and keep working.
//   3. Even if the toast is dismissed, the update stays armed: the next route
//      change triggers a hard document navigation to the target URL. That
//      boots a fresh client, the SW hands it the already-downloaded version,
//      and the user still lands on the page they were navigating to — so the
//      new code installs at a natural break instead of mid-interaction.
//
// No-ops entirely when the service worker is disabled (dev mode, unsupported
// browser), so it is safe to wire into every app's bootstrap initializer.

import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import type { MuiToastEntry } from '../ui/toast-container/mui-toast-container.component';

/** Stable synthetic id for the single-slot toast list `toasts` feeds to
 * `mui-toast-container` — there is only ever one update notice per session,
 * so a constant id is enough to key the `@for` track. */
const UPDATE_TOAST_ID = 'app-update';

/** How often to ask the SW to poll the origin for a new deployment. A working
 * photographer leaves Maple open all day; the `registerWhenStable` strategy
 * only checks ~30s after first stabilisation, so this covers the long tail of
 * a long-lived tab without hammering the server. */
const UPDATE_POLL_MS = 30 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  // Optional: `SwUpdate` is only in the injector when `provideServiceWorker`
  // ran. Optional injection lets the service (and the toast that reads it) load
  // harmlessly in dev, in unit tests, and in any build without the SW.
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Guard so repeated init() calls don't stack subscriptions/timers. */
  private initialized = false;

  /** Background-poll handle, cleared when the injector is destroyed. */
  private pollTimer?: ReturnType<typeof setInterval>;

  /** Armed once a new app version is downloaded and ready to activate. Drives
   * the route-change hard-navigation interception. */
  private readonly updatePending = signal(false);

  /** Set when the user dismisses the toast ("Later"). Hides the toast but
   * leaves `updatePending` armed, so navigation still upgrades the app. */
  private readonly toastDismissed = signal(false);

  /** Whether the install toast should be visible. */
  readonly showToast = computed(() => this.updatePending() && !this.toastDismissed());

  /** Presentation mapping for `<mui-toast-container>` (replaces the deleted
   * `UpdateToastComponent` wrapper, toast sweep ticket #3043) — both
   * `RootShellComponent` and maple-syrup's `HostedRootShellComponent` bind
   * this straight in, the same way they already share `SidecarSaveStateService
   * .statusText` (MW2, #3029). */
  readonly toasts = computed<readonly MuiToastEntry[]>(() =>
    this.showToast()
      ? [
          {
            id: UPDATE_TOAST_ID,
            variant: 'info',
            message: 'A new version of Maple is ready.',
            actionLabel: 'Install',
            // Persists until the user installs or dismisses it by hand —
            // matches the pre-migration toast, which never auto-timed-out.
            autoDismissMs: null,
          },
        ]
      : [],
  );

  /** Guard against a burst of NavigationStart events (redirects, guard
   * re-runs) firing multiple hard navigations. */
  private hardNavInFlight = false;

  /** Idempotent bootstrap hook. No-ops when the SW is disabled, and only wires
   * up its subscriptions + poll timer once even if called repeatedly. */
  init(): void {
    if (this.initialized) return;
    const swUpdate = this.swUpdate;
    if (!swUpdate?.isEnabled) return;
    this.initialized = true;

    // 1. Background install already happens inside the SW; just catch "ready".
    swUpdate.versionUpdates
      .pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.updatePending.set(true));

    // 2. Poll so a tab open across a deploy eventually notices the new build.
    //    A failed poll (offline / transient 5xx) is non-fatal — swallow it so
    //    it isn't an unhandled rejection; the next tick retries.
    this.pollTimer = setInterval(() => {
      void swUpdate.checkForUpdate().catch(() => {});
    }, UPDATE_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(this.pollTimer));

    // 3. Hard-navigate on the next route change once an update is armed.
    this.router.events
      .pipe(
        filter((e): e is NavigationStart => e instanceof NavigationStart),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((e) => this.maybeHardNavigate(e.url));
  }

  /** Activate the downloaded version now and reload the current page. Wired to
   * the toast's "Install" action for users who want the update without first
   * navigating away. */
  async installNow(): Promise<void> {
    const swUpdate = this.swUpdate;
    if (!swUpdate?.isEnabled || this.hardNavInFlight) return;
    this.hardNavInFlight = true;
    try {
      await swUpdate.activateUpdate();
    } finally {
      // Reload onto the current URL so the freshly-activated version takes over.
      window.location.reload();
    }
  }

  /** Hide the toast but keep the update armed for the next navigation. */
  dismiss(): void {
    this.toastDismissed.set(true);
  }

  private maybeHardNavigate(targetUrl: string): void {
    if (!this.updatePending() || this.hardNavInFlight) return;
    // A no-op re-nav to the same path gains nothing from a full reload; only
    // intercept a genuine route change to a different page.
    if (this.stripFragment(targetUrl) === this.stripFragment(this.router.url)) return;
    this.hardNavInFlight = true;
    // Full-page load → fresh client → the SW serves the new version, and the
    // browser still ends up on `targetUrl`.
    window.location.assign(targetUrl);
  }

  private stripFragment(url: string): string {
    const hash = url.indexOf('#');
    return hash === -1 ? url : url.slice(0, hash);
  }
}
