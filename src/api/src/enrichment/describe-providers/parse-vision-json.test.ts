import { describe, expect, it } from 'bun:test';
import { parseVisionJson, VisionParseError } from './parse-vision-json.ts';
import {
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
} from '../enrichment-config.repo.ts';

const VALID = {
  is_screenshot: false,
  caption: 'A child in a white lacrosse uniform sprints across a green field.',
  subjects: ['person', 'child', 'athlete'],
  scene_type: 'outdoor',
  setting: 'sports field',
  activity: 'lacrosse',
  time_of_day: 'afternoon',
  lighting: 'natural',
  weather: 'clear',
  mood: 'energetic',
  colors: ['green', 'white', 'blue'],
  composition: 'wide shot',
  text_visible: null,
  notable_objects: ['lacrosse stick', 'helmet', 'cleats'],
  shot_type: 'action',
};

describe('parseVisionJson — happy paths', () => {
  it('parses a fully-valid JSON object', () => {
    const out = parseVisionJson(JSON.stringify(VALID));
    expect(out.caption).toBe(VALID.caption);
    expect(out.subjects).toEqual(VALID.subjects);
    expect(out.scene_type).toBe('outdoor');
    expect(out.text_visible).toBeNull();
  });

  it('strips a leading/trailing ```json markdown fence', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID) + '\n```';
    const out = parseVisionJson(wrapped);
    expect(out.caption).toBe(VALID.caption);
  });

  it('strips a plain ``` markdown fence (no language tag)', () => {
    const wrapped = '```\n' + JSON.stringify(VALID) + '\n```';
    const out = parseVisionJson(wrapped);
    expect(out.activity).toBe('lacrosse');
  });

  it('accepts null for nullable fields (setting / activity / text_visible)', () => {
    const v = { ...VALID, setting: null, activity: null, text_visible: null };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.setting).toBeNull();
    expect(out.activity).toBeNull();
    expect(out.text_visible).toBeNull();
  });

  it('accepts a string for nullable fields when populated', () => {
    const v = { ...VALID, text_visible: 'GO TEAM' };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.text_visible).toBe('GO TEAM');
  });
});

