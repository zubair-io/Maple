import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RawPipelineService } from './raw-pipeline.service';
import { LiveScopeClient } from './raw-pipeline.scope-client';
import { WorkerStub, installWorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodedImage, OpenSessionRequest, RenderSessionRequest } from './raw-pipeline.types';

describe('live scope messages after render replies', () => {
  it('accepts monotonic completed samples while a newer edit is pending', () => {
    const client = new LiveScopeClient();
    client.open(1);
    client.requested(2);
    client.requested(3);
    const publish = (renderId: number) =>
      client.accept({
        id: 0,
        type: 'session-scope',
        sessionId: 1,
        renderId,
        scope: { width: 1, height: 1, rgb: new Uint8Array([renderId, 2, 3]).buffer },
      });
    publish(2);
    expect(client.pixels.value?.rgb[0]).toBe(2);
    publish(1);
    expect(client.pixels.value?.rgb[0]).toBe(2);
    publish(4); // unknown/future request
    expect(client.pixels.value?.rgb[0]).toBe(2);
    publish(3);
    expect(client.pixels.value?.rgb[0]).toBe(3);
  });
  let worker: WorkerStub;
  let restore: () => void;
  beforeEach(() => {
    worker = new WorkerStub();
    restore = installWorkerStub(worker).restore;
    TestBed.configureTestingModule({});
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    restore();
  });

  it('publishes with no pending request and rejects stale edits, replaced sessions and closed workers', async () => {
    const service = TestBed.inject(RawPipelineService);
    let latest: DecodedImage | null = null;
    service.liveScope$.subscribe((value) => {
      latest = value;
    });
    const opened = service.openLiveSession({} as OffscreenCanvas, new Uint8Array([1]), 'dng');
    const request = worker.postMessage.mock.calls.at(-1)![0] as OpenSessionRequest;
    worker.reply({
      id: request.id,
      type: 'open-session-success',
      width: 1,
      height: 1,
      asShotTemperature: 5500,
      asShotTint: 0,
      colorSpace: 'srgb',
    });
    await opened;
    const scope = (sessionId: number, renderId: number, value: number) =>
      worker.reply({
        id: 0,
        type: 'session-scope',
        sessionId,
        renderId,
        scope: { width: 1, height: 1, rgb: new Uint8Array([value, 2, 3]).buffer },
      });
    scope(request.id, request.id, 10);
    expect((latest as DecodedImage | null)?.rgb[0]).toBe(10);
    const rendered = service.renderLiveSession('<x/>');
    const edit = worker.postMessage.mock.calls.at(-1)![0] as RenderSessionRequest;
    scope(request.id, request.id, 20);
    expect((latest as DecodedImage | null)?.rgb[0]).toBe(10);
    worker.reply({ id: edit.id, type: 'render-session-success', colorSpace: 'srgb' });
    await rendered;
    scope(request.id, edit.id, 30);
    expect((latest as DecodedImage | null)?.rgb[0]).toBe(30);
    scope(request.id, edit.id, 40);
    expect((latest as DecodedImage | null)?.rgb[0]).toBe(30);
    service.closeLiveSession();
    scope(request.id, edit.id, 50);
    expect(latest).toBeNull();
    const reopened = service.openLiveSession({} as OffscreenCanvas, new Uint8Array([1]), 'dng');
    const replacement = worker.postMessage.mock.calls.at(-1)![0] as OpenSessionRequest;
    worker.reply({
      id: replacement.id,
      type: 'open-session-success',
      width: 1,
      height: 1,
      asShotTemperature: 5500,
      asShotTint: 0,
      colorSpace: 'srgb',
    });
    await reopened;
    scope(request.id, replacement.id, 60);
    expect(latest).toBeNull();
    scope(replacement.id, replacement.id, 70);
    expect((latest as DecodedImage | null)?.rgb[0]).toBe(70);
    service.ngOnDestroy();
    scope(replacement.id, replacement.id + 1, 80);
    expect(latest).toBeNull();
  });
});
