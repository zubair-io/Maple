/** A one-second audio-only QuickTime file — the shape of a P2 card's
 * `CONTENTS/AUDIO/*.MXF` (#5513), in a container every ffmpeg can mux. Null
 * when this host's ffmpeg cannot write it; callers treat that as no ffmpeg. */
export async function audioOnlyVideo(ffmpeg: string, out: string): Promise<string | null> {
  const proc = Bun.spawn(
    [
      ffmpeg,
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:a',
      'aac',
      '-y',
      out,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  return (await proc.exited) === 0 ? out : null;
}