describe('parseVisionJson — rejection paths', () => {
  it('rejects empty input', () => {
    expect(() => parseVisionJson('')).toThrow(VisionParseError);
    try {
      parseVisionJson('');
    } catch (e) {
      expect((e as VisionParseError).reason).toBe('empty-response');
    }
  });

  it('rejects prose with no JSON object', () => {
    expect(() => parseVisionJson('Sure, here is the JSON: { ... }')).toThrow(VisionParseError);
  });

  it('rejects when the model returns an array instead of an object', () => {
    try {
      parseVisionJson('[1, 2, 3]');
    } catch (e) {
      expect((e as VisionParseError).reason).toBe('not-object');
    }
  });

  it('rejects a missing required field (caption)', () => {
    const v = { ...VALID } as Partial<typeof VALID>;
    delete v.caption;
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('caption');
    }
  });

  it('rejects an empty caption string', () => {
    const v = { ...VALID, caption: '   ' };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.field).toBe('caption');
    }
  });

  it("rejects a wrong-enum value (scene_type: 'underwater')", () => {
    const v = { ...VALID, scene_type: 'underwater' };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('bad-enum');
      expect(err.field).toBe('scene_type');
    }
  });

  it('rejects subjects with a non-string entry', () => {
    const v = { ...VALID, subjects: ['person', 7, 'athlete'] };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('subjects');
    }
  });

  it('rejects non-array subjects', () => {
    const v = { ...VALID, subjects: 'person' };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      expect((e as VisionParseError).field).toBe('subjects');
    }
  });

  it('rejects wrong-type for nullable fields (setting: 42)', () => {
    const v = { ...VALID, setting: 42 };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('setting');
    }
  });

  it('defaults is_screenshot to false when missing (qwen omits it on outdoor scenes)', () => {
    const v = { ...VALID } as Partial<typeof VALID>;
    delete v.is_screenshot;
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.is_screenshot).toBe(false);
  });

  it('coerces is_screenshot string variants to boolean', () => {
    for (const [raw, expected] of [
      ['false', false],
      ['False', false],
      ['FALSE', false],
      ['no', false],
      ['0', false],
      ['', false],
      ['true', true],
      ['True', true],
      ['yes', true],
      ['1', true],
    ] as const) {
      const out = parseVisionJson(JSON.stringify({ ...VALID, is_screenshot: raw }));
      expect(out.is_screenshot).toBe(expected);
    }
  });

  it('coerces is_screenshot numeric variants to boolean', () => {
    expect(parseVisionJson(JSON.stringify({ ...VALID, is_screenshot: 0 })).is_screenshot).toBe(
      false,
    );
    expect(parseVisionJson(JSON.stringify({ ...VALID, is_screenshot: 1 })).is_screenshot).toBe(
      true,
    );
  });

  it('treats null/undefined is_screenshot as false', () => {
    expect(parseVisionJson(JSON.stringify({ ...VALID, is_screenshot: null })).is_screenshot).toBe(
      false,
    );
  });

  it("rejects is_screenshot values that can't be coerced (object, array, garbage string)", () => {
    for (const v of [
      { ...VALID, is_screenshot: {} },
      { ...VALID, is_screenshot: [] },
      { ...VALID, is_screenshot: 'maybe' },
    ]) {
      try {
        parseVisionJson(JSON.stringify(v));
        throw new Error('expected throw');
      } catch (e) {
        const err = e as VisionParseError;
        expect(err.reason).toBe('wrong-type');
        expect(err.field).toBe('is_screenshot');
      }
    }
  });

  it('accepts is_screenshot = true', () => {
    const v = { ...VALID, is_screenshot: true };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.is_screenshot).toBe(true);
  });

  it('joins text_visible string[] into a newline-separated string', () => {
    const v = { ...VALID, text_visible: ['STOP', 'SLOW', 'ONE WAY'] };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.text_visible).toBe('STOP\nSLOW\nONE WAY');
  });

  it('collapses empty / all-empty text_visible array to null', () => {
    expect(parseVisionJson(JSON.stringify({ ...VALID, text_visible: [] })).text_visible).toBeNull();
    expect(
      parseVisionJson(JSON.stringify({ ...VALID, text_visible: ['', ''] })).text_visible,
    ).toBeNull();
    expect(parseVisionJson(JSON.stringify({ ...VALID, text_visible: '' })).text_visible).toBeNull();
  });

  it('rejects text_visible when array contains non-strings', () => {
    const v = { ...VALID, text_visible: ['STOP', 42] };
    try {
      parseVisionJson(JSON.stringify(v));
      throw new Error('expected throw');
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('text_visible');
    }
  });

  it('includes a truncated snippet in the error for triage', () => {
    const big = 'x'.repeat(20_000); // > 8 KB cap
    try {
      parseVisionJson(big);
    } catch (e) {
      const err = e as VisionParseError;
      // 8192 bytes + "…[truncated]" suffix
      expect(err.snippet.length).toBeLessThanOrEqual(8 * 1024 + 32);
      expect(err.snippet.endsWith('…[truncated]')).toBe(true);
    }
  });

  it('rejects when JSON parses but is wrapped in stray prose', () => {
    const polluted = `Here is the JSON:\n${JSON.stringify(VALID)}\nHope this helps!`;
    expect(() => parseVisionJson(polluted)).toThrow(VisionParseError);
  });

  it('collapses subjects/colors/notable_objects = null to []', () => {
    const v = { ...VALID, subjects: null, colors: null, notable_objects: null };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.subjects).toEqual([]);
    expect(out.colors).toEqual([]);
    expect(out.notable_objects).toEqual([]);
  });

  it("still rejects array-shaped fields where contents aren't strings", () => {
    for (const field of ['subjects', 'colors', 'notable_objects'] as const) {
      const v = { ...VALID, [field]: ['ok', 42] };
      try {
        parseVisionJson(JSON.stringify(v));
        throw new Error('expected throw');
      } catch (e) {
        const err = e as VisionParseError;
        expect(err.reason).toBe('wrong-type');
        expect(err.field).toBe(field);
      }
    }
  });

  it('coerces weather synonyms to allowed values', () => {
    for (const [raw, expected] of [
      ['partly cloudy', 'cloudy'],
      ['Partly Cloudy', 'cloudy'],
      ['mostly cloudy', 'cloudy'],
      ['overcast', 'cloudy'],
      ['sunny', 'clear'],
      ['clear sky', 'clear'],
      ['rain', 'rainy'],
      ['snow', 'snowy'],
      ['fog', 'foggy'],
      ['haze', 'foggy'],
    ] as const) {
      const out = parseVisionJson(JSON.stringify({ ...VALID, weather: raw }));
      expect(out.weather).toBe(expected);
    }
  });

  it('coerces time_of_day synonyms', () => {
    for (const [raw, expected] of [
      ['day', 'midday'],
      ['daytime', 'midday'],
      ['noon', 'midday'],
      ['dusk', 'evening'],
      ['dawn', 'morning'],
      ['sunset', 'golden hour'],
      ['midnight', 'night'],
    ] as const) {
      const out = parseVisionJson(JSON.stringify({ ...VALID, time_of_day: raw }));
      expect(out.time_of_day).toBe(expected);
    }
  });

  it('coerces scene_type synonyms (static → mixed when qwen confuses it with shot_type)', () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, scene_type: 'static' }));
    expect(out.scene_type).toBe('mixed');
  });

  it('coerces composition synonyms when qwen emits shot_type values in the composition field', () => {
    for (const [raw, expected] of [
      // "candid" left the composition enum in v5 — it's a shot-type
      // concept — so it now maps here too instead of round-tripping.
      ['candid', 'wide shot'],
      ['action', 'wide shot'],
      ['static', 'wide shot'],
      ['posed', 'portrait'],
      ['architectural', 'wide shot'],
      ['nature', 'landscape'],
      ['event', 'wide shot'],
      // pre-existing synonyms still work
      ['panorama', 'wide shot'],
      ['closeup', 'close-up'],
    ] as const) {
      const out = parseVisionJson(JSON.stringify({ ...VALID, composition: raw }));
      expect(out.composition).toBe(expected);
    }
  });

  it('defaults nullable enum fields when qwen returns null on featureless images', () => {
    const v = {
      ...VALID,
      scene_type: null,
      time_of_day: null,
      lighting: null,
      weather: null,
      mood: null,
      composition: null,
      shot_type: null,
    };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.scene_type).toBe('mixed');
    expect(out.time_of_day).toBe('unknown');
    expect(out.lighting).toBe('unknown');
    expect(out.weather).toBe('unknown');
    expect(out.mood).toBe('neutral');
    expect(out.composition).toBe('wide shot');
    expect(out.shot_type).toBe('static');
  });

  it('nulls every scene field when is_screenshot is true (screenshot short-circuit)', () => {
    const v = {
      ...VALID,
      is_screenshot: true,
      scene_type: 'outdoor',
      setting: 'a beach',
      activity: 'swimming',
      time_of_day: 'afternoon',
      lighting: 'natural',
      weather: 'clear',
      composition: 'wide shot',
      shot_type: 'action',
    };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.scene_type).toBeNull();
    expect(out.setting).toBeNull();
    expect(out.activity).toBeNull();
    expect(out.time_of_day).toBeNull();
    expect(out.lighting).toBeNull();
    expect(out.weather).toBeNull();
    expect(out.composition).toBeNull();
    expect(out.shot_type).toBeNull();
    // Non-scene fields are unaffected by the short-circuit.
    expect(out.is_screenshot).toBe(true);
    expect(out.caption).toBe(VALID.caption);
  });

  it('preserves the reason taxonomy: non-string enum input is wrong-type, unmapped string is bad-enum', () => {
    // Non-string for an enum field → wrong-type (the model gave us the
    // wrong shape entirely, not just a bad value).
    try {
      parseVisionJson(JSON.stringify({ ...VALID, scene_type: 42 }));
      throw new Error('expected throw');
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('wrong-type');
      expect(err.field).toBe('scene_type');
    }
    // String that isn't in allowed and has no synonym → bad-enum.
    try {
      parseVisionJson(JSON.stringify({ ...VALID, scene_type: 'intergalactic' }));
      throw new Error('expected throw');
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe('bad-enum');
      expect(err.field).toBe('scene_type');
    }
  });

  it("preserves multi-word enum values that contain spaces ('golden hour')", () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, time_of_day: 'golden hour' }));
    expect(out.time_of_day).toBe('golden hour');
  });

  it('trims + lowercases enum strings before lookup', () => {
    const out = parseVisionJson(JSON.stringify({ ...VALID, weather: '  CLEAR  ' }));
    expect(out.weather).toBe('clear');
  });
});

