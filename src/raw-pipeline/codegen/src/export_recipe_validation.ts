/** Read all declared fields without silently losing unknown or unsupported choices. */
export function parseExportRecipe(input: unknown): ExportRecipe {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Recipe must be an object');
  const record = input as Record<string, unknown>;
  const fields = Object.entries(EXPORT_RECIPE_FIELDS);
  if (Object.keys(record).length !== fields.length)
    throw new Error('Recipe has missing or unknown fields');
  for (const [field, kind] of fields) {
    const value = record[field];
    if (value === null && kind.endsWith('?')) continue;
    if (typeof value !== kind.replace('?', '')) throw new Error(`Invalid recipe ${field}`);
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 0 || value > 4294967295))
      throw new Error(`Invalid recipe ${field}`);
  }
  if (record['schemaVersion'] !== 1) throw new Error('Unsupported recipe schemaVersion');
  return structuredClone(record) as unknown as ExportRecipe;
}

/** Declared shared encoder capabilities. Naming is checked by the core filename engine. */
export function exportRecipeProblem(recipe: ExportRecipe): string | null {
  if (recipe.schemaVersion !== 1) return 'Unsupported recipe schemaVersion';
  if (!recipe.name.trim() || [...recipe.name].length > 80)
    return 'Recipe name needs 1–80 characters';
  if (!recipe.namingTemplate || new TextEncoder().encode(recipe.namingTemplate).length > 255)
    return 'Naming template must contain 1–255 bytes';
  return (
    recipeFormatProblem(recipe) ?? recipeColorProblem(recipe) ?? recipeDestinationProblem(recipe)
  );
}
function recipeFormatProblem(recipe: ExportRecipe): string | null {
  const encoder = EXPORT_ENCODERS.find((entry) => entry.format === recipe.format);
  if (!encoder) return `Unsupported format: ${recipe.format}`;
  if (recipe.bitDepth !== encoder.bitDepth)
    return `${recipe.format} requires ${encoder.bitDepth} bits`;
  if (recipe.format === 'jpeg') {
    if (recipe.quality === null || recipe.quality < 1 || recipe.quality > 100)
      return 'JPEG quality must be 1–100';
  } else if (recipe.quality !== null) return 'Lossless formats require quality: null';
  if (recipe.maxLongEdge === 0) return 'maxLongEdge must be positive or null for full resolution';
  return null;
}
function recipeColorProblem(recipe: ExportRecipe): string | null {
  if (!EXPORT_OUTPUT_PROFILES.includes(recipe.outputProfile)) return 'Unsupported outputProfile';
  if (!EXPORT_RENDERING_INTENTS.includes(recipe.renderingIntent))
    return 'Only the Maple display rendering intent is supported';
  if (!EXPORT_METADATA_POLICIES.includes(recipe.metadataPolicy))
    return 'Only stripped metadata with an embedded ICC profile is supported';
  if (recipe.watermark !== null) return 'Watermarks are not supported by this encoder';
  return null;
}
function recipeDestinationProblem(recipe: ExportRecipe): string | null {
  if (
    recipe.destination === 'download' &&
    recipe.directory === null &&
    recipe.overwritePolicy === 'browser'
  )
    return null;
  if (
    recipe.destination === 'directory' &&
    recipe.directory?.trim() &&
    ['error', 'skip', 'replace'].includes(recipe.overwritePolicy)
  )
    return null;
  return 'Choose a download with browser naming, or a directory with error, skip, or replace policy';
}

/** API/browser metadata carries ISO text. Preserve camera wall-clock digits for core EXIF naming. */
export function exportCaptureTime(value: string | null): string | null {
  if (value === null) return null;
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(
      value,
    );
  return iso ? `${iso[1]}:${iso[2]}:${iso[3]} ${iso[4]}:${iso[5]}:${iso[6]}` : value;
}
