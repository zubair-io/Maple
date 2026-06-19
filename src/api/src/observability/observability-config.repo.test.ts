import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SAMPLE_RATIO,
  DEFAULT_SERVICE_NAMESPACE,
  resolveObservabilityConfig,
  validateHttpUrl,
} from './observability-config.repo.ts';

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
    expect(validateHttpUrl('http://[::1]:4318')).toBe('http://[::1]:4318');
  });

  it('handles URLs with paths, query strings, and hashes', () => {
    expect(validateHttpUrl('https://example.com/otlp')).toBe('https://example.com/otlp');
    expect(validateHttpUrl('https://example.com/otlp/')).toBe('https://example.com/otlp');
    expect(validateHttpUrl('http://example.com?query=1')).toBe('http://example.com?query=1');
    expect(validateHttpUrl('http://example.com#hash')).toBe('http://example.com#hash');
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

describe('resolveObservabilityConfig', () => {
  it('falls back to defaults when DB is null', () => {
    const resolved = resolveObservabilityConfig(null);
    expect(resolved.enabled).toBe(true);
    expect(resolved.endpoint).toBeNull();
    expect(resolved.ingestion_key).toBeNull();
    expect(resolved.service_namespace).toBe(DEFAULT_SERVICE_NAMESPACE);
    expect(resolved.traces_enabled).toBe(true);
    expect(resolved.logs_enabled).toBe(true);
    expect(resolved.metrics_enabled).toBe(false);
    expect(resolved.sample_ratio).toBe(DEFAULT_SAMPLE_RATIO);

    expect(resolved.source.enabled).toBe('default');
    expect(resolved.source.endpoint).toBe('unset');
    expect(resolved.source.ingestion_key).toBe('unset');
    expect(resolved.source.service_namespace).toBe('default');
    expect(resolved.source.traces_enabled).toBe('default');
    expect(resolved.source.logs_enabled).toBe('default');
    expect(resolved.source.metrics_enabled).toBe('default');
    expect(resolved.source.sample_ratio).toBe('default');
  });

  it('prefers DB values when present', () => {
    const resolved = resolveObservabilityConfig({
      enabled: false,
      endpoint: 'https://signoz.internal',
      ingestion_key: 'secret-key',
      service_namespace: 'custom-ns',
      traces_enabled: false,
      logs_enabled: false,
      metrics_enabled: true,
      sample_ratio: 0.5,
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.endpoint).toBe('https://signoz.internal');
    expect(resolved.ingestion_key).toBe('secret-key');
    expect(resolved.service_namespace).toBe('custom-ns');
    expect(resolved.traces_enabled).toBe(false);
    expect(resolved.logs_enabled).toBe(false);
    expect(resolved.metrics_enabled).toBe(true);
    expect(resolved.sample_ratio).toBe(0.5);

    expect(resolved.source.enabled).toBe('db');
    expect(resolved.source.endpoint).toBe('db');
    expect(resolved.source.ingestion_key).toBe('db');
    expect(resolved.source.service_namespace).toBe('db');
    expect(resolved.source.traces_enabled).toBe('db');
    expect(resolved.source.logs_enabled).toBe('db');
    expect(resolved.source.metrics_enabled).toBe('db');
    expect(resolved.source.sample_ratio).toBe('db');
  });

  it('normalises the endpoint and handles invalid values', () => {
    const r1 = resolveObservabilityConfig({ endpoint: ' https://signoz.internal/ ' });
    expect(r1.endpoint).toBe('https://signoz.internal');
    expect(r1.source.endpoint).toBe('db');

    const r2 = resolveObservabilityConfig({ endpoint: 'not-a-url' });
    expect(r2.endpoint).toBeNull();
    expect(r2.source.endpoint).toBe('unset');
  });

  it('rejects out-of-bounds sample ratios', () => {
    const r1 = resolveObservabilityConfig({ sample_ratio: 1.5 });
    expect(r1.sample_ratio).toBe(DEFAULT_SAMPLE_RATIO);
    expect(r1.source.sample_ratio).toBe('default');

    const r2 = resolveObservabilityConfig({ sample_ratio: -0.1 });
    expect(r2.sample_ratio).toBe(DEFAULT_SAMPLE_RATIO);
    expect(r2.source.sample_ratio).toBe('default');
  });

  it('trims and handles empty strings for string fields', () => {
    const resolved = resolveObservabilityConfig({
      ingestion_key: '  key  ',
      service_namespace: '  ns  ',
    });
    expect(resolved.ingestion_key).toBe('key');
    expect(resolved.service_namespace).toBe('ns');

    const empty = resolveObservabilityConfig({
      ingestion_key: '   ',
      service_namespace: '   ',
    });
    expect(empty.ingestion_key).toBeNull();
    expect(empty.source.ingestion_key).toBe('unset');
    expect(empty.service_namespace).toBe(DEFAULT_SERVICE_NAMESPACE);
    expect(empty.source.service_namespace).toBe('default');
  });
});
