import {
  saveRecipe,
  savedRecipes,
} from '../../projects/maple-common/src/lib/export/export-recipe-store';
import {
  parseExportRecipe,
  exportRecipeProblem,
} from '../../projects/maple-common/src/lib/generated/export-recipe.generated';

/** Thin test transport over actual production IndexedDB and admission (#4207). */
Reflect.set(window, 'recipeInterchange', {
  save: (value: unknown) => saveRecipe(value),
  list: () => savedRecipes(),
  parse: (value: unknown) => parseExportRecipe(value),
  admission: (value: unknown) => exportRecipeProblem(parseExportRecipe(value)),
});
