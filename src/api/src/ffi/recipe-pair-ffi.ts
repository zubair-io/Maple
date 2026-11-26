/**
 * Binding for `maple_export_recipe_pair_to_files` (#6034): two recipe renders
 * of one source from a single read and a single sensor decode. Each staging
 * file holds the bytes `maple_export_recipe_to_file` writes for that recipe.
 */

import { child as childLogger } from '../log.ts';
import type { RecipeStaging } from './raw_ffi-protocol.ts';
import type * as BunFfi from 'bun:ffi';

const log = childLogger('raw-ffi');

const SECOND_RENDER_FAILED = 101;

/** Both staging files were written, only the first, or neither. */
export type RecipePairOutcome = { written: 'both' | 'first' } | { error: string };

export type RecipePairExport = (
  rawPath: string,
  xmp: string,
  filmPath: string | null,
  first: RecipeStaging,
  second: RecipeStaging,
) => RecipePairOutcome;

/** Bound on its own so a dylib that predates the symbol still loads every
 * other entry; callers then render each recipe with its own decode. */
export function bindRecipePairExport(libPath: string): RecipePairExport | undefined {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof BunFfi;
    const text = FFIType.cstring;
    const { symbols } = dlopen(libPath, {
      maple_export_recipe_pair_to_files: {
        args: [text, text, text, text, text, text, text],
        returns: FFIType.i32,
      },
      maple_last_error: { args: [], returns: FFIType.cstring },
    });
    return (rawPath, xmp, filmPath, first, second) => {
      const [raw, document, firstRecipe, firstOut, secondRecipe, secondOut] = [
        rawPath,
        xmp,
        first.recipeJson,
        first.outPath,
        second.recipeJson,
        second.outPath,
      ].map((value) => Buffer.from(value + '\0', 'utf-8'));
      const film = filmPath ? Buffer.from(filmPath + '\0', 'utf-8') : null;
      const rc = symbols.maple_export_recipe_pair_to_files(
        ptr(raw!),
        ptr(document!),
        film ? ptr(film) : null,
        ptr(firstRecipe!),
        ptr(firstOut!),
        ptr(secondRecipe!),
        ptr(secondOut!),
      );
      if (rc === 0) return { written: 'both' };
      const reason = String(symbols.maple_last_error() ?? `paired recipe render failed (rc ${rc})`);
      if (rc !== SECOND_RENDER_FAILED) return { error: reason };
      log.warn({ rawPath, reason }, 'second recipe render failed; the first is complete');
      return { written: 'first' };
    };
  } catch (err) {
    log.warn(
      { libPath, err: err instanceof Error ? err.message : err },
      'maple_export_recipe_pair_to_files unavailable; recipes render one at a time',
    );
    return undefined;
  }
}
