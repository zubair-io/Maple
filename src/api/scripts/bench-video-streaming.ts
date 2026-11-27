// fallow-ignore-file complexity code-duplication
/**
 * Video and motion-clip streaming benchmark: boots the real server against a throwaway library
 * holding one large video and two motion photos, then times `GET /api/video/<slug>/<file>` and
 * `GET /api/motion/<slug>/<file>` (both stream through `streamFileSlice`).
 *
 *   bun scripts/bench-video-streaming.ts [--api-root DIR] [--photos 20] [--thumbs no]
 *     [--video FILE] [--video-mb 210] [--runs 30] [--full-runs 5] [--pattern-runs 5]
 *     [--json] [--server-stderr]
 *
 * Without `--video` the script writes a constant-bitrate H.264 clip of about `--video-mb` with
 * ffmpeg. The large motion photo is a stub still followed by that same clip; the small one carries
 * a clip of a few MB, the size a phone records.
 *
 * Per target: whole-file first byte and total time, 1 MB ranges at the start / middle / end, the
 * player-like pattern of 100 sequential 2 MB ranges, the `416` for unsatisfiable ranges, and the
 * server's resident memory (sampled every 50 ms) around three full reads.
 */
import { Database } from 'bun:sqlite';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiRoot,
  bootServer,
  buildWorkspace,
  flag,
  jsonOutput,
  median,
  runs,
  SLUG,
} from './bench-library-server.ts';

const MB = 1024 * 1024;
const videoMb = Number(flag('video-mb', '210'));
const fullRuns = Number(flag('full-runs', '5'));
const patternRuns = Number(flag('pattern-runs', '5'));
const suppliedVideo = flag('video', '');

interface Target {
  label: string;
  url: string;
  size: number;
}

const stats = (values: number[]) => ({
  min: Number(Math.min(...values).toFixed(2)),
  median: Number(median(values).toFixed(2)),
  max: Number(Math.max(...values).toFixed(2)),
  n: values.length,
});

async function residentMb(pid: number): Promise<number> {
  const out = (await Bun.$`ps -o rss= -p ${pid}`.text()).trim();
  return Number(out) / 1024;
}

async function ffmpegVideo(path: string, seconds: number, megabitsPerSecond: number) {
  const rate = `${megabitsPerSecond}M`;
  const encode = Bun.spawn(
    [
      'ffmpeg',
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'],
      ...['-vf', 'noise=alls=60:allf=t', '-t', String(seconds), '-c:v', 'libx264'],
      ...['-preset', 'ultrafast', '-b:v', rate, '-minrate', rate, '-maxrate', rate],
      ...['-bufsize', `${megabitsPerSecond * 2}M`, '-x264-params', 'nal-hrd=cbr'],
      ...['-movflags', '+faststart', path],
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await encode.exited) !== 0) throw new Error(`ffmpeg failed for ${path}`);
}

async function stillThenClip(still: string, clip: string, out: string): Promise<number> {
  await Bun.write(still, new Uint8Array(1 * MB).fill(0xff));
  await Bun.$`cat ${still} ${clip} > ${out}`;
  return (await stat(still)).size;
}

async function readAll(url: string, headers: Record<string, string> = {}) {
  const started = performance.now();
  const response = await fetch(url, { headers });
  const headersMs = performance.now() - started;
  const reader = response.body!.getReader();
  const first = await reader.read();
  const firstByteMs = performance.now() - started;
  const received = first.done ? 0 : first.value.byteLength;
  const total = await (async () => {
    let bytes = received;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
    }
    return bytes;
  })();
  return {
    status: response.status,
    headersMs,
    firstByteMs,
    totalMs: performance.now() - started,
    bytes: total,
    contentRange: response.headers.get('content-range'),
  };
}

async function rangeTimings(target: Target, start: number, length: number, count: number) {
  const first: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < count; i++) {
    const sample = await readAll(target.url, {
      Range: `bytes=${start}-${start + length - 1}`,
    });
    if (sample.status !== 206 || sample.bytes !== length) {
      throw new Error(
        `range ${start}+${length} on ${target.label}: ${sample.status} ${sample.bytes}`,
      );
    }
    first.push(sample.firstByteMs);
    total.push(sample.totalMs);
  }
  return { firstByteMs: stats(first), totalMs: stats(total) };
}

async function playerPattern(target: Target, repetitions: number) {
  const step = 2 * MB;
  const requests = Math.min(100, Math.floor(target.size / step));
  const totals: number[] = [];
  const perRange: number[] = [];
  for (let run = 0; run < repetitions; run++) {
    const started = performance.now();
    for (let i = 0; i < requests; i++) {
      const rangeStarted = performance.now();
      const sample = await readAll(target.url, {
        Range: `bytes=${i * step}-${(i + 1) * step - 1}`,
      });
      if (sample.status !== 206) throw new Error(`pattern range ${i}: ${sample.status}`);
      perRange.push(performance.now() - rangeStarted);
    }
    totals.push(performance.now() - started);
  }
  return { requests, totalMs: stats(totals), perRangeMs: stats(perRange) };
}

async function unsatisfiable(target: Target) {
  const probes = [`bytes=${target.size}-`, `bytes=${target.size * 100}-`, 'bytes=5-2'];
  return Promise.all(
    probes.map(async (range) => {
      const started = performance.now();
      const response = await fetch(target.url, { headers: { Range: range } });
      await response.arrayBuffer();
      return {
        range,
        status: response.status,
        contentRange: response.headers.get('content-range'),
        ms: Number((performance.now() - started).toFixed(2)),
      };
    }),
  );
}

