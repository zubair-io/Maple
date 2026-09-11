/**
 * CLI parser and handler for npx maple / bun x maple.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { maple } from './builder';
import { MAPLE_VERSION } from './version';
import { exportImage, exportRecipe, renderPreview, renderThumbnail } from './export';
import type { ExportColorSpace, ExportFormat } from './types';

function printHelp() {
  console.log(`
maple - Professional RAW photo development and export engine by Just Maple

USAGE:
  npx maple <command> [options]

COMMANDS:
  export <photo> [options]        Develop and export a RAW photo
  recipe <recipe.json> <photos..> Batch export photos using a saved recipe
  thumb <photo> [options]         Extract and render an optimized thumbnail or preview
  resize <image> [options]        Resize and transcode a raster image with SIMD
  inspect <image>                 Inspect dimensions, format, and EXIF metadata
  help                            Show this help message
  version                         Show Maple package version

OPTIONS FOR "export":
  -o, --out <file>                Output image destination (required)
  -x, --xmp <file>                Path to XMP sidecar containing adjustments
  -f, --format <format>           Output container format: jpeg, tiff, png, avif, webp
  -q, --quality <1-100>           JPEG/WebP compression quality (default: 92)
  -c, --color-space <space>       Output primaries / ICC: srgb, display-p3 (default: srgb)
  -m, --max-edge <pixels>         Cap long edge dimension in pixels (default: native)
  -r, --recipe <recipe.json>      Apply a saved ExportRecipe JSON
  --film-dir <dir>                Directory of .mlut film LUTs (default: resources/film-luts)

OPTIONS FOR "resize":
  -o, --out <file>                Output destination path (required)
  -w, --width <pixels>            Target width (default: 0 = preserve aspect ratio)
  -h, --height <pixels>           Target height (default: 0 = preserve aspect ratio)
  --fit <inside|fill>             Fit mode (default: inside)
  -f, --format <format>           Output container: jpeg, png, webp, avif, tiff
  -q, --quality <1-100>           Quality (default: 85)
  --rotate                        Automatically rotate according to EXIF orientation

OPTIONS FOR "thumb":
  -o, --out <file>                Output thumbnail destination (required)
  -s, --size <pixels>             Target long edge in pixels (default: 512)
  -q, --quality <1-100>           Quality (default: 55 for AVIF, 85 for JPEG)
  -f, --format <avif|jpeg>        Thumbnail codec: avif, jpeg (default: avif)

OPTIONS FOR "inspect":
  --json                          Output technical details as raw JSON

EXAMPLES:
  # Export a RAW file to a Display P3 JPEG
  npx maple export DSC_0001.NEF -o output.jpg -c display-p3 -q 95

  # Export a RAW file with XMP adjustments
  npx maple export IMG_001.CR3 -x IMG_001.xmp -o output.jpg

  # Export using a Maple recipe
  npx maple export photo.dng -r web-sharing.json -o deliverable.jpg

  # Batch export photos with a recipe into a directory
  npx maple recipe web-sharing.json ./photos/*.ARW --out-dir ./exports/

  # Generate a 512px AVIF thumbnail
  npx maple thumb photo.dng -o thumb.avif
`);
}

export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args.includes('--help') || args[0] === 'help') {
    printHelp();
    return 0;
  }

  if (args.includes('-v') || args.includes('--version') || args[0] === 'version') {
    console.log(`maple ${MAPLE_VERSION} (Maple raw-core engine)`);
    return 0;
  }

  const command = args[0];

  if (command === 'export') {
    const rawPath = args[1];
    if (!rawPath || rawPath.startsWith('-')) {
      console.error('Error: "export" requires an input photo path as the first argument.');
      return 1;
    }

    let outPath: string | null = null;
    let xmpPath: string | null = null;
    let format: ExportFormat | undefined;
    let quality: number | undefined;
    let colorSpace: ExportColorSpace | undefined;
    let maxLongEdge: number | undefined;
    let recipePath: string | null = null;
    let filmDir: string | null = null;

    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if ((arg === '-o' || arg === '--out') && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === '-x' || arg === '--xmp') && i + 1 < args.length) {
        xmpPath = args[++i];
      } else if ((arg === '-f' || arg === '--format') && i + 1 < args.length) {
        format = args[++i] as ExportFormat;
      } else if ((arg === '-q' || arg === '--quality') && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      } else if ((arg === '-c' || arg === '--color-space') && i + 1 < args.length) {
        colorSpace = args[++i] as ExportColorSpace;
      } else if ((arg === '-m' || arg === '--max-edge') && i + 1 < args.length) {
        maxLongEdge = parseInt(args[++i], 10);
      } else if ((arg === '-r' || arg === '--recipe') && i + 1 < args.length) {
        recipePath = args[++i];
      } else if (arg === '--film-dir' && i + 1 < args.length) {
        filmDir = args[++i];
      }
    }

    if (!outPath) {
      console.error('Error: Missing required argument: -o, --out <path>');
      return 1;
    }

    console.log(`Exporting ${rawPath} -> ${outPath}...`);
    const start = Date.now();

    if (recipePath) {
      const recipeContent = await fs.readFile(recipePath, 'utf-8');
      const res = await exportRecipe({
        rawPath,
        recipe: recipeContent,
        filmPath: filmDir,
        outPath,
      });

      if (!res.ok) {
        console.error(`Export failed: ${res.error}`);
        return 1;
      }
    } else {
      const res = await exportImage({
        rawPath,
        xmpPath,
        format,
        quality,
        colorSpace,
        maxLongEdge,
        outPath,
      });

      if (!res.ok) {
        console.error(`Export failed: ${res.error}`);
        return 1;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const stat = await fs.stat(outPath);
    console.log(`✓ Exported: ${outPath} (${(stat.size / 1024).toFixed(1)} KB in ${elapsed}s)`);
    return 0;
  }

  if (command === 'recipe') {
    const recipePath = args[1];
    if (!recipePath || recipePath.startsWith('-')) {
      console.error('Error: "recipe" requires a recipe JSON file as the first argument.');
      return 1;
    }

    let outDir: string | null = null;
    const photoFiles: string[] = [];

    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if ((arg === '-d' || arg === '--out-dir') && i + 1 < args.length) {
        outDir = args[++i];
      } else if (!arg.startsWith('-')) {
        photoFiles.push(arg);
      }
    }

    if (!outDir) {
      console.error('Error: Missing required argument: -d, --out-dir <dir>');
      return 1;
    }

    if (photoFiles.length === 0) {
      console.error('Error: No photo files specified for batch recipe export.');
      return 1;
    }

    const recipeContent = await fs.readFile(recipePath, 'utf-8');
    const recipe = JSON.parse(recipeContent);
    await fs.mkdir(outDir, { recursive: true });

    console.log(`Batch exporting ${photoFiles.length} photo(s) with recipe "${recipe.name}"...`);

    let succeeded = 0;
    let failed = 0;

    for (const file of photoFiles) {
      const stem = path.basename(file, path.extname(file));
      const ext = recipe.format === 'tiff' ? 'tif' : recipe.format === 'png' ? 'png' : 'jpg';
      const dest = path.join(outDir, `${stem}.${ext}`);

      process.stdout.write(`  Rendering ${stem}... `);
      const res = await exportRecipe({
        rawPath: file,
        recipe: recipeContent,
        outPath: dest,
      });

      if (res.ok) {
        console.log('✓');
        succeeded++;
      } else {
        console.log(`✗ (${res.error})`);
        failed++;
      }
    }

    console.log(`Done. ${succeeded} succeeded, ${failed} failed.`);
    return failed > 0 ? 1 : 0;
  }

  if (command === 'thumb') {
    const rawPath = args[1];
    if (!rawPath || rawPath.startsWith('-')) {
      console.error('Error: "thumb" requires an input photo path as the first argument.');
      return 1;
    }

    let outPath: string | null = null;
    let size = 512;
    let format = 'avif';
    let quality: number | undefined;

    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if ((arg === '-o' || arg === '--out') && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === '-s' || arg === '--size') && i + 1 < args.length) {
        size = parseInt(args[++i], 10);
      } else if ((arg === '-f' || arg === '--format') && i + 1 < args.length) {
        format = args[++i];
      } else if ((arg === '-q' || arg === '--quality') && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      }
    }

    if (!outPath) {
      console.error('Error: Missing required argument: -o, --out <path>');
      return 1;
    }

    if (format === 'jpeg' || format === 'jpg') {
      await renderPreview({ rawPath, outPath, maxPx: size, quality: quality ?? 85 });
    } else {
      await renderThumbnail({ rawPath, outPath, maxPx: size, quality: quality ?? 55 });
    }

    console.log(`✓ Thumbnail written: ${outPath}`);
    return 0;
  }

  if (command === 'resize') {
    const inputPath = args[1];
    if (!inputPath || inputPath.startsWith('-')) {
      console.error('Error: "resize" requires an input image path as the first argument.');
      return 1;
    }

    let outPath: string | null = null;
    let width = 0;
    let height = 0;
    let fit: 'inside' | 'fill' = 'inside';
    let format: ExportFormat | undefined;
    let quality = 85;
    let rotate = false;

    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if ((arg === '-o' || arg === '--out') && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === '-w' || arg === '--width') && i + 1 < args.length) {
        width = parseInt(args[++i], 10);
      } else if ((arg === '-h' || arg === '--height') && i + 1 < args.length) {
        height = parseInt(args[++i], 10);
      } else if (arg === '--fit' && i + 1 < args.length) {
        fit = args[++i] === 'fill' ? 'fill' : 'inside';
      } else if ((arg === '-f' || arg === '--format') && i + 1 < args.length) {
        format = args[++i] as ExportFormat;
      } else if ((arg === '-q' || arg === '--quality') && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      } else if (arg === '--rotate') {
        rotate = true;
      }
    }

    if (!outPath) {
      console.error('Error: Missing required argument: -o, --out <path>');
      return 1;
    }

    const start = Date.now();
    const builder = maple(inputPath).resize({ width, height, fit }).quality(quality);

    if (format) {
      builder.toFormat(format);
    }
    if (rotate) {
      builder.rotate();
    }

    const res = await builder.toFile(outPath);
    if (!res.ok) {
      console.error(`Resize failed: ${res.error}`);
      return 1;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const stat = await fs.stat(outPath);
    console.log(`✓ Resized: ${outPath} (${(stat.size / 1024).toFixed(1)} KB in ${elapsed}s)`);
    return 0;
  }

  if (command === 'inspect') {
    const inputPath = args[1];
    if (!inputPath || inputPath.startsWith('-')) {
      console.error('Error: "inspect" requires an image path as the first argument.');
      return 1;
    }

    const isJson = args.includes('--json');

    try {
      const meta = await maple(inputPath).metadata();
      if (isJson) {
        console.log(JSON.stringify(meta, null, 2));
      } else {
        console.log(`\nMaple Image Inspection: ${inputPath}`);
        console.log(`  Dimensions:  ${meta.width} × ${meta.height} px`);
        console.log(`  Format:      ${meta.format.toUpperCase()}`);
        console.log(`  Channels:    ${meta.channels}`);
        console.log(`  Orientation: ${meta.orientation}`);
        console.log(`  Is RAW:      ${meta.isRaw ? 'Yes' : 'No'}\n`);
      }
      return 0;
    } catch (e: any) {
      console.error(`Error inspecting ${inputPath}: ${e?.message || String(e)}`);
      return 1;
    }
  }

  console.error(`Unknown command: "${command}". Run "npx maple help" for usage.`);
  return 1;
}
