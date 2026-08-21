/**
 * Filter-expression construction for the Meilisearch query.
 *
 * The vision fields and `isScreenshot` are declared in the index's
 * `filterableAttributes` but had no clause here, so `/api/search` could not
 * push them down and fell back to post-filtering one page of relevance-ranked
 * ids in Mongo (#2932). These clauses are what make the pushdown possible.
 *
 * Escaping matters as much as the clause itself: `activity` and `subjects`
 * are open-vocabulary strings straight off the wire, so they are the same
 * injection surface the date bounds were in #2929.
 */

import { describe, expect, it } from 'bun:test';
import { buildFilter } from './meilisearch-filter.ts';

describe('buildFilter — vision + screenshot clauses', () => {
  it('pushes a closed-union scene type', () => {
    expect(buildFilter({ sceneType: 'aerial' })).toContain('visionSceneType = "aerial"');
  });

  it('pushes an open-vocab activity', () => {
    expect(buildFilter({ activity: 'skiing' })).toContain('visionActivity = "skiing"');
  });

  it('pushes subjects as an OR within the field', () => {
    expect(buildFilter({ subjects: ['dog', 'beach'] })).toContain(
      'visionSubjects IN ["dog", "beach"]',
    );
  });

  it('omits a subjects clause entirely when the list is empty', () => {
    expect(buildFilter({ subjects: [] })).not.toContain('visionSubjects');
  });

  it('narrows to screenshots when isScreenshot is true', () => {
    expect(buildFilter({ isScreenshot: true })).toContain('isScreenshot = true');
  });

  /**
   * Mirrors the Mongo predicate, which is `$ne: true` rather than `false` so
   * rows indexed before `is_screenshot` was written still count as photos.
   * A bare `isScreenshot = false` would hide every one of them.
   */
  it('treats a missing isScreenshot as "not a screenshot"', () => {
    expect(buildFilter({ isScreenshot: false })).toContain(
      '(isScreenshot NOT EXISTS OR isScreenshot IS NULL OR isScreenshot = false)',
    );
  });

  /**
   * `IS NULL` matches a field PRESENT and null, not an absent one, and
   * `isScreenshot` only entered the document at shape v5. Without the
   * `NOT EXISTS` arm every pre-v5 document silently vanishes from
   * "Photos only".
   */
  it('admits documents indexed before isScreenshot existed', () => {
    expect(buildFilter({ isScreenshot: false })).toContain('isScreenshot NOT EXISTS');
  });

  it('admits documents indexed before the hidden field existed', () => {
    expect(buildFilter({})).toContain('hidden NOT EXISTS');
  });

  it('leaves screenshot state unconstrained when the filter is absent', () => {
    expect(buildFilter({})).not.toContain('isScreenshot');
  });
});

describe('buildFilter — injection safety on open-vocabulary values', () => {
  // Asserted as the exact rendered literal, not as an absent substring: an
  // escaped quote (\") still CONTAINS a quote, so a `not.toContain('" OR ...')`
  // check passes whether or not the escaping actually happened.
  it('escapes a double quote in an activity rather than closing the literal', () => {
    const filter = buildFilter({ activity: 'ski" OR hidden = true OR activity = "x' });
    expect(filter).toContain('visionActivity = "ski\\" OR hidden = true OR activity = \\"x"');
  });

  it('escapes double quotes in every subject', () => {
    const filter = buildFilter({ subjects: ['dog', 'cat" OR hidden = true'] });
    expect(filter).toContain('visionSubjects IN ["dog", "cat\\" OR hidden = true"]');
  });

  it('escapes a backslash so it cannot escape the closing quote', () => {
    expect(buildFilter({ activity: 'a\\' })).toContain('\\\\');
  });
});
