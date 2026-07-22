export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

export class WhisperParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperParseError';
  }
}

interface RawSegment {
  offsets?: { from?: unknown; to?: unknown };
  text?: unknown;
}

export function parseWhisperJson(raw: string): TranscriptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WhisperParseError(
      `whisper output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WhisperParseError('whisper output is not an object');
  }
  const doc = parsed as { result?: { language?: unknown }; transcription?: unknown };
  if (!Array.isArray(doc.transcription)) {
    throw new WhisperParseError('whisper output has no transcription array');
  }
  const segments: TranscriptSegment[] = [];
  for (const segment of doc.transcription as RawSegment[]) {
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!text) continue;
    const from = Number(segment.offsets?.from ?? 0);
    const to = Number(segment.offsets?.to ?? 0);
    segments.push({
      start: Number.isFinite(from) ? from / 1000 : 0,
      end: Number.isFinite(to) ? to / 1000 : 0,
      text,
    });
  }
  return {
    text: segments.map((segment) => segment.text).join(' '),
    segments,
    language: typeof doc.result?.language === 'string' ? doc.result.language : 'en',
  };
}
