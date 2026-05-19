import { describe, expect, it } from "bun:test";
import { parseVisionJson, VisionParseError } from "./parse-vision-json.ts";
import {
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
} from "../enrichment-config.repo.ts";

const VALID = {
  caption: "A child in a white lacrosse uniform sprints across a green field.",
  subjects: ["person", "child", "athlete"],
  scene_type: "outdoor",
  setting: "sports field",
  activity: "lacrosse",
  time_of_day: "afternoon",
  lighting: "natural",
  weather: "clear",
  mood: "energetic",
  colors: ["green", "white", "blue"],
  composition: "wide shot",
  text_visible: null,
  notable_objects: ["lacrosse stick", "helmet", "cleats"],
  shot_type: "action",
  indoor_outdoor: "outdoor",
};

describe("parseVisionJson — happy paths", () => {
  it("parses a fully-valid JSON object", () => {
    const out = parseVisionJson(JSON.stringify(VALID));
    expect(out.caption).toBe(VALID.caption);
    expect(out.subjects).toEqual(VALID.subjects);
    expect(out.scene_type).toBe("outdoor");
    expect(out.text_visible).toBeNull();
  });

  it("strips a leading/trailing ```json markdown fence", () => {
    const wrapped = "```json\n" + JSON.stringify(VALID) + "\n```";
    const out = parseVisionJson(wrapped);
    expect(out.caption).toBe(VALID.caption);
  });

  it("strips a plain ``` markdown fence (no language tag)", () => {
    const wrapped = "```\n" + JSON.stringify(VALID) + "\n```";
    const out = parseVisionJson(wrapped);
    expect(out.activity).toBe("lacrosse");
  });

  it("accepts null for nullable fields (setting / activity / text_visible)", () => {
    const v = { ...VALID, setting: null, activity: null, text_visible: null };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.setting).toBeNull();
    expect(out.activity).toBeNull();
    expect(out.text_visible).toBeNull();
  });

  it("accepts a string for nullable fields when populated", () => {
    const v = { ...VALID, text_visible: "GO TEAM" };
    const out = parseVisionJson(JSON.stringify(v));
    expect(out.text_visible).toBe("GO TEAM");
  });
});

describe("parseVisionJson — rejection paths", () => {
  it("rejects empty input", () => {
    expect(() => parseVisionJson("")).toThrow(VisionParseError);
    try {
      parseVisionJson("");
    } catch (e) {
      expect((e as VisionParseError).reason).toBe("empty-response");
    }
  });

  it("rejects prose with no JSON object", () => {
    expect(() => parseVisionJson("Sure, here is the JSON: { ... }")).toThrow(
      VisionParseError,
    );
  });

  it("rejects when the model returns an array instead of an object", () => {
    try {
      parseVisionJson("[1, 2, 3]");
    } catch (e) {
      expect((e as VisionParseError).reason).toBe("not-object");
    }
  });

  it("rejects a missing required field (caption)", () => {
    const v = { ...VALID } as Partial<typeof VALID>;
    delete v.caption;
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe("wrong-type");
      expect(err.field).toBe("caption");
    }
  });

  it("rejects an empty caption string", () => {
    const v = { ...VALID, caption: "   " };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.field).toBe("caption");
    }
  });

  it("rejects a wrong-enum value (scene_type: 'underwater')", () => {
    const v = { ...VALID, scene_type: "underwater" };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe("bad-enum");
      expect(err.field).toBe("scene_type");
    }
  });

  it("rejects subjects with a non-string entry", () => {
    const v = { ...VALID, subjects: ["person", 7, "athlete"] };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe("wrong-type");
      expect(err.field).toBe("subjects");
    }
  });

  it("rejects non-array subjects", () => {
    const v = { ...VALID, subjects: "person" };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      expect((e as VisionParseError).field).toBe("subjects");
    }
  });

  it("rejects wrong-type for nullable fields (setting: 42)", () => {
    const v = { ...VALID, setting: 42 };
    try {
      parseVisionJson(JSON.stringify(v));
    } catch (e) {
      const err = e as VisionParseError;
      expect(err.reason).toBe("wrong-type");
      expect(err.field).toBe("setting");
    }
  });

  it("includes a truncated snippet in the error for triage", () => {
    const big = "x".repeat(20_000); // > 8 KB cap
    try {
      parseVisionJson(big);
    } catch (e) {
      const err = e as VisionParseError;
      // 8192 bytes + "…[truncated]" suffix
      expect(err.snippet.length).toBeLessThanOrEqual(8 * 1024 + 32);
      expect(err.snippet.endsWith("…[truncated]")).toBe(true);
    }
  });

  it("rejects when JSON parses but is wrapped in stray prose", () => {
    const polluted = `Here is the JSON:\n${JSON.stringify(VALID)}\nHope this helps!`;
    expect(() => parseVisionJson(polluted)).toThrow(VisionParseError);
  });
});

describe("prompt ↔ parser cross-check", () => {
  const REQUIRED_KEYS = [
    "caption",
    "subjects",
    "scene_type",
    "setting",
    "activity",
    "time_of_day",
    "lighting",
    "weather",
    "mood",
    "colors",
    "composition",
    "text_visible",
    "notable_objects",
    "shot_type",
    "indoor_outdoor",
  ] as const;

  for (const key of REQUIRED_KEYS) {
    it(`DEFAULT_DESCRIBE_VISION_PROMPT mentions "${key}"`, () => {
      // Match the JSON-key shape ("key":) so plain prose mentions don't satisfy.
      const pattern = new RegExp(`"${key}"\\s*:`);
      expect(pattern.test(DEFAULT_DESCRIBE_VISION_PROMPT)).toBe(true);
    });
  }

  it("DESCRIBE_VISION_PROMPT_VERSION is 2 (post-llava)", () => {
    expect(DESCRIBE_VISION_PROMPT_VERSION).toBe(2);
  });
});

describe("parseVisionJson — every enum is honoured", () => {
  const enumCases: ReadonlyArray<[keyof typeof VALID, readonly string[]]> = [
    ["scene_type", ["indoor", "outdoor", "aerial", "macro", "studio", "mixed"]],
    [
      "time_of_day",
      ["morning", "midday", "afternoon", "golden hour", "evening", "night", "unknown"],
    ],
    ["lighting", ["natural", "artificial", "mixed", "low-light", "backlit", "flash"]],
    ["weather", ["clear", "cloudy", "rainy", "snowy", "foggy", "indoor", "unknown"]],
    [
      "composition",
      ["wide shot", "close-up", "portrait", "landscape", "aerial", "macro", "candid"],
    ],
    [
      "shot_type",
      ["action", "static", "candid", "posed", "architectural", "nature", "event"],
    ],
    ["indoor_outdoor", ["indoor", "outdoor"]],
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
