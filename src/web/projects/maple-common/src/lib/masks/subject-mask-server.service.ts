// Self Hosted subject-mask cache client (#3300 slice 3):
// `GET /api/subject-masks/persons?asset=<key>` (who is in the frame) and
// `GET /api/subject-masks/raster/<digest>` (the R8 raster as a grayscale
// PNG) — the server half is a follow-up issue; this client defines the wire
// contract it implements. Loaded lazily through
// `subject-mask-server-bridge.ts`; `HttpClient` keeps the app's normal auth
// interceptor. Never referenced from Hosted-reachable eager code.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';

/** One detected person: the recipe's `person` index plus its normalized,
 *  top-left-origin bounding box (for a future people picker; unused in v1). */
export interface DetectedPerson {
  person: number;
  bbox: { x: number; y: number; width: number; height: number };
}

/** The detect response: the server's model id (folded into every digest it
 *  names) plus the people it covers. Empty `persons` = nobody detected. */
export interface SubjectMaskDetection {
  model: string;
  persons: DetectedPerson[];
}

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 };

function isFiniteRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toDetectedPerson(entry: unknown): DetectedPerson | null {
  if (!isFiniteRecord(entry)) return null;
  const person = entry['person'];
  if (typeof person !== 'number' || !Number.isInteger(person) || person < 0) return null;
  const bbox = isFiniteRecord(entry['bbox']) ? entry['bbox'] : null;
  const coords = bbox ? (['x', 'y', 'width', 'height'] as const).map((k) => bbox[k]) : [];
  const valid =
    coords.length === 4 && coords.every((c) => typeof c === 'number' && Number.isFinite(c));
  return {
    person,
    bbox: valid
      ? {
          x: coords[0] as number,
          y: coords[1] as number,
          width: coords[2] as number,
          height: coords[3] as number,
        }
      : { ...FULL_FRAME },
  };
}

/** Parse + validate the detect envelope. `model` is required (digests
 *  cannot be computed without it); malformed person entries are dropped,
 *  never defaulted to person 0. */
export function parseSubjectMaskDetection(body: unknown): SubjectMaskDetection {
  if (!isFiniteRecord(body)) throw new Error('Subject-mask detect returned no JSON object.');
  const model = body['model'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Subject-mask detect returned no model id.');
  }
  const persons = body['persons'];
  if (!Array.isArray(persons)) throw new Error('Subject-mask detect returned no persons array.');
  return { model, persons: persons.flatMap((entry) => toDetectedPerson(entry) ?? []) };
}

@Injectable({ providedIn: 'root' })
export class SubjectMaskServer {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  // Called through the lazy module injector in subject-mask-server-bridge.ts.
  // fallow-ignore-next-line unused-class-member
  detectPersons(assetKey: string): Observable<SubjectMaskDetection> {
    const url = `${this.base}/subject-masks/persons?asset=${encodeURIComponent(assetKey)}`;
    return this.http.get<unknown>(url).pipe(map(parseSubjectMaskDetection));
  }

  /** Download the digest's PNG bytes verbatim — the caller decodes (one
   *  decode site, shared with the cache path) and persists them. */
  // fallow-ignore-next-line unused-class-member
  fetchRasterBytes(digest: string): Observable<ArrayBuffer> {
    return this.http.get(`${this.base}/subject-masks/raster/${digest}`, {
      responseType: 'arraybuffer',
    });
  }
}
