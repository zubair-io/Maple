import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api-base-url.token';
import { CloudBackupService } from './cloud-backup.service';

describe('CloudBackupService', () => {
  let api: CloudBackupService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    api = TestBed.inject(CloudBackupService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it('sends a write-only secret only in the explicit Google config request', () => {
    api
      .saveGoogleConfig('id/encoded', {
        clientId: 'client',
        clientSecret: 'secret',
        callbackMode: 'relay',
      })
      .subscribe();
    const req = http.expectOne('/api/cloud-backup/google/id%2Fencoded/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      clientId: 'client',
      clientSecret: 'secret',
      callbackMode: 'relay',
    });
    req.flush({ clientId: 'client', clientSecretSet: true });
    api.connectGoogle('id/encoded').subscribe();
    const start = http.expectOne('/api/cloud-backup/google/id%2Fencoded/start');
    expect(start.request.body).toEqual({});
    start.flush({ authorizationUrl: 'https://accounts.google.com/' });
  });
  it('preserves an explicitly selected generation and Trash policy through preview and recovery', () => {
    const request = {
      targetPath: '/Photos/Recovered',
      includeTrash: true,
      entryId: 'entry',
      sequence: 3,
    };
    api.previewRestore('destination', request).subscribe();
    const preview = http.expectOne('/api/cloud-backup/destinations/destination/restore/preview');
    expect(preview.request.body).toEqual(request);
    preview.flush({ files: 2, bytes: 5, entries: 1, gaps: [] });
    api.restore('destination', request).subscribe();
    const restore = http.expectOne('/api/cloud-backup/destinations/destination/restore');
    expect(restore.request.body).toEqual(request);
    restore.flush({ jobId: 'job' });
  });
  it('resumes destination-specific jobs without listing unrelated recovery payloads', () => {
    let result: unknown;
    api.restoreJobs('destination').subscribe((jobs) => {
      result = jobs;
    });
    http
      .expectOne('/api/cloud-backup/destinations/destination/restore/jobs')
      .flush({ jobs: [{ id: 'job' }] });
    expect(result).toEqual([{ id: 'job' }]);
  });
  it('resumes the existing destination job with no replacement payload or checkpoint', () => {
    api.resumeRestore('destination/encoded', 'job/encoded').subscribe();
    const request = http.expectOne(
      '/api/cloud-backup/destinations/destination%2Fencoded/restore/jobs/job%2Fencoded/resume',
    );
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush({ ok: true });
  });
});
