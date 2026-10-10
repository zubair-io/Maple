import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sqliteDatabasePath } from '../db/sqlite/database-path.ts';
import { defaultModelDir } from '../enrichment/face-models.ts';
import type { SearchChildConfig } from './search-protocol.ts';

const MAX_QUERY_THREADS = 8;

const ORT_LIBRARY_BY_PLATFORM: Readonly<Record<string, string>> = {
  darwin: 'libonnxruntime.1.dylib',
  linux: 'libonnxruntime.so.1',
  win32: 'onnxruntime.dll',
};

/**
 * The ONNX Runtime the query embedder loads: none when `ORT_DYLIB_PATH` is set (the production
 * image sets it and the crate reads it itself), otherwise the copy onnxruntime-node ships, which
 * the face pipeline already depends on.
 */
export function bundledOrtDylibPath(): string | undefined {
  if (process.env.ORT_DYLIB_PATH) return undefined;
  const library = ORT_LIBRARY_BY_PLATFORM[process.platform];
  if (!library) return undefined;
  const packageDir = dirname(require.resolve('onnxruntime-node/package.json'));
  return join(packageDir, 'bin', 'napi-v6', process.platform, process.arch, library);
}

/**
 * Half the cores, at most eight: measured at 12.6 ms per query embedding with eight threads
 * (#4462), and the decode and face children share the box.
 */
function queryThreads(): number {
  return Math.max(1, Math.min(MAX_QUERY_THREADS, Math.floor(availableParallelism() / 2)));
}

/** Everything the child needs to open: the index beside the library database, the model cache
 * beside the face models. */
export function searchChildConfig(): SearchChildConfig {
  const dbPath = sqliteDatabasePath();
  const root = join(dirname(resolve(dbPath)), '.maple', 'search');
  const ortDylibPath = bundledOrtDylibPath();
  return {
    dbPath,
    stateFile: join(root, 'state.json'),
    engine: {
      index_dir: join(root, 'text'),
      embedder: {
        model_cache_dir: join(defaultModelDir(), 'fastembed'),
        ...(ortDylibPath ? { ort_dylib_path: ortDylibPath } : {}),
        intra_threads: queryThreads(),
      },
    },
  };
}
