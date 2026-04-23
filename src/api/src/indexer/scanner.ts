/**
 * Folder scanner — walks a directory tree, indexes image files into MongoDB,
 * and enqueues thumbnail + EXIF tasks for each new or changed file.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ObjectId } from "mongodb";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import { registerRoot } from "../fs/root.ts";
import { enqueueTask } from "./queue.ts";

/** RAW and common image extensions supported by Maple. */
const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

/**
 * Walk `folderPath`, upsert asset records in MongoDB, and queue background
 * tasks for new/changed files.
 *
 * @param folderId  Hex string of the MongoDB folder document _id.
 * @param folderPath  Absolute path to the library folder.
 * @param onFile  Optional progress callback called with each filename.
 * @returns Number of files indexed.
 */
export async function scanFolder(
  folderId: string,
  folderPath: string,
  onFile?: (filename: string) => void
): Promise<number> {
  registerRoot(folderPath);

  const folderOid = new ObjectId(folderId);
  const assetColl = await assetsCollection();
  const folderColl = await foldersCollection();

  let count = 0;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      console.warn(`[scanner] cannot read dir "${dir}":`, (err as Error).message);
      return;
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue; // skip hidden (incl. .maple/)

      const absPath = path.join(dir, name);

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(absPath);
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) continue;

      onFile?.(name);

      const mtime = stat.mtimeMs;
      const size = stat.size;
      const now = new Date().toISOString();

      // Upsert: only update if mtime changed (file was modified).
      const existing = await assetColl.findOne({
        folder_id: folderOid,
        filename: name,
      });

      if (existing) {
        if (existing.mtime !== mtime) {
          // File changed — update record and re-queue tasks.
          await assetColl.updateOne(
            { _id: existing._id },
            { $set: { size, mtime, indexed_at: now, thumb_hash: null } }
          );
          await enqueueTask("gen_thumb", {
            asset_id: existing._id.toHexString(),
            abs_path: absPath,
          });
          await enqueueTask("extract_exif", {
            asset_id: existing._id.toHexString(),
            abs_path: absPath,
          });
        }
      } else {
        // New file — insert and queue.
        const result = await assetColl.insertOne({
          folder_id: folderOid,
          filename: name,
          abs_path: absPath,
          size,
          mtime,
          rating: 0,
          flag: 0,
          color_label: "",
          thumb_hash: null,
          indexed_at: now,
        });
        await enqueueTask("gen_thumb", {
          asset_id: result.insertedId.toHexString(),
          abs_path: absPath,
        });
        await enqueueTask("extract_exif", {
          asset_id: result.insertedId.toHexString(),
          abs_path: absPath,
        });
      }

      count++;
    }
  }

  await walk(folderPath);

  // Update folder scan metadata.
  await folderColl.updateOne(
    { _id: folderOid },
    {
      $set: {
        last_scan: new Date().toISOString(),
        file_count: count,
      },
    }
  );

  return count;
}
