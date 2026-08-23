/**
 * Prompt construction for the generated-search worker.
 *
 * Three-phase design, and the ordering is the point: the model proposes a
 * theme and a query, the worker RUNS that query, and only then does the model
 * write the title — from the captions that actually came back. Naming a
 * collection before seeing its contents produces titles that misrepresent
 * their own query, and no result-count check can catch that. Observed live: a
 * model wrote "Memories of August 6th — every year's favorite moments" over a
 * query pinned to 2017 alone, which returns plenty of photos and passes every
 * volume gate while being false.
 *
 * Semantic mode. `placeQuery` routes through Meilisearch with
 * `semantic: meili.semanticConfigured()` (`routes/search/list-meili.ts`), and
 * the embedder template embeds the full caption prose. So the model describes
 * what a photo SHOWS and the vector index does the matching — it is not
 * guessing literal caption keywords.
 *
 * Two rules here are regression guards, not style preferences:
 *
 *   - **No concrete theme names anywhere in the instruction text.** A model
 *     returned "Running Through Sprinklers", lifted verbatim from an
 *     illustrative example in an earlier draft. Examples come back as output.
 *   - **Axes are assigned, not requested.** Asked to "vary the axis", a model
 *     applied one identical date window to three of four collections.
 */

/** Rotating axis assignment. Each collection gets one, so variety is
 * structural rather than a politely-worded hope. Phrased as the shape of the
 * query to build, never as a subject to build it about. */
const AXES: readonly string[] = [
  'anchored on a span of years — pick one the coverage data supports',
  'anchored on one named person from the list',
  'anchored on a recurring month of the year, across every year at once',
  'anchored on a kind of scene or setting, with no date limit',
];

export interface PromptDigest {
  /** Human-readable current date, e.g. "Monday, 17 August 2026". */
  today: string;
  /** Non-hidden person names. Soft-hidden people are withheld upstream so the
   * model never learns they exist. */
  people: readonly string[];
  /** Years with credible coverage (see `digest.ts`). */
  coverageYears: readonly number[];
  /** Per-year counts for the current month, for anniversary themes. */
  onThisMonthByYear: readonly { year: number; count: number }[];
  /** Themes from recent runs, to avoid repeats. */
  recentThemes: readonly string[];
  /** Whether Meilisearch semantic (vector) search is configured. Decides how
   * `placeQuery` guidance is phrased: with vectors, describing the scene
   * works; without them the query is keyword matching against caption text,
   * and abstract prose matches nothing. The design doc calls this branch out
   * explicitly — an install without semantic must get the literal-noun
   * instruction or the worker quietly produces few or no collections. */
  semanticSearch: boolean;
}

function digestBlock(digest: PromptDigest): string {
  const lines = [`TODAY: ${digest.today}`, ''];

  if (digest.people.length > 0) {
    lines.push('PEOPLE (only these names exist)', digest.people.join(', '), '');
  }

  lines.push(
    'COVERAGE (years with enough photos to build from)',
    digest.coverageYears.join(' '),
    '',
  );

  if (digest.onThisMonthByYear.length > 0) {
    lines.push(
      'PHOTOS THIS MONTH, BY YEAR',
      digest.onThisMonthByYear.map(({ year, count }) => `${year}(${count})`).join(' '),
      '',
    );
  }

  if (digest.recentThemes.length > 0) {
    lines.push('THEMES ALREADY USED RECENTLY (do not repeat)', digest.recentThemes.join(', '), '');
  }

  return lines.join('\n');
}

/** How to write `placeQuery`, by search mode. Both variants deliberately
 * avoid concrete example phrases — models lift them verbatim as themes. */
function placeQueryGuidance(semantic: boolean): string {
  if (semantic) {
    return `"placeQuery" is the main lever. Photo captions are matched by MEANING, not
exact words, so describe what the photographs should SHOW - the subject, what
they are doing, and where. Write it the way you would describe a picture to
someone over the phone. A vivid description of a scene works; an abstract
category does not.`;
  }
  return `"placeQuery" is the main lever. Photo captions are matched by KEYWORD - the
exact words have to appear in a caption. Use a few concrete nouns naming
things a caption would literally mention: objects, animals, food, weather,
places. No sentences, no abstract ideas, no mood words - those appear in no
caption and match nothing.`;
}

