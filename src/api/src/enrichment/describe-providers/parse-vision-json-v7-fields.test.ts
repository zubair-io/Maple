/**
 * Parser coverage for the fields prompt v7 added: `people_count` and
 * `tags`.
 *
 * Split from `parse-vision-json.test.ts` rather than appended to it —
 * that file sat at 563 lines with these blocks in place, inside the
 * 570-line headroom ceiling but close enough that the next unrelated PR
 * to touch it would have been the one CI failed (CONTRIBUTING
 * §File-size budget). The shared `VALID` fixture is re-declared here
 * rather than exported across files: bun's `*.test.ts` glob would try to
 * run a shared helper as a suite, and the sibling convention in this
 * package is a `.fixtures.ts` file, which is not worth adding for one
 * literal.
 */

import { describe, expect, it } from 'bun:test';
import { parseVisionJson, type VisionParseError } from './parse-vision-json.ts';

const VALID = {
  is_screenshot: false,
  people_count: 1,
  caption: 'A child in a white lacrosse uniform sprints across a green field.',
  tags: ['lacrosse', 'child', 'sports field', 'running', 'white uniform', 'outdoor'],
  subjects: ['person', 'child', 'athlete'],
  scene_type: 'outdoor',
  setting: 'sports field',
  activity: 'lacrosse',
  time_of_day: 'afternoon',
  lighting: 'natural',
  weather: 'clear',
  mood: 'energetic',
  colors: ['green', 'white', 'blue'],
  framing: 'wide',
  text_visible: null,
  notable_objects: ['lacrosse stick', 'helmet', 'cleats'],
  shot_type: 'action',
};

describe('parseVisionJson — people_count (prompt v7)', () => {
  it('parses a plain integer', () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, people_count: 4 }));
    expect(out.people_count).toBe(4);
  });

  it('accepts a numeric string, as an unconstrained provider would emit', () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, people_count: '3' }));
    expect(out.people_count).toBe(3);
  });

  // A fractional count means the model saw whole people plus part of
  // another; the whole-person count is the honest floor, and rejecting the
  // row over it would lose a caption that is otherwise fine.
  it('floors a fractional count rather than dead-lettering the row', () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, people_count: 2.7 }));
    expect(out.people_count).toBe(2);
  });

  it('defaults null / missing to 0', () => {
    expect(parseVisionJson(JSON.stringify({ ...VALID, people_count: null })).people_count).toBe(0);
    const { people_count: _omitted, ...withoutCount } = VALID;
    expect(parseVisionJson(JSON.stringify(withoutCount)).people_count).toBe(0);
  });

  it('rejects a negative count and a non-numeric string as wrong-type', () => {
    for (const bad of [-1, 'several']) {
      try {
        parseVisionJson(JSON.stringify({ ...VALID, people_count: bad }));
        throw new Error('expected throw');
      } catch (e) {
        const err = e as VisionParseError;
        expect(err.reason).toBe('wrong-type');
        expect(err.field).toBe('people_count');
      }
    }
  });
});

describe('parseVisionJson — tags (prompt v7)', () => {
  it('parses the keyword array verbatim', () => {
    const out = parseVisionJson(JSON.stringify(VALID));
    expect(out.tags).toEqual(VALID.tags);
  });

  // Same rationale as subjects/colors/notable_objects: a featureless frame
  // yielding no keywords is "nothing to index", not a parse failure.
  it('collapses null / missing to an empty array', () => {
    expect(parseVisionJson(JSON.stringify({ ...VALID, tags: null })).tags).toEqual([]);
    const { tags: _omitted, ...withoutTags } = VALID;
    expect(parseVisionJson(JSON.stringify(withoutTags)).tags).toEqual([]);
  });

  it('rejects a non-string element as wrong-type', () => {
    try {
      parseVisionJson(JSON.stringify({ ...VALID, tags: ['beach', 7] }));
      throw new Error('expected throw');
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('tags');
    }
  });
});
