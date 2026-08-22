import { describe, expect, it } from 'bun:test';
import { DEFAULT_BODY_LIMIT_BYTES, bodyLimitForPath, bodyRejection } from './body-limit.ts';
import { MAX_REQUEST_BODY_BYTES } from '../runtime/tls-config.ts';

const AUTH = 'Bearer token';

describe('bodyLimitForPath', () => {
  it('gives the schema-less streaming upload route the full ceiling', () => {
    expect(bodyLimitForPath('/api/folders/69f969e0fb95bf0ea8651ad1/upload')).toBe(
      MAX_REQUEST_BODY_BYTES,
    );
  });

  it('caps every other route at the pre-#2994 Bun default', () => {
    expect(bodyLimitForPath('/api/search')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    // The backup chunk endpoints declare `body: t.Any()` (Elysia buffers
    // BEFORE auth runs) and their client sends fixed 4MB chunks — they must
    // stay on the default limit, not the streaming ceiling.
    expect(bodyLimitForPath('/api/libraries/x/backup/ingest')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitForPath('/api/libraries/x/backup/rendered')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitForPath('/api/libraries/x/backup/sidecar')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    // Prefix/suffix look-alikes must not inherit the streaming ceiling.
    expect(bodyLimitForPath('/api/folders/x/upload/extra')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });
});

describe('bodyRejection', () => {
  it('413s a JSON route body over 128MB even with auth', () => {
    const r = bodyRejection('POST', '/api/search', String(DEFAULT_BODY_LIMIT_BYTES + 1), AUTH);
    expect(r?.status).toBe(413);
    expect(r?.body.error).toContain('exceeds');
  });

  it('lets an authorized multi-GB video through on the streaming upload route', () => {
    expect(
      bodyRejection('POST', '/api/folders/abc/upload', String(20 * 1024 ** 3), AUTH),
    ).toBeNull();
  });

  it('401s a large body with no Authorization header before the stream is read', () => {
    const r = bodyRejection('POST', '/api/folders/abc/upload', String(20 * 1024 ** 3), null);
    expect(r?.status).toBe(401);
  });

  it('leaves small unauthenticated bodies to the normal auth flow', () => {
    // Login POSTs etc. carry no Authorization header — only LARGE bodies
    // trigger the fail-fast 401.
    expect(bodyRejection('POST', '/api/auth/login', '256', null)).toBeNull();
  });

  it('ignores bodiless methods and missing/garbage Content-Length', () => {
    expect(bodyRejection('GET', '/api/search', String(10 * 1024 ** 3), null)).toBeNull();
    expect(bodyRejection('POST', '/api/search', null, null)).toBeNull();
    expect(bodyRejection('POST', '/api/search', 'not-a-number', null)).toBeNull();
  });

  it('allows bodies exactly at the limit', () => {
    expect(bodyRejection('POST', '/api/search', String(DEFAULT_BODY_LIMIT_BYTES), AUTH)).toBeNull();
  });
});