/** A prior proposal the library measured and rejected, fed back so the next
 * round is not a blind re-guess. The model cannot know whether photos exist
 * in a window it invents — only running the query knows. */
export interface ProposalMiss {
  theme: string;
  /** Photos the query actually matched. */
  count: number;
  /** Compact rendering of the query that missed, e.g.
   * `"beach vacation", 2026-08-01 – 2026-08-31`. */
  querySummary: string;
}

function missFeedback(misses: readonly ProposalMiss[], minResults: number): string {
  if (misses.length === 0) return '';
  const lines = misses
    .map((m) => `- "${m.theme}" (${m.querySummary}) matched only ${m.count}`)
    .join('\n');
  return `

THESE IDEAS DID NOT WORK — each matched too few photos (minimum ${minResults}):
${lines}
The library has too few photos for those queries as written. Widen the date range,
drop a field, or pick a different idea — and do not repeat these as-is.`;
}

/** Phase 1: propose `count` themes and the queries that find them.
 * `misses` carries the previous round's measured failures. */
export function buildProposalPrompt(
  digest: PromptDigest,
  count: number,
  misses: readonly ProposalMiss[] = [],
  minResults = 8,
): string {
  const assignments = Array.from(
    { length: count },
    (_, i) => `${i + 1}. ${AXES[i % AXES.length]}`,
  ).join('\n');

  return `You are curating a personal photo library. Each day you invent a few
collections for the owner to rediscover - the way a friend would say
"hey, remember these?"

Pick ideas that fit TODAY specifically: the season, the date, a holiday, the
weather at this time of year, or an anniversary the coverage data supports.

${digestBlock(digest)}
Return ${count} collections as JSON matching the schema.

"theme" is your own short handle for the idea, 2-4 words, lowercase. Decide it
first, then build the query around it.

${placeQueryGuidance(digest.semanticSearch)}

"people" must be names copied exactly from the list above, or null. A name that
is not on that list matches nothing.

"from" and "to" are YYYY-MM-DD and must fall inside a year listed in COVERAGE.
They are a single continuous range, so they cannot express "this month across
several years" - use "month" for that instead.

"month" is 1-12 and matches that month in EVERY year at once.

Leave a field null rather than guessing. Each field you add narrows the result
further, and a collection with nothing in it is worse than a broad one.

Build each collection on a different axis:
${assignments}${missFeedback(misses, minResults)}`;
}

/** Phase 3: name a collection from the captions it actually returned. */
export function buildTitlePrompt(theme: string, captions: readonly string[]): string {
  return `A photo collection was built around the idea "${theme}". These are
descriptions of photographs it actually contains:

${captions.map((caption) => `- ${caption}`).join('\n')}

Write a title and subtitle for it, as JSON matching the schema.

The title is what the owner sees on a widget or a television - warm, specific,
and true to the photographs listed above rather than to the original idea. If
those photographs turned out to be about something narrower or different than
the idea suggested, name what they actually show.

Keep the title under about 40 characters. The subtitle is one short line of
context, or null if the title already says everything.`;
}

/** Grammar constraint for phase 1. Property order matters: Ollama's
 * constrained decode emits properties in schema order, so `theme` is declared
 * before `query` and conditions what follows — the same ordering trick
 * `describe-prompts.ts` uses for `is_screenshot`.
 *
 * The five query keys ARE the model's entire surface. Server-controlled
 * fields are absent by construction, so there is no key to set. */
export function proposalSchema(count: number): unknown {
  return {
    type: 'object',
    required: ['collections'],
    properties: {
      collections: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          required: ['theme', 'query'],
          properties: {
            theme: { type: 'string' },
            query: {
              type: 'object',
              required: ['placeQuery', 'from', 'to', 'month', 'people', 'sceneType'],
              properties: {
                placeQuery: { type: ['string', 'null'] },
                from: { type: ['string', 'null'] },
                to: { type: ['string', 'null'] },
                month: { type: ['integer', 'null'], minimum: 1, maximum: 12 },
                people: { type: ['string', 'null'] },
                sceneType: {
                  enum: ['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed', null],
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Grammar constraint for phase 3. */
export const TITLE_SCHEMA: unknown = {
  type: 'object',
  required: ['title', 'subtitle'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: ['string', 'null'] },
  },
};
