/**
 * Pure unit tests for prompt construction.
 *
 * Several assertions here are regression guards for behaviour observed from
 * real models during prompt probing (2026-08-06, ollama ornith:35b +
 * gemma4:12b against the live library) rather than speculative edge cases:
 *
 *   - A concrete example in the instruction text comes back as a theme. A
 *     model returned "Running Through Sprinklers", lifted verbatim from the
 *     prompt's own illustrative example. The prompt must not name themes.
 *   - `rating` filters `$gte`, and a model volunteered `rating: 1`
 *     unprompted. It must not exist in the schema at all — there must be no
 *     key for the model to set.
 *   - Asked politely to "vary the axis", a model applied one identical date
 *     window to three of four collections. Axes are assigned, not requested.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildProposalPrompt,
  buildTitlePrompt,
  proposalSchema,
  TITLE_SCHEMA,
  type PromptDigest,
} from './prompt.ts';

const DIGEST: PromptDigest = {
  today: 'Monday, 17 August 2026',
  people: ['Zoe', 'Greyson', 'Jenn'],
  coverageYears: [2016, 2017, 2018],
  onThisMonthByYear: [
    { year: 2017, count: 315 },
    { year: 2018, count: 242 },
  ],
  recentThemes: ['autumn colours', 'dogs at the lake'],
};

describe('buildProposalPrompt — grounding', () => {
  it('names every person the model is allowed to use', () => {
    const prompt = buildProposalPrompt(DIGEST, 4);
    for (const name of DIGEST.people) expect(prompt).toContain(name);
  });

  it('states the credible coverage years', () => {
    const prompt = buildProposalPrompt(DIGEST, 4);
    expect(prompt).toContain('2016');
    expect(prompt).toContain('2018');
  });

  it('lists recent themes so the model does not repeat them', () => {
    const prompt = buildProposalPrompt(DIGEST, 4);
    expect(prompt).toContain('autumn colours');
    expect(prompt).toContain('dogs at the lake');
  });

  it('asks for the requested number of collections', () => {
    expect(buildProposalPrompt(DIGEST, 3)).toContain('3');
  });

  it('handles a library with no named people without emitting an empty list', () => {
    const prompt = buildProposalPrompt({ ...DIGEST, people: [] }, 2);
    expect(prompt).not.toContain('PEOPLE (only these names exist)\n\n');
  });
});

describe('buildProposalPrompt — semantic mode', () => {
  it('asks for natural-language scene descriptions', () => {
    // Semantic search matches meaning, so the model should describe what the
    // photo SHOWS rather than guess literal caption keywords.
    const prompt = buildProposalPrompt(DIGEST, 4).toLowerCase();
    expect(prompt).toContain('describe');
  });
});

describe('buildProposalPrompt — contamination guard', () => {
  it('contains no concrete theme names the model could copy', () => {
    // Regression guard: a model lifted "Running Through Sprinklers" straight
    // out of an example sentence in an earlier draft of this prompt.
    const prompt = buildProposalPrompt(DIGEST, 4).toLowerCase();
    for (const leaked of ['sprinkler', 'spooky', 'jack-o-lantern', 'birthday cake']) {
      expect(prompt).not.toContain(leaked);
    }
  });

  it('assigns each collection a distinct axis rather than asking for variety', () => {
    const prompt = buildProposalPrompt(DIGEST, 3);
    expect(prompt).toContain('1.');
    expect(prompt).toContain('2.');
    expect(prompt).toContain('3.');
  });
});

describe('proposalSchema', () => {
  it('bounds the array to exactly the requested count', () => {
    const schema = proposalSchema(4) as Record<string, never>;
    const collections = (schema.properties as Record<string, Record<string, number>>).collections;
    expect(collections.minItems).toBe(4);
    expect(collections.maxItems).toBe(4);
  });

  it('offers no key for server-controlled fields', () => {
    // There must be nothing to set, not merely a validator that strips it.
    const json = JSON.stringify(proposalSchema(4));
    for (const forbidden of ['rating', 'excludeHiddenPeople', 'isScreenshot', 'libraryId', 'hidden']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('asks for theme before query so the theme conditions the query', () => {
    // Ollama's grammar-constrained decode emits properties in schema order,
    // the same trick describe-prompts.ts uses for is_screenshot.
    const schema = JSON.stringify(proposalSchema(2));
    expect(schema.indexOf('"theme"')).toBeLessThan(schema.indexOf('"query"'));
  });
});

describe('buildTitlePrompt', () => {
  it('shows the model the captions that actually came back', () => {
    const prompt = buildTitlePrompt('summer sprinklers', [
      'A child runs across a wet lawn.',
      'Two kids laugh under a hose.',
    ]);
    expect(prompt).toContain('A child runs across a wet lawn.');
    expect(prompt).toContain('Two kids laugh under a hose.');
  });

  it('carries the theme through as context', () => {
    expect(buildTitlePrompt('summer sprinklers', ['x'])).toContain('summer sprinklers');
  });

  it('exposes only title and subtitle in its schema', () => {
    expect(Object.keys((TITLE_SCHEMA as never as Record<string, Record<string, unknown>>).properties)).toEqual([
      'title',
      'subtitle',
    ]);
  });
});
