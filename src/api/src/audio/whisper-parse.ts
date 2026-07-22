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

function parseDocument(raw: string): {
  result?: { language?: unknown };
  transcription: RawSegment[];
} {
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
  return { result: doc.result, transcription: doc.transcription as RawSegment[] };
}

function parseSegment(segment: RawSegment): TranscriptSegment | null {
  const text = typeof segment.text === 'string' ? segment.text.trim() : '';
  if (!text) return null;
  const from = Number(segment.offsets?.from ?? 0);
  const to = Number(segment.offsets?.to ?? 0);
  return {
    start: Number.isFinite(from) ? from / 1000 : 0,
    end: Number.isFinite(to) ? to / 1000 : 0,
    text,
  };
}

export function parseWhisperJson(raw: string): TranscriptResult {
  const doc = parseDocument(raw);
  const segments = doc.transcription
    .map(parseSegment)
    .filter((segment): segment is TranscriptSegment => segment !== null);
  return {
    text: segments.map((segment) => segment.text).join(' '),
    segments,
    language: typeof doc.result?.language === 'string' ? doc.result.language : 'en',
  };
}