describe('prompt ↔ parser cross-check', () => {
  const REQUIRED_KEYS = [
    'is_screenshot',
    'caption',
    'subjects',
    'scene_type',
    'setting',
    'activity',
    'time_of_day',
    'lighting',
    'weather',
    'mood',
    'colors',
    'composition',
    'text_visible',
    'notable_objects',
    'shot_type',
  ] as const;

  for (const key of REQUIRED_KEYS) {
    it(`DEFAULT_DESCRIBE_VISION_PROMPT mentions "${key}"`, () => {
      // Match the JSON-key shape ("key":) so plain prose mentions don't satisfy.
      const pattern = new RegExp(`"${key}"\\s*:`);
      expect(pattern.test(DEFAULT_DESCRIBE_VISION_PROMPT)).toBe(true);
    });
  }

  it('DESCRIBE_VISION_PROMPT_VERSION is 6 (remove nudity and auto-hide prompt)', () => {
    expect(DESCRIBE_VISION_PROMPT_VERSION).toBe(6);
  });
});

describe('parseVisionJson — every enum is honoured', () => {
  const enumCases: ReadonlyArray<[keyof typeof VALID, readonly string[]]> = [
    ['scene_type', ['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed']],
    [
      'time_of_day',
      ['morning', 'midday', 'afternoon', 'golden hour', 'evening', 'night', 'unknown'],
    ],
    ['lighting', ['natural', 'artificial', 'mixed', 'low-light', 'backlit', 'flash', 'unknown']],
    ['weather', ['clear', 'cloudy', 'rainy', 'snowy', 'foggy', 'indoor', 'unknown']],
    ['composition', ['wide shot', 'close-up', 'portrait', 'landscape', 'aerial', 'macro']],
    ['shot_type', ['action', 'static', 'candid', 'posed', 'architectural', 'nature', 'event']],
  ];

  for (const [field, allowed] of enumCases) {
    for (const value of allowed) {
      it(`accepts ${field} = ${JSON.stringify(value)}`, () => {
        const v = { ...VALID, [field]: value };
        expect(() => parseVisionJson(JSON.stringify(v))).not.toThrow();
      });
    }
  }
});
