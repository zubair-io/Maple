import { describe, it, expect } from 'vitest';
import { gpsToXmp, gpsFromXmp } from './xmp-metadata';

describe('gpsToXmp', () => {
  it('encodes a northern latitude as deg,decimal-min with N', () => {
    expect(gpsToXmp(48.8566, 'lat')).toBe('48,51.3960N');
  });
  it('encodes a southern latitude with S and positive minutes', () => {
    expect(gpsToXmp(-33.8688, 'lat')).toBe('33,52.1280S');
  });
  it('encodes a western longitude with W', () => {
    expect(gpsToXmp(-73.9857, 'lon')).toBe('73,59.1420W');
  });
  it('encodes an eastern longitude with E', () => {
    expect(gpsToXmp(2.3522, 'lon')).toBe('2,21.1320E');
  });
});

describe('gpsFromXmp', () => {
  it('decodes N latitude back to signed decimal', () => {
    expect(gpsFromXmp('48,51.3960N')).toBeCloseTo(48.8566, 4);
  });
  it('decodes S latitude as negative', () => {
    expect(gpsFromXmp('33,52.1280S')).toBeCloseTo(-33.8688, 4);
  });
  it('decodes W longitude as negative', () => {
    expect(gpsFromXmp('73,59.1420W')).toBeCloseTo(-73.9857, 4);
  });
  it('returns null for malformed input', () => {
    expect(gpsFromXmp('not-a-coord')).toBeNull();
  });
});
