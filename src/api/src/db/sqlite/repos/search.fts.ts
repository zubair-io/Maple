/**
 * Translating a user's free-text query into an FTS5 `MATCH` expression.
 *
 * This is the whole of the "45 `$text` call sites" the ticket estimated. There
 * are two, and both pass a raw user string straight to MongoDB: the
 * `placeQuery` filter in `routes/search/query.ts` and the ranked fallback in
 * `routes/service-asset-search.ts`. Both become `assets_fts MATCH ?`, so both
 * need the same translation, and it lives here rather than at either call site.
 *
 * ## Why the string cannot be forwarded as-is
 *
 * MongoDB's `$text` takes a *search string* — a small grammar of bare terms,
 * `"quoted phrases"` and `-negations` — and anything it does not recognise is
 * simply a term. FTS5's `MATCH` takes a *query expression*, and several
 * characters a person types are operators in it: `*`, `:`, `^`, `(`, `)`, `-`
 * and the bare words `AND`, `OR`, `NOT`, `NEAR`. Forwarding the raw string
 * would turn `C++ (2019)` into a syntax error and `red OR blue` into something
 * the user did not ask for, and an FTS5 syntax error is an exception, not an
 * empty result — it would 500 the search route.
 *
 * So every term is re-emitted as a double-quoted FTS5 string. Inside double
 * quotes FTS5 treats the content as literal text to tokenise, so no character a
 * user can type is an operator any more, and the only escape needed is doubling
 * an embedded `"`.
 *
 * ## Keeping Mongo's meaning
 *
 * `$text` ORs its bare terms, requires every quoted phrase, and excludes
 * anything matching a `-` term. The expression built here says exactly that:
 *
 *     ("required phrase" AND ("one" OR "two")) NOT ("unwanted")
 *
 * FTS5 binds `NOT` tighter than `AND` and `AND` tighter than `OR`, so every
 * group is parenthesised rather than relying on that.
 *
 * ## Ranking
 *
 * `bm25(assets_fts)` replaces `{ $meta: 'textScore' }`. The two disagree on
 * sign: a Mongo text score is positive and sorts descending, while `bm25()`
 * returns a negative number whose magnitude grows with relevance, so the best
 * match is the *smallest* value and the sort is ascending. {@link FTS_RANK_SQL}
 * and {@link FTS_RANK_ORDER} are the pair that keeps that straight.
 */

/**
 * A term the user typed, after the surrounding syntax has been read off it.
 *
 * `phrase` records whether the term arrived inside double quotes, because a
 * multi-word phrase must match adjacently while bare words are independent.
 * Both are emitted as quoted FTS5 strings; the difference is whether the term
 * joins the AND group or the OR group.
 */
interface ParsedTerm {
  text: string;
  phrase: boolean;
  negated: boolean;
}

/**
 * Characters that can carry meaning to the `unicode61` tokenizer.
 *
 * A term made only of punctuation tokenises to nothing, and an FTS5 string that
 * produces no tokens matches every row rather than none — `MATCH '"!!"'` is not
 * an error, it is a query with no terms. Dropping those terms here is what stops
 * a query of `???` from returning the whole library.
 *
 * The test is deliberately Unicode-aware: `naïve`, `東京` and `Кремль` are all
 * real search terms and all fail an `[a-z0-9]` test.
 */
const HAS_TOKEN_CHARS = /[\p{L}\p{N}]/u;

/** Longest query we will translate. Matches the service route's own cap. */
const MAX_QUERY_CHARS = 500;

/**
 * Bound on how many terms one query contributes to the expression.
 *
 * FTS5 costs roughly one index scan per term, so a 500-character query of
 * single letters would otherwise fan out into 250 scans on a reader thread.
 * Terms past the cap are dropped rather than rejected, because a person who
 * pasted a paragraph into the search box wants results, not a 400.
 */
const MAX_TERMS = 24;

