/**
 * A fake `maple-cli` for the pano preview tests (#4580). It answers `--help`
 * with or without the preview flags (always with `--features-engine`, so the
 * classical matcher runs without ML paths), prints `pano: progress` lines, writes
 * whichever of `--display`, `--preview-out`, `--alignment-out` and `--report` it is
 * given, and reports `reused` when handed `--alignment-in`. Every invocation's
 * arguments are appended to `<cli>.args`, one line per run.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface FakeCliOptions {
  /** Whether `--help` lists `--preview-out` and `--alignment-in`. */
  preview: boolean;
  exitCode?: number;
}

export async function writeFakePanoCli(dir: string, opts: FakeCliOptions): Promise<string> {
  const cli = path.join(
    dir,
    `fake-maple-cli-${opts.preview ? 'preview' : 'legacy'}-${opts.exitCode ?? 0}`,
  );
  const helpFlags = opts.preview
    ? '--strategy --features-engine <E> --preview-out <PNG> --alignment-in <JSON> --alignment-out <JSON>'
    : '--strategy --features-engine <E>';
  await fs.writeFile(
    cli,
    `#!/bin/sh
echo "$*" >> "$0.args"
case "$*" in *--help*) echo "Usage: maple-cli pano stitch ${helpFlags}"; exit 0;; esac
DISPLAY=""; PREVIEW=""; ALIGN_OUT=""; ALIGN_IN=""; REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --display) shift; DISPLAY="$1";;
    --preview-out) shift; PREVIEW="$1";;
    --alignment-out) shift; ALIGN_OUT="$1";;
    --alignment-in) shift; ALIGN_IN="$1";;
    --report) shift; REPORT="$1";;
  esac
  shift
done
for s in 0 1 2; do
  echo "pano: progress $s stage 0%" >&2
  echo "pano: progress $s stage 50%" >&2
  echo "pano: progress $s stage 100%" >&2
done
echo "pano: progress 5 composite 100%" >&2
if [ ${opts.exitCode ?? 0} -ne 0 ]; then echo "pano: boom" >&2; exit ${opts.exitCode ?? 0}; fi
STATUS=solved; [ -n "$ALIGN_IN" ] && STATUS=reused
[ -n "$DISPLAY" ] && echo '${TINY_PNG_B64}' | base64 -d > "$DISPLAY"
[ -n "$PREVIEW" ] && echo '${TINY_PNG_B64}' | base64 -d > "$PREVIEW"
[ -n "$ALIGN_OUT" ] && echo '{"format_version":1}' > "$ALIGN_OUT"
[ -n "$REPORT" ] && echo "{\\"width\\":2047,\\"height\\":722,\\"alignment\\":{\\"status\\":\\"$STATUS\\",\\"stale_reason\\":null},\\"timings_s\\":{\\"total\\":1.5}}" > "$REPORT"
exit 0
`,
  );
  await fs.chmod(cli, 0o755);
  return cli;
}

export async function fakeCliRuns(cli: string): Promise<string[]> {
  const text = await fs.readFile(`${cli}.args`, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.length > 0 && !line.includes('--help'));
}
