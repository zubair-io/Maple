/**
 * Parse a 24-hex-char string into an ObjectId, or null for anything else.
 * Extracted in the #2897 review round — people.repo.ts, routes/people.ts,
 * and routes/presets.ts each carried an identical local copy, and a fourth
 * caller (people-list-core.ts) tipped it into a real shared util.
 */
import { ObjectId } from 'mongodb';

export function safeObjectId(raw: string): ObjectId | null {
  if (!raw || raw.length !== 24 || !/^[0-9a-f]{24}$/i.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}
