import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from './api-base-url.token';
import { MapClustersService, type MapCluster } from './map-clusters.service';

const CELLS: MapCluster[] = [
  {
    lat: 48.85,
    lng: 2.35,
    count: 3,
    representativeAssetId: 'a1',
    placeLabel: 'Paris',
  },
  {
    lat: 51.5,
    lng: -0.12,
    count: 1,
    representativeAssetId: 'a2',
    placeLabel: null,
    thumbKey: '/abs/london.dng',
  },
];

describe('MapClustersService', () => {
  let svc: MapClustersService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MapClustersService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(MapClustersService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs /map/clusters with a comma-joined bbox and the given zoom', () => {
    let received: MapCluster[] | null = null;
    svc
      .getClusters({ west: -1, south: -2, east: 3, north: 4 }, 8)
      .subscribe((cells) => (received = cells));

    const call = http.expectOne((req) => req.url === '/api/map/clusters' && req.method === 'GET');
    expect(call.request.params.get('bbox')).toBe('-1,-2,3,4');
    expect(call.request.params.get('zoom')).toBe('8');

    call.flush({ cells: CELLS });
    expect(received).toEqual(CELLS);
  });

  it('unwraps the { cells } envelope', () => {
    let received: MapCluster[] | null = null;
    svc.getClusters({ west: 0, south: 0, east: 1, north: 1 }, 10).subscribe((cells) => {
      received = cells;
    });

    http.expectOne('/api/map/clusters?bbox=0,0,1,1&zoom=10').flush({ cells: [] });

    expect(received).toEqual([]);
  });
});
