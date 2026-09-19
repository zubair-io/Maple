/**
 * The sort tokens `/api/search` accepts on the wire.
 *
 * Validation only: the route checks the `sort` query parameter against this set
 * and falls back to `captured_desc` for anything else, and the data layer
 * (`db/sqlite/repos/search.page.ts`) turns the accepted token into an ORDER BY.
 * Keeping the vocabulary here rather than beside the SQL is what lets the route
 * reject a typo with a 400 instead of silently sorting by something else.
 */

export const SORT_OPTIONS = new Set(['captured_desc', 'captured_asc', 'name', 'rating']);
