/**
 * Stage child entry shim.
 *
 * The supervisor spawns each stage child as:
 *   bun run src/api/src/workers/runtime/main.ts <stageName>
 *
 * This shim resolves the stage name to a module under ../stages/<name>.ts,
 * imports its default export (a StageConfig produced by defineStage), and
 * calls runStage. The dynamic import keeps each child's module graph minimal:
 * face loads ONNX, OCR loads its engine, but hash/exif load neither.
 */

import { runStage } from "./run-stage.ts";
import type { StageConfig } from "./define-stage.ts";

export async function loadStage(name: string): Promise<StageConfig> {
  // Validate: name must be a safe identifier (alphanumeric + dash/underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid stage name: ${JSON.stringify(name)}`);
  }
  try {
    const mod = await import(`../stages/${name}.ts`);
    if (!mod.default || typeof mod.default.handler !== "function") {
      throw new Error(
        `Module ../stages/${name}.ts does not export a valid StageConfig as default`,
      );
    }
    return mod.default as StageConfig;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Cannot find module") ||
        err.message.includes("Module not found"))
    ) {
      throw new Error(
        `Unknown stage: ${JSON.stringify(name)}. ` +
          `Expected a file at src/api/src/workers/stages/${name}.ts`,
      );
    }
    throw err;
  }
}

// Only execute when run directly as a child process, not when imported by tests.
if (import.meta.main) {
  const stageName = process.argv[2];
  if (!stageName) {
    process.stderr.write("Usage: bun run main.ts <stageName>\n");
    process.exit(1);
  }
  const stage = await loadStage(stageName);
  await runStage(stage);
}
