import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY, Observable, Subject } from 'rxjs';
import type { Observer } from 'rxjs';
import {
  BunApiBackendService,
  WorkerEventsService,
  WorkersApiService,
  type WorkersStatusResponse,
  type WorkersStatusUpdate,
} from '@maple-common';
import { WorkersComponent } from './workers.component';
import { DamagedPanelService } from './damaged-panel.service';
import { MigrationPanelService } from './migration-panel.service';
import { ImportsPanelService } from './imports-panel.service';
import { ReaperPrunePanelService } from './reaper-prune-panel.service';
import { DecodeWorkersPanelService } from './decode-workers-panel.service';
import { MOCK_STATUS } from './workers.spec-fixtures';

describe('WorkersComponent status lifecycle', () => {
  const liveFrames = new Subject<WorkersStatusUpdate>();
  const fallback = new Subject<WorkersStatusResponse>();
  const liveTeardown = vi.fn();
  const fallbackTeardown = vi.fn();
  const liveStatus = new Observable<WorkersStatusUpdate>((subscriber) => {
    const subscription = liveFrames.subscribe(subscriber);
    return () => {
      subscription.unsubscribe();
      liveTeardown();
    };
  });
  const fallbackStatus = new Observable<WorkersStatusResponse>((subscriber) => {
    const subscription = fallback.subscribe(subscriber);
    return () => {
      subscription.unsubscribe();
      fallbackTeardown();
    };
  });
  let component: WorkersComponent;

  beforeEach(() => {
    liveTeardown.mockClear();
    fallbackTeardown.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerEventsService, useValue: { workersStatus$: liveStatus } },
        { provide: WorkersApiService, useValue: { getStatus: () => fallbackStatus } },
        { provide: BunApiBackendService, useValue: { getEnrichmentConfig: () => EMPTY } },
        { provide: DamagedPanelService, useValue: {} },
        {
          provide: MigrationPanelService,
          useValue: { startPolling: vi.fn(), stopPolling: vi.fn() },
        },
        {
          provide: ImportsPanelService,
          useValue: { startPolling: vi.fn(), stopPolling: vi.fn() },
        },
        { provide: ReaperPrunePanelService, useValue: { fetch: vi.fn() } },
        { provide: DecodeWorkersPanelService, useValue: { fetch: vi.fn() } },
      ],
    });
    component = TestBed.runInInjectionContext(() => new WorkersComponent());
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.restoreAllMocks();
  });

  it('keeps live updates after the fallback and tears down the stream on destroy', () => {
    component.ngOnInit();
    fallback.next(MOCK_STATUS);
    expect(component['status']()).toBe(MOCK_STATUS);

    const live = { ...MOCK_STATUS, stages: [] };
    liveFrames.next({ status: live, counted: true });
    expect(component['status']()).toBe(live);
    expect(liveTeardown).not.toHaveBeenCalled();

    component.ngOnDestroy();
    expect(liveTeardown).toHaveBeenCalledOnce();
    expect(fallbackTeardown).toHaveBeenCalledOnce();
    liveFrames.next({ status: MOCK_STATUS, counted: true });
    fallback.next(MOCK_STATUS);
    expect(component['status']()).toBe(live);
  });

  it('unsubscribes the live stream even when the HTTP fallback completes synchronously', () => {
    TestBed.inject(WorkersApiService).getStatus = () => EMPTY;
    component.ngOnInit();
    component.ngOnDestroy();
    expect(liveTeardown).toHaveBeenCalledOnce();
  });

  it('ignores late status and error callbacks after destruction', () => {
    const subscribe = vi.spyOn(liveStatus, 'subscribe');
    component.ngOnInit();
    const observer = subscribe.mock.calls[0][0] as Partial<Observer<WorkersStatusUpdate>>;
    component.ngOnDestroy();

    // Invoke registered callbacks to model work already queued by the bridge;
    // normal RxJS emissions are covered by the teardown test.
    observer.next?.({ status: MOCK_STATUS, counted: true });
    observer.error?.(new Error('late socket error'));
    expect(component['status']()).toBeNull();
    expect(component['error']()).toBeNull();
  });
});
