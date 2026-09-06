/** Browser verification entry: bundles the production IndexedDB store unchanged. */
import * as store from '../projects/maple-common/src/lib/export/export-recipe-store';
import { DEFAULT_EXPORT_RECIPE } from '../projects/maple-common/src/lib/generated/export-recipe.generated';
Object.assign(globalThis, { recipeStorage: { ...store, defaultRecipe: DEFAULT_EXPORT_RECIPE } });
