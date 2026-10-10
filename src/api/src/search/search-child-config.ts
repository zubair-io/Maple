import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sqliteDatabasePath } from '../db/sqlite/database-path.ts';
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

/** `.maple/` beside the library database — the data volume in the production container. */
function dataDir(): string {
  return join(dirname(resolve(sqliteDatabasePath())), '.maple');
}

/**
 * Where bge-m3 (~2.2 GB) is downloaded on first use: beside the database, so it survives a
 * container rebuild, unless `MAPLE_MODEL_DIR` (which the face and whisper models honour) names
 * a model directory.
 */
export function searchModelCacheDir(): string {
  const override = process.env.MAPLE_MODEL_DIR;
  return override ? join(override, 'fastembed') : join(dataDir(), 'models', 'fastembed');
}

/** Everything the child needs to open: the keyword index and the model cache beside the
 * library database. */
export function searchChildConfig(): SearchChildConfig {
  const dbPath = sqliteDatabasePath();
  const root = join(dataDir(), 'search');
  const ortDylibPath = bundledOrtDylibPath();
  return {
    dbPath,
    stateFile: join(root, 'state.json'),
    engine: {
      index_dir: join(root, 'text'),
      embedder: {
        model_cache_dir: searchModelCacheDir(),
        ...(ortDylibPath ? { ort_dylib_path: ortDylibPath } : {}),
        intra_threads: queryThreads(),
      },
    },
  };
}