async function memoryAroundFullReads(target: Target, pid: number) {
  const before = await residentMb(pid);
  const samples: number[] = [];
  const timer = setInterval(() => void residentMb(pid).then((mb) => samples.push(mb)), 50);
  const totals: number[] = [];
  for (let i = 0; i < 3; i++) {
    const sample = await readAll(target.url);
    if (sample.status !== 200 || sample.bytes !== target.size) {
      throw new Error(`full read of ${target.label}: ${sample.status} ${sample.bytes}`);
    }
    totals.push(sample.totalMs);
  }
  clearInterval(timer);
  await Bun.sleep(300);
  return {
    beforeMb: Number(before.toFixed(1)),
    peakDuringMb: Number(Math.max(...samples, before).toFixed(1)),
    afterMb: Number((await residentMb(pid)).toFixed(1)),
    sampledEvery: '50 ms',
    fullReadMs: totals.map((ms) => Number(ms.toFixed(0))),
  };
}

async function measure(target: Target, pid: number) {
  const whole = { headersMs: [] as number[], firstByteMs: [] as number[], totalMs: [] as number[] };
  for (let i = 0; i < fullRuns; i++) {
    const sample = await readAll(target.url);
    if (sample.status !== 200 || sample.bytes !== target.size) {
      throw new Error(`whole read of ${target.label}: ${sample.status} ${sample.bytes}`);
    }
    whole.headersMs.push(sample.headersMs);
    whole.firstByteMs.push(sample.firstByteMs);
    whole.totalMs.push(sample.totalMs);
  }
  const mbPerSecond = target.size / MB / (median(whole.totalMs) / 1000);
  const mid = Math.floor(target.size / 2 / MB) * MB;
  const oneMb = Math.min(MB, target.size);
  return {
    label: target.label,
    sizeBytes: target.size,
    wholeFile: {
      headersMs: stats(whole.headersMs),
      firstByteMs: stats(whole.firstByteMs),
      totalMs: stats(whole.totalMs),
      medianMbPerSecond: Number(mbPerSecond.toFixed(0)),
    },
    range1Mb: {
      start: await rangeTimings(target, 0, oneMb, runs),
      middle: await rangeTimings(target, mid, oneMb, runs),
      end: await rangeTimings(target, target.size - oneMb, oneMb, runs),
    },
    playerPattern2Mb: await playerPattern(target, patternRuns),
    unsatisfiable: await unsatisfiable(target),
    memory: await memoryAroundFullReads(target, pid),
  };
}

async function main() {
  const work = await buildWorkspace();
  const videoPath = join(work.library, 'big-video.mp4');
  const motionClip = join(work.root, 'small-clip.mp4');
  try {
    if (suppliedVideo) await Bun.$`cp ${suppliedVideo} ${videoPath}`;
    else await ffmpegVideo(videoPath, Math.ceil((videoMb * 8) / 40), 40);
    await ffmpegVideo(motionClip, 3, 10);
    const videoBytes = (await stat(videoPath)).size;
    const smallClipBytes = (await stat(motionClip)).size;
    const motionFiles = [
      { name: 'IMG_00000.jpg', clip: motionClip },
      { name: 'IMG_00001.jpg', clip: videoPath },
    ];
    const recorded = await Promise.all(
      motionFiles.map(async ({ name, clip }) => {
        const still = join(work.root, `${name}.still`);
        const target = join(work.library, name);
        const start = await stillThenClip(still, clip, target);
        const clipBytes = (await stat(clip)).size;
        return { name, start, clipBytes, sourceSize: (await stat(target)).size };
      }),
    );
    const db = new Database(work.sqlitePath);
    for (const { name, start, clipBytes, sourceSize } of recorded) {
      db.run(
        `UPDATE assets SET motion_video_start = ?, motion_video_length = ?,
                motion_video_mime = 'video/mp4', motion_source_size = ?
          WHERE id = (SELECT asset_id FROM asset_locations WHERE filename = ?)`,
        [start, clipBytes, sourceSize, name],
      );
    }
    db.close();

    const server = await bootServer(work);
    try {
      const token = `token=${encodeURIComponent(server.token)}`;
      const targets: Target[] = [
        {
          label: 'video (big-video.mp4)',
          url: `${server.base}/api/video/${SLUG}/big-video.mp4?${token}`,
          size: videoBytes,
        },
        {
          label: 'motion, small clip (IMG_00000.jpg)',
          url: `${server.base}/api/motion/${SLUG}/IMG_00000.jpg?${token}`,
          size: smallClipBytes,
        },
        {
          label: 'motion, large clip (IMG_00001.jpg)',
          url: `${server.base}/api/motion/${SLUG}/IMG_00001.jpg?${token}`,
          size: videoBytes,
        },
      ];
      const results = [];
      for (const target of targets) results.push(await measure(target, server.child.pid));
      const output = { apiRoot, runs, fullRuns, patternRuns, results };
      console.log(jsonOutput ? JSON.stringify(output) : JSON.stringify(output, null, 2));
    } finally {
      server.child.kill();
      await server.child.exited;
    }
  } finally {
    await rm(work.root, { recursive: true, force: true });
  }
}

await main();
