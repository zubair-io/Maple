import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { StackPairOpsService } from './stack-pair-ops.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { API_BASE_URL } from '../api/api-base-url.token';

const RAW = '507f1f77bcf86cd799439011';
const JPEG = '507f1f77bcf86cd799439012';

describe('StackPairOpsService', () => {
  let http: HttpTestingController;
  let service: StackPairOpsService;
  let config: Record<string, unknown>;

  beforeEach(() => {
    config = { show_hidden_images: false, stack_pair_ops_supported: true };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        StackPairOpsService,
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: BunApiBackendService,
          useValue: {
            getDisplayConfig: () => of(config),
            getAssetDetailsByAddress: (address: string) =>
              of({ id: address.endsWith('.JPG') ? JPEG : RAW }),
          },
        },
      ],
    });
    service = TestBed.inject(StackPairOpsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('caches the advertised flag per server', () => {
    const seen: boolean[] = [];
    service.supported().subscribe((v) => seen.push(v));
    service.supported().subscribe((v) => seen.push(v));
    expect(seen).toEqual([true, true]);
  });

  it('treats a missing flag as an older server', () => {
    config = { show_hidden_images: false };
    let seen: boolean | undefined;
    service.supported().subscribe((v) => (seen = v));
    expect(seen).toBe(false);
  });

  it('renames a pair in one request with companion_id', () => {
    let outcome: unknown;
    service
      .renamePair('lib:IMG_1.CR3', 'lib:IMG_1.JPG', 'Trip.CR3', 'skip')
      .subscribe((v) => (outcome = v));
    const req = http.expectOne(`/api/assets/${RAW}/rename`);
    expect(req.request.body).toEqual({
      new_filename: 'Trip.CR3',
      collision: 'skip',
      companion_collision: 'skip',
      companion_id: JPEG,
      source_address: 'lib:IMG_1.CR3',
    });
    req.flush({
      new_abs_path: '/x/Trip.CR3',
      new_path: '',
      new_filename: 'Trip.CR3',
      renamed_on_collision: false,
      extension_changed: false,
      companion: { new_abs_path: '/x/Trip.JPG', new_path: '', new_filename: 'Trip.JPG' },
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      newFilename: 'Trip.CR3',
      companion: { newFilename: 'Trip.JPG' },
    });
  });

  it('surfaces collision_filename so callers can tell RAW from JPEG collisions', () => {
    let outcome: unknown;
    service
      .relocatePair('lib:IMG_1.CR3', 'lib:IMG_1.JPG', 'move', 'skip', 'skip', 'France')
      .subscribe((v) => (outcome = v));
    const req = http.expectOne(`/api/assets/${RAW}/relocate`);
    expect(req.request.body).toMatchObject({ companion_id: JPEG, companion_collision: 'skip' });
    req.flush({ skipped: true, reason: 'collision', collision_filename: 'IMG_1.JPG' });
    expect(outcome).toEqual({
      kind: 'skipped',
      reason: 'collision',
      collisionFilename: 'IMG_1.JPG',
    });
  });

  it('does not call the API when the fake has no display config', () => {
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
  });
});
