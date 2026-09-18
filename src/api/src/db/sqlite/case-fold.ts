/**
 * The key a case-insensitive unique index is built over (#3749).
 *
 * ## Why a stored key rather than a collation
 *
 * The Mongo indexes this schema replaces are declared with
 * `{ locale: 'en', strength: 2 }` — case-insensitive, accent-sensitive — and
 * the behaviour built on top of that is load-bearing: naming two face clusters
 * the same thing is how an operator says they are the same person, so
 * `people_name_unique` is what turns a rename collision into a merge.
 *
 * SQLite's built-in `NOCASE` collation folds ASCII `A`–`Z` and nothing else,
 * and `lower()` is the same. Under it "josé" and "JOSÉ" are two different
 * names: the lookup misses, the unique index permits the second row, and the
 * operator ends up with two people instead of one merge. `bun:sqlite` exposes
 * no way to register a collation of our own (no `createCollation`, no
 * `loadExtension` build with ICU), so the fold has to happen before the value
 * reaches SQLite, and the folded form has to be stored for the index to be
 * built over.
 *
 * ## What the fold is
 *
 * `NFKC` then `toLowerCase`. Checked against
 * `localeCompare(b, 'en', { sensitivity: 'accent' })`, which is the same
 * strength-2 rule the Mongo collation applies, the two agree on every case
 * that distinguishes them: `José`/`JOSÉ` and `Ω`/`ω` fold together, `e`/`é`
 * and `ß`/`ss` and `İ`/`i` stay apart, and the compatibility forms `ﬁ`/`fi`,
 * `Ⅻ`/`xii` and `ＡＢ`/`ab` fold together — the last three are why the
 * normalisation is `NFKC` and not `NFC`.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the Mongo collation names a
 * locale (`en`) and the process locale is not it. Turkish dotless-i rules must
 * not decide whether two people merge.
 *
 * The comparison in JavaScript goes through this same function rather than
 * through `localeCompare`, which is the point. A repo that asks SQL one
 * question and asks itself a different one gets to disagree with its own
 * unique index; folding once means it cannot.
 */

/**
 * The case-insensitive identity of `value`, for storing beside it in a
 * `*_key` column and comparing against.
 *
 * Not a display value and never shown: the original spelling is what a reader
 * sees, and this is only ever what the database compares.
 */
export function caseFoldKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}
