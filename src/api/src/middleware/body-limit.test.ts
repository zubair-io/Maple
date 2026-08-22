import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  bodyLimitForPath,
  oversizedBodyRejection,
} from './body-limit.ts';
import { MAX_REQUEST_BODY_BYTES } from '../runtime/tls-config.ts';

describe('bodyLimitForPath', () => {
  it('gives streaming upload routes the full ceiling', () => {
    expect(bodyLimitForPath('/api/folders/69f969e0fb95bf0ea8651ad1/upload')).toBe(
      MAX_REQUEST_BODY_BYTES,
    );
    expect(bodyLimitForPath('/api/libraries/69f969e0fb95bf0ea8651ad1/backup/ingest')).toBe(
      MAX_REQUEST_BODY_BYTES,
    );
    expect(bodyLimitForPath('/api/libraries/69f969e0fb95bf0ea8651ad1/backup/rendered')).toBe(
      MAX_REQUEST_BODY_BYTES,
    );
  });

  it('caps every other route at the pre-#2994 Bun default', () => {
    expect(bodyLimitForPath('/api/search')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitForPath('/api/libraries/x/backup/sidecar')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitForPath('/api/folders')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    // Prefix/suffix look-alikes must not inherit the streaming ceiling.
    expect(bodyLimitForPath('/api/folders/x/upload/extra')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });
});

describe('oversizedBodyRejection', () => {
  it('rejects a JSON route body over 128MB', () => {
    const r = oversizedBodyRejection('POST', '/api/search', String(DEFAULT_BODY_LIMIT_BYTES + 1));
    expect(r?.error).toContain('exceeds');
  });

  it('lets a multi-GB video through on the streaming upload route', () => {
    expect(
      oversizedBodyRejection('POST', '/api/folders/abc/upload', String(20 * 1024 ** 3)),
    ).toBeNull();
  });

  it('ignores bodiless methods and missing/garbage Content-Length', () => {
    expect(oversizedBodyRejection('GET', '/api/search', String(10 * 1024 ** 3))).toBeNull();
    expect(oversizedBodyRejection('POST', '/api/search', null)).toBeNull();
    expect(oversizedBodyRejection('POST', '/api/search', 'not-a-number')).toBeNull();
  });

  it('allows bodies exactly at the limit', () => {
    expect(
      oversizedBodyRejection('POST', '/api/search', String(DEFAULT_BODY_LIMIT_BYTES)),
    ).toBeNull();
  });
});
