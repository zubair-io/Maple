// subject-mask-server.service.spec.ts — wire contract + envelope parsing (#3300).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../api/api-base-url.token';
import { SubjectMaskServer, parseSubjectMaskDetection } from './subject-mask-server.service';

describe('parseSubjectMaskDetection', () => {
  it('parses a two-person response', () => {
    const detection = parseSubjectMaskDetection({
      model: 'maple-server-person-instance/1',
      persons: [
        { person: 0, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        { person: 1, bbox: { x: 0.5, y: 0.1, width: 0.2, height: 0.5 } },
      ],
    });
    expect(detection.model).toBe('maple-server-person-instance/1');
    expect(detection.persons).toHaveLength(2);
    expect(detection.persons[0]).toEqual({
      person: 0,
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    });
  });

  it('accepts an empty persons array (nobody detected)', () => {
    const detection = parseSubjectMaskDetection({ model: 'm/1', persons: [] });
    expect(detection.persons).toEqual([]);
  });

  it('drops entries with a bad person index, never defaulting to 0', () => {
    const detection = parseSubjectMaskDetection({
      model: 'm/1',
      persons: [
        { person: -1, bbox: { x: 0, y: 0, width: 1, height: 1 } },
        { person: 1.5, bbox: { x: 0, y: 0, width: 1, height: 1 } },
        { bbox: { x: 0, y: 0, width: 1, height: 1 } },
        'person-2',
        { person: 2, bbox: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    expect(detection.persons.map((p) => p.person)).toEqual([2]);
  });

  it('falls back to the full frame for a malformed bbox', () => {
    const detection = parseSubjectMaskDetection({
      model: 'm/1',
      persons: [{ person: 0, bbox: { x: 0, y: 'no', width: 1, height: 1 } }, { person: 1 }],
    });
    expect(detection.persons).toEqual([
      { person: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } },
      { person: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } },
    ]);
  });

  it('rejects a missing model, a missing array, and a non-object', () => {
    expect(() => parseSubjectMaskDetection({ persons: [] })).toThrow(/no model/);
    expect(() => parseSubjectMaskDetection({ model: 'm/1' })).toThrow(/no persons array/);
    expect(() => parseSubjectMaskDetection(null)).toThrow(/no JSON object/);
  });
});

describe('SubjectMaskServer', () => {
  let svc: SubjectMaskServer;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        SubjectMaskServer,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(SubjectMaskServer);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('detectPersons GETs the persons endpoint with the encoded asset key', () => {
    let model = '';
    svc.detectPersons('lib/asset 1').subscribe((d) => (model = d.model));
    const call = http.expectOne('/api/subject-masks/persons?asset=lib%2Fasset%201');
    expect(call.request.method).toBe('GET');
    call.flush({ model: 'm/1', persons: [] });
    expect(model).toBe('m/1');
  });

  it('fetchRasterBytes GETs the raster endpoint as an arraybuffer', () => {
    const png = new ArrayBuffer(16);
    let received: ArrayBuffer | null = null;
    svc.fetchRasterBytes('1ebe481c3e3e8053').subscribe((bytes) => (received = bytes));
    const call = http.expectOne('/api/subject-masks/raster/1ebe481c3e3e8053');
    expect(call.request.method).toBe('GET');
    call.flush(png);
    expect(received).toBe(png);
  });
});
