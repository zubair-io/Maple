// Native Rust recipe oracle resolves exact XMP-referenced assets independently
// of the browser, including disabled records and retained orphan companions.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: saved-export-oracle.mjs ROOT OUTPUT');
const cli = resolve(import.meta.dirname, '../../../raw-pipeline/target/release/maple-cli');
const recipe = output + '.recipe.json';
await writeFile(
  recipe,
  JSON.stringify({
    schemaVersion: 1,
    name: 'Removal browser qualification',
    format: 'png',
    quality: null,
    bitDepth: 8,
    maxLongEdge: null,
    outputProfile: 'srgb',
    renderingIntent: 'maple-display',
    metadataPolicy: 'strip',
    namingTemplate: basename(output),
    destination: 'directory',
    directory: dirname(output),
    watermark: null,
    overwritePolicy: 'replace',
  }),
);
try {
  await promisify(execFile)(cli, [
    'export-recipe',
    join(root, 'photo.dng'),
    '--params',
    join(root, 'photo.xmp'),
    '--recipe',
    recipe,
  ]);
} finally {
  await rm(recipe);
}
