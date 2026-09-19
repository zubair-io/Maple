/**
 * Shared people-list query core — the one list body behind `listPeople`
 * (people.repo.ts) and the recovery lists (people-visibility.repo.ts).
 * Its own module so the visibility repo doesn't import people.repo.ts
 * (which re-exports the visibility API — that edge would be a cycle).
 *
 * The body now lives in `db/sqlite/repos/people.list.ts`. One thing changed
 * shape in the move: `listPeopleByFilter` takes a SQL predicate string rather
 * than a Mongo filter document, which is why the three predicates a caller may
 * pass are exported alongside it. They are constants, never built from request
 * input — that is what makes interpolating them safe.
 */

export type { PersonWithCount } from '../db/sqlite/repos/people.list.ts';
