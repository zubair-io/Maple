import { describe, expect, it } from 'bun:test';
import { parseDurationSeconds, parseShowinfoPtsTimes } from './probe.ts';

describe('parseDurationSeconds', () => {
  it('parses HH:MM:SS.ff into seconds', () => {
    expect(parseDurationSeconds('  Duration: 00:01:23.45, start: 0.000000')).toBeCloseTo(83.45, 2);
  });

  it('parses a duration with hours', () => {
    expect(parseDurationSeconds('Duration: 01:00:00.00, bitrate: 128 kb/s')).toBeCloseTo(3600, 2);
  });

  it('tolerates a duration with no fractional part', () => {
    expect(parseDurationSeconds('Duration: 00:00:05')).toBeCloseTo(5, 2);
  });

  it('returns null when no Duration line is present (unreadable container)', () => {
    expect(parseDurationSeconds('some unrelated ffmpeg banner text')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseDurationSeconds('')).toBeNull();
  });
});

describe('parseShowinfoPtsTimes', () => {
  it('extracts pts_time values in emitted order', () => {
    const stderr = [
      '[Parsed_showinfo_0 @ 0x1] n:0 pts:0 pts_time:0 pos:100',
      '[Parsed_showinfo_0 @ 0x1] n:1 pts:48 pts_time:2.5 pos:200',
      '[Parsed_showinfo_0 @ 0x1] n:2 pts:96 pts_time:5.0 pos:300',
    ].join('\n');
    expect(parseShowinfoPtsTimes(stderr)).toEqual([0, 2.5, 5.0]);
  });

  it('returns an empty array when no showinfo lines are present', () => {
    expect(parseShowinfoPtsTimes('Duration: 00:00:05.00\nStream #0:0: Video: h264')).toEqual([]);
  });

  it('ignores unrelated lines interleaved with showinfo lines', () => {
    const stderr = [
      'frame=    1 fps=0.0 q=-1.0',
      '[Parsed_showinfo_0 @ 0x2] n:0 pts:0 pts_time:1.25 pos:0',
      'frame=    2 fps=0.0 q=-1.0',
    ].join('\n');
    expect(parseShowinfoPtsTimes(stderr)).toEqual([1.25]);
  });
});