/**
 * A bare term, split the way the tokenizer will split it.
 *
 * `harbour.dng` has to become two independent terms, not one two-word phrase.
 * MongoDB's `$text` tokenizes on punctuation and ORs what comes out, so it
 * matches a document containing only `harbour`; FTS5 tokenizes the *inside* of
 * a quoted string too, and a quoted string of two tokens is a phrase requiring
 * them adjacent. Re-emitting `"harbour.dng"` verbatim would therefore quietly
 * narrow every query with a filename, a URL or a hyphenated word in it — which
 * is exactly the silent relevance regression this port has to avoid.
 *
 * A term the tokenizer would discard entirely (`???`, `+++`) yields nothing and
 * drops out. Deliberately Unicode-aware: `naïve`, `東京` and `Кремль` are real
 * search terms that an `[a-z0-9]` split would mangle or discard.
 */
function splitBareTerm(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);
}

/**
 * Split a search string into terms, honouring quotes and leading `-`.
 *
 * Written as a single scan rather than a regex split because the two features
 * interact: `-"cat dog"` is one negated phrase, and a quote can contain the
 * spaces the split would otherwise happen on. An unterminated quote runs to the
 * end of the string, which is what a person half-way through typing a phrase
 * means by it.
 */
function parseTerms(input: string): ParsedTerm[] {
  const terms: ParsedTerm[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    const negated = char === '-';
    const afterSign = negated ? index + 1 : index;
    if (input[afterSign] === '"') {
      const closing = input.indexOf('"', afterSign + 1);
      const end = closing === -1 ? input.length : closing;
      terms.push({ text: input.slice(afterSign + 1, end), phrase: true, negated });
      index = end + 1;
      continue;
    }

    const next = input.slice(afterSign).search(/\s/);
    const end = next === -1 ? input.length : afterSign + next;
    for (const part of splitBareTerm(input.slice(afterSign, end))) {
      terms.push({ text: part, phrase: false, negated });
    }
    index = end;
  }

  return terms.filter((term) => HAS_TOKEN_CHARS.test(term.text)).slice(0, MAX_TERMS);
}

/** One term as an FTS5 string literal: double-quoted, inner quotes doubled. */
function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The FTS5 `MATCH` expression for a user's query, or `null` when the query
 * carries nothing searchable.
 *
 * `null` is a real answer, not a failure. It happens for an empty string, for
 * punctuation-only input, and for a query that is nothing but negations — the
 * last of which FTS5 cannot express at all, since `NOT` needs a left operand.
 * Every caller treats `null` as "this query has no text filter", which is what
 * the route already does for a blank `placeQuery`.
 */
export function toMatchExpression(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_QUERY_CHARS) return null;
  const terms = parseTerms(raw);
  if (terms.length === 0) return null;

  const required = terms.filter((t) => !t.negated && t.phrase).map((t) => quote(t.text));
  const optional = terms.filter((t) => !t.negated && !t.phrase).map((t) => quote(t.text));
  const excluded = terms.filter((t) => t.negated).map((t) => quote(t.text));

  const positive = [...required, ...(optional.length > 0 ? [`(${optional.join(' OR ')})`] : [])];
  if (positive.length === 0) return null;

  const included = `(${positive.join(' AND ')})`;
  return excluded.length === 0 ? included : `${included} NOT (${excluded.join(' OR ')})`;
}

/**
 * The relevance score, under the name a row carries it back as.
 *
 * Aliased rather than inlined into the `ORDER BY` so the value can also be
 * selected and asserted on — the relevance comparison in
 * `scripts/sqlite-bench/search-compare.ts` reads it to rank FTS5's answers
 * against MongoDB's.
 */
export const FTS_RANK_SQL = 'bm25(assets_fts) AS rank';

/**
 * Ascending, because `bm25()` is negative and the best match is the most
 * negative. Writing `DESC` here — the direction a Mongo text score wants —
 * returns the *worst* matches first and every result still looks plausible,
 * which is exactly the kind of silent relevance regression this ticket exists
 * to rule out.
 */
export const FTS_RANK_ORDER = 'rank ASC';
