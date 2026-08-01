import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  API_BASE_URL,
  LibraryStateService,
  provideSelfHostedWorkspace,
  type Asset,
} from '@maple-common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfHostedBrowseController } from './self-hosted-browse.controller';

describe('SelfHostedBrowseController', () => {
  let controller: SelfHostedBrowseController;
  let http: HttpTestingController;
  let state: LibraryStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSelfHostedWorkspace(),
        SelfHostedBrowseController,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    controller = TestBed.inject(SelfHostedBrowseController);
    http = TestBed.inject(HttpTestingController);
    state = TestBed.inject(LibraryStateService);
  });

  afterEach(() => http.verify());

  it('keeps pano state entirely inside the Self Hosted extension', () => {
    Object.defineProperty(state, 'selectedAssetIds', {
      value: signal(new Set(['photos:a.dng', 'photos:b.dng'])),
      configurable: true,
    });

    controller.openPano();
    expect(controller.panoAssetIds()).toEqual(['photos:a.dng', 'photos:b.dng']);
    expect(controller.panoVisible()).toBe(true);

    controller.dismissPano();
    expect(controller.panoVisible()).toBe(false);
    expect(controller.panoAssetIds()).toEqual([]);
  });

  it('fetches batch metadata by Maple address and opens the server panel', () => {
    const asset = { id: 'photos:2026/a.dng' } as Asset;
    Object.defineProperty(state, 'selectedAssetIds', {
      value: signal(new Set([asset.id])),
      configurable: true,
    });
    Object.defineProperty(state, 'assetsInSelectedFolder', {
      value: signal([asset]),
      configurable: true,
    });

    controller.openMetadata();
    const request = http.expectOne('/api/metadata/snapshots');
    expect(request.request.body).toEqual({ addresses: [asset.id] });
    request.flush({ snapshots: [{ address: asset.id, metadata: {} }] });

    expect(controller.metadataVisible()).toBe(true);
    expect(controller.metadataSnapshots()[0]?.address).toBe(asset.id);
  });

  it('falls back to the selected asset metadata when the snapshot API fails', () => {
    const asset = {
      id: 'photos:2026/fallback.dng',
      city: 'Toronto',
      country: 'Canada',
      keywords: ['reviewed'],
    } as Asset;
    Object.defineProperty(state, 'selectedAssetIds', {
      value: signal(new Set([asset.id])),
      configurable: true,
    });
    Object.defineProperty(state, 'assetsInSelectedFolder', {
      value: signal([asset]),
      configurable: true,
    });

    controller.openMetadata();
    http.expectOne('/api/metadata/snapshots').flush({}, { status: 503, statusText: 'Unavailable' });

    expect(controller.metadataVisible()).toBe(true);
    expect(controller.metadataSnapshots()).toEqual([
      {
        address: asset.id,
        metadata: {
          gpsLatitude: undefined,
          gpsLongitude: undefined,
          city: 'Toronto',
          country: 'Canada',
          title: undefined,
          keywords: ['reviewed'],
        },
      },
    ]);
  });
});
