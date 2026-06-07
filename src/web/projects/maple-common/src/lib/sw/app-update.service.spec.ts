// app-update.service.spec.ts — service-worker app-update flow.
//
// Covers the deterministic state machine: a freshly-downloaded version arms
// the install toast, non-ready version events are ignored, and dismissing
// hides the toast. The window-navigation side effects (hard-nav on route
// change, reload on install) are intentionally not exercised here — jsdom has
// no real navigation — so the spec stays focused on the observable state.

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdateService } from './app-update.service';

class FakeSwUpdate {
  isEnabled = true;
  readonly versionUpdates = new Subject<VersionEvent>();
  checkForUpdate = async () => true;
  activateUpdate = async () => true;

  emitReady(): void {
    this.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    } as VersionEvent);
  }
}

function setup(sw?: FakeSwUpdate): AppUpdateService {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), ...(sw ? [{ provide: SwUpdate, useValue: sw }] : [])],
  });
  return TestBed.inject(AppUpdateService);
}

describe('AppUpdateService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('with the service worker enabled', () => {
    let sw: FakeSwUpdate;
    let service: AppUpdateService;

    beforeEach(() => {
      sw = new FakeSwUpdate();
      service = setup(sw);
      service.init();
    });

    it('starts with the toast hidden', () => {
      expect(service.showToast()).toBe(false);
    });

    it('shows the toast once a new version is ready', () => {
      sw.emitReady();
      expect(service.showToast()).toBe(true);
    });

    it('ignores version events that are not VERSION_READY', () => {
      sw.versionUpdates.next({
        type: 'VERSION_DETECTED',
        version: { hash: 'new' },
      } as VersionEvent);
      expect(service.showToast()).toBe(false);
    });

    it('hides the toast when dismissed', () => {
      sw.emitReady();
      expect(service.showToast()).toBe(true);
      service.dismiss();
      expect(service.showToast()).toBe(false);
    });
  });

  describe('without a service worker (optional injection)', () => {
    let service: AppUpdateService;

    beforeEach(() => {
      service = setup();
    });

    it('init() is a no-op and the toast never shows', () => {
      expect(() => service.init()).not.toThrow();
      expect(service.showToast()).toBe(false);
    });

    it('installNow() resolves without throwing', async () => {
      await expect(service.installNow()).resolves.toBeUndefined();
    });
  });
});
