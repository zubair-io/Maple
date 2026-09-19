/**
 * Choosing a person's cover face (#3749).
 *
 * Never throws: every failure comes back as `{ error, status }` so the route
 * maps it to a response without a try/catch, which is the contract the Mongo
 * original already has. The error strings are reproduced exactly, because the
 * web client shows them verbatim.
 *
 * The bbox is read server-side from the face rather than accepted from the
 * caller. A client that could post its own crop box could point a person's
 * cover at any rectangle of any photo, including one holding somebody else.
 */

import type { ObjectId } from '../../object-id.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import type { PersonFaceRow } from './people.rows.ts';
import {
  ASSET_EXISTS_SQL,
  FACE_BY_ADDRESS_SQL,
  FACE_COUNT_ON_ASSET_SQL,
  SET_COVER_SQL,
} from './people.sql.ts';

export type SetPersonCoverResult = { ok: true } | { error: string; status: 400 | 404 };

export async function setPersonCover(
  personId: ObjectId,
  assetId: ObjectId,
  faceIndex: number,
  dbOverride?: SqliteDb,
): Promise<SetPersonCoverResult> {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    return { error: `invalid face index: ${faceIndex}`, status: 400 };
  }
  const db = peopleDb(dbOverride);
  const assetHex = assetId.toHexString();

  const [assets, faces] = await Promise.all([
    db.read<{ id: string }>(ASSET_EXISTS_SQL, [assetHex]),
    db.read<PersonFaceRow>(FACE_BY_ADDRESS_SQL, [assetHex, faceIndex]),
  ]);
  if (assets.length === 0) return { error: `asset not found: ${assetHex}`, status: 404 };

  const face = faces[0];
  if (!face) {
    // Report the asset's face count the way the Mongo version does, so the
    // message stays actionable rather than just saying the index is missing.
    const counted = await db.read<{ n: number }>(FACE_COUNT_ON_ASSET_SQL, [assetHex]);
    const total = counted[0]?.n ?? 0;
    return {
      error: `face index out of range: ${faceIndex} (asset has ${total} faces)`,
      status: 400,
    };
  }

  const personHex = personId.toHexString();
  if (face.person_id !== personHex) {
    return { error: 'face does not belong to this person', status: 400 };
  }
  if (face.hidden === 1) return { error: 'face is hidden', status: 400 };

  const written = await db.write(SET_COVER_SQL, [
    assetHex,
    face.bbox_x,
    face.bbox_y,
    face.bbox_w,
    face.bbox_h,
    new Date().toISOString(),
    personHex,
  ]);
  if (written.changes === 0) return { error: `person not found: ${personHex}`, status: 404 };
  return { ok: true };
}
