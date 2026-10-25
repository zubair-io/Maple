import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated';
import { ExportRecipeRenderService } from './export-recipe-render.service';
import { RecipeDirectoryAccessService } from './recipe-directory-access.service';
import { EXPORT_RECIPE_SERVER, type ExportJobView } from './export-recipe-server';
import { ExportRecipeQueueService } from './export-recipe-queue.service';
import { readExportQueue, type RecipeQueueRecord } from './export-recipe-store';

function savedQueue(): RecipeQueueRecord {
  return {
    id: 'job-id',
    serverJobId: 'job-id',
    recipe: { ...DEFAULT_EXPORT_RECIPE, destination: 'directory', directory: '/qa-exports' },
    cancelled: false,
    targets: [1, 2].map((index) => ({
      id: `photo-${index}`,
      filename: `photo-${index}.jpg`,
      path: `/qa/photo-${index}.jpg`,
      xmp: '',
      filmLook: '',
      capturedAt: null,
      index,
    })),
    entries: [1, 2].map((index) => ({ id: `photo-${index}`, status: 'pending' })),
  };
}

describe('Self Hosted export queue reopening', () => {
  let persisted: RecipeQueueRecord;
  let originalLocks: PropertyDescriptor | undefined;
  let originalIndexedDb: PropertyDescriptor | undefined;
  const get = vi.fn();
  const resume = vi.fn();
  const create = vi.fn();

  beforeEach(() => {
    persisted = savedQueue();
    originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          const database = {
            createObjectStore: () => undefined,
            close: () => undefined,
            transaction: () => {
              const tx = {
                oncomplete: null as (() => void) | null,
                objectStore: () => ({
                  get: () => {
                    const request = { result: structuredClone(persisted) };
                    queueMicrotask(() => tx.oncomplete?.());
                    return request;
                  },
                  put: (value: RecipeQueueRecord) => {
                    persisted = structuredClone(value);
                    const request = { result: undefined };
                    queueMicrotask(() => tx.oncomplete?.());
                    return request;
                  },
                }),
              };
              return tx;
            },
          };
          const request = {
            result: database,
            onupgradeneeded: null as (() => void) | null,
            onsuccess: null as (() => void) | null,
          };
          queueMicrotask(() => {
            request.onupgradeneeded?.();
            request.onsuccess?.();
          });
          return request;
        },
      } as unknown as IDBFactory,
    });
    get.mockReset();
    resume.mockReset();
    create.mockReset();
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, callback: (lock: Lock) => Promise<void>) =>
          callback({ name: 'maple-export-queue' } as Lock),
      },
    });
    TestBed.configureTestingModule({
      providers: [
        ExportRecipeQueueService,
        { provide: ExportRecipeRenderService, useValue: {} },
        { provide: RecipeDirectoryAccessService, useValue: {} },
        { provide: EXPORT_RECIPE_SERVER, useValue: { get, resume, create } },
      ],
    });
  });

  afterEach(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
    if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });

  it('reconciles a completed server job without replaying it', async () => {
    const job: ExportJobView = {
      id: 'job-id',
      status: 'done',
      progress: { current: 2, total: 2 },
      error: null,
      result: {
        applied: ['photo-1', 'photo-2'],
        skipped: [],
        failed: [],
        remaining: [],
        outputs: [],
      },
    };
    get.mockReturnValue(of(job));

    const queue = TestBed.inject(ExportRecipeQueueService);
    await vi.waitFor(() => expect(queue.summary()?.applied).toEqual(['photo-1', 'photo-2']));

    expect(queue.summary()?.applied).toEqual(['photo-1', 'photo-2']);
    expect((await readExportQueue())?.entries.every((entry) => entry.status === 'applied')).toBe(
      true,
    );
    expect(get).toHaveBeenCalledWith('job-id');
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('shows a cancelled server job without resuming it', async () => {
    const job: ExportJobView = {
      id: 'job-id',
      status: 'cancelled',
      progress: { current: 1, total: 2 },
      error: null,
      result: {
        applied: ['photo-1'],
        skipped: [],
        failed: [],
        remaining: ['photo-2'],
        outputs: [],
      },
    };
    get.mockReturnValue(of(job));

    const queue = TestBed.inject(ExportRecipeQueueService);
    await vi.waitFor(() => expect(queue.summary()?.cancelled).toBe(true));

    expect(queue.remaining()).toBe(1);
    expect(queue.summary()?.applied).toEqual(['photo-1']);
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not start two exports while waiting for reconnect to release its lock', async () => {
    const job: ExportJobView = {
      id: 'job-id',
      status: 'done',
      progress: { current: 2, total: 2 },
      error: null,
      result: {
        applied: ['photo-1', 'photo-2'],
        skipped: [],
        failed: [],
        remaining: [],
        outputs: [],
      },
    };
    get.mockReturnValue(of(job));
    create.mockReturnValue(of(job));
    let releaseReconnect: (() => void) | undefined;
    let firstLock = true;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (
          _name: string,
          optionsOrCallback: unknown,
          work?: (lock: Lock) => Promise<unknown>,
        ) => {
          const callback =
            typeof optionsOrCallback === 'function'
              ? (optionsOrCallback as (lock: Lock) => Promise<unknown>)
              : work!;
          if (!firstLock) return callback({ name: 'maple-export-queue' } as Lock);
          firstLock = false;
          return new Promise((resolve, reject) => {
            releaseReconnect = () => {
              Promise.resolve(callback({ name: 'maple-export-queue' } as Lock)).then(
                resolve,
                reject,
              );
            };
          });
        },
      },
    });

    const queue = TestBed.inject(ExportRecipeQueueService);
    await vi.waitFor(() => expect(releaseReconnect).toBeTypeOf('function'));
    const first = queue.resume();
    const second = queue.resume();
    await vi.waitFor(() => expect(queue.running()).toBe(true));
    releaseReconnect!();
    await Promise.all([first, second]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(queue.summary()?.applied).toEqual(['photo-1', 'photo-2']);
  });

  it('retries a transient poll failure and clears the error after reconciliation', async () => {
    const job: ExportJobView = {
      id: 'job-id',
      status: 'done',
      progress: { current: 2, total: 2 },
      error: null,
      result: {
        applied: ['photo-1', 'photo-2'],
        skipped: [],
        failed: [],
        remaining: [],
        outputs: [],
      },
    };
    get.mockReturnValueOnce(throwError(() => new Error('temporary network failure')));
    get.mockReturnValue(of(job));

    const queue = TestBed.inject(ExportRecipeQueueService);
    await vi.waitFor(() => expect(queue.summary()?.applied).toEqual(['photo-1', 'photo-2']), {
      timeout: 5_000,
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(queue.error()).toBeNull();
  });
});
