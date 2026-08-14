import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAP_TILE_URL, resolveMapConfig, validateTileUrl } from './map-config.repo.ts';

describe('validateTileUrl', () => {
  it('returns null for null input (clears an override, falls back to default)', () => {
    expect(validateTileUrl(null)).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(validateTileUrl('')).toBeNull();
    expect(validateTileUrl('   ')).toBeNull();
  });

  it('trims and accepts a well-formed https XYZ tile template', () => {
    expect(validateTileUrl('  https://tiles.example.com/{z}/{x}/{y}.png  ')).toBe(
      'https://tiles.example.com/{z}/{x}/{y}.png',
    );
  });

  it('accepts a MapLibre style JSON URL (also just a URL)', () => {
    const styleUrl = 'https://api.maptiler.com/maps/streets/style.json?key=abc123';
    expect(validateTileUrl(styleUrl)).toBe(styleUrl);
  });

  it('preserves literal {z}/{x}/{y} placeholders rather than percent-encoding them', () => {
    // new URL() percent-encodes `{`/`}` in .href — the raw string must be
    // returned instead, or MapLibre's XYZ substitution breaks.
    const raw = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const result = validateTileUrl(raw);
    expect(result).toBe(raw);
    expect(result).not.toContain('%7B');
  });

  it('rejects a value that is not a valid URL', () => {
    expect(validateTileUrl('not a url')).toEqual({ error: 'Not a valid URL' });
    expect(validateTileUrl('tiles.example.com/{z}/{x}/{y}.png')).toEqual({
      error: 'Not a valid URL',
    });
  });

  it('rejects a non-http(s) protocol', () => {
    expect(validateTileUrl('ftp://tiles.example.com/{z}/{x}/{y}.png')).toEqual({
      error: 'Unsupported protocol: ftp:',
    });
    expect(validateTileUrl('file:///etc/passwd')).toEqual({
      error: 'Unsupported protocol: file:',
    });
  });
});

describe('resolveMapConfig', () => {
  it('returns the default OSM tile URL with source "default" when unset', () => {
    const resolved = resolveMapConfig(null);
    expect(resolved.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(resolved.source.tile_url).toBe('default');
  });

  it('returns the default when the config row exists but tile_url is unset', () => {
    const resolved = resolveMapConfig({ tile_url: null });
    expect(resolved.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(resolved.source.tile_url).toBe('default');
  });

  it('returns the saved override with source "db"', () => {
    const override = 'https://tiles.example.com/{z}/{x}/{y}.png';
    const resolved = resolveMapConfig({ tile_url: override });
    expect(resolved.tile_url).toBe(override);
    expect(resolved.source.tile_url).toBe('db');
  });

  it('falls back to the default when a hand-edited DB row holds an invalid URL', () => {
    const resolved = resolveMapConfig({ tile_url: 'not a url' });
    expect(resolved.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(resolved.source.tile_url).toBe('default');
  });
});
