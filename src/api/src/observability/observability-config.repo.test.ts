import { describe, expect, it } from 'bun:test';
import { validateHttpUrl } from './observability-config.repo.ts';

describe('validateHttpUrl', () => {
  it('returns null for null input', () => {
    expect(validateHttpUrl(null)).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(validateHttpUrl('')).toBeNull();
    expect(validateHttpUrl('   ')).toBeNull();
    expect(validateHttpUrl('\n\t')).toBeNull();
  });

  it('returns the URL with trailing slashes stripped for valid HTTP/HTTPS URLs', () => {
    expect(validateHttpUrl('http://example.com')).toBe('http://example.com');
    expect(validateHttpUrl('https://example.com/')).toBe('https://example.com');
    expect(validateHttpUrl('https://example.com///')).toBe('https://example.com');
    expect(validateHttpUrl('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318');
    expect(validateHttpUrl('https://signoz.internal:4318/')).toBe('https://signoz.internal:4318');
  });

  it('trims leading and trailing whitespace', () => {
    expect(validateHttpUrl('  https://example.com/  ')).toBe('https://example.com');
    expect(validateHttpUrl('\t http://example.com \n')).toBe('http://example.com');
  });

  it('returns an error for invalid URLs', () => {
    expect(validateHttpUrl('not-a-url')).toEqual({ error: 'Not a valid URL' });
    expect(validateHttpUrl('http://')).toEqual({ error: 'Not a valid URL' });
  });

  it('returns an error for unsupported protocols', () => {
    expect(validateHttpUrl('ftp://example.com')).toEqual({
      error: 'Unsupported protocol: ftp:',
    });
    expect(validateHttpUrl('file:///path/to/file')).toEqual({
      error: 'Unsupported protocol: file:',
    });
    expect(validateHttpUrl('ws://example.com')).toEqual({
      error: 'Unsupported protocol: ws:',
    });
  });
});
