import { MongoClient } from 'mongodb';
import { loadLibraryRoots } from '../src/indexer/libraries.cache.ts';
import type { AssetDoc } from '../src/db/schema.ts';

// Re-implement the routing helpers so we get exact matches
function assetActiveFileInfo(asset: Pick<AssetDoc, 'fileinfo'>) {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  // First pass: look for a fully live entry (neither deleted nor missing)
  for (const entry of list) {
    if (!entry.deleted_at && !entry.missing_since) return entry;
  }
  // Second pass fallback: look for any active entry (not deleted, even if missing)
  for (const entry of list) {
    if (!entry.deleted_at) return entry;
  }
  return null;
}

function yearForDir(currentPath: string, capturedYear: number | null | undefined): string | null {
  const seg0 = currentPath.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CIVIC_PREFIX = /^(?:City|Town|Village)\s+of\s+/i;
function stripCivicPrefix(name: string | null): string | null {
  if (name == null) return null;
  const stripped = name.replace(CIVIC_PREFIX, '').trim();
  return stripped.length > 0 ? stripped : name;
}

function geoSegmentsFromOverride(override: any): string[] {
  const pt = override?.place_text;
  if (!pt) return [];

  const countryCode = (nonEmpty(pt.country_code) ?? '').toLowerCase();
  const isUSA = countryCode === 'us';
  const state = nonEmpty(pt.state);
  const country = nonEmpty(pt.country);

  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  const rawCity = nonEmpty(pt.city);
  const locality = stripCivicPrefix(rawCity);
  const city =
    locality === 'New York' && isUSA && state === 'New York' ? 'New York City' : locality;

  return city ? [top, city] : [top];
}

function backupLocationSegments(place: any): string[] {
  if (!place) return [];
  const countryCode = (nonEmpty(place.country_code) ?? '').toLowerCase();
  const isUSA = countryCode === 'us';
  const state = nonEmpty(place.state);
  const country = nonEmpty(place.country);

  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  const rawCity = nonEmpty(place.city ?? place.town ?? place.village ?? place.hamlet);
  const locality = stripCivicPrefix(rawCity);
  const city =
    locality === 'New York' && isUSA && state === 'New York' ? 'New York City' : locality;

  return city ? [top, city] : [top];
}

function sanitizeLocationSegments(segments: string[]): string[] {
  return segments
    .map((s) => s.replace(/[\/\\?%*:|"<>]/g, '-').trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

function geoDir(doc: any): string | null {
  const primary = assetActiveFileInfo(doc);
  if (!primary) return null;

  if (doc.is_screenshot) {
    const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
    return year ? `${year}/Screenshot` : null;
  }

  const segs = (() => {
    const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
    if (overrideSegs.length > 0) return sanitizeLocationSegments(overrideSegs);
    return sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  })();

  if (segs.length === 0) return null;
  const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
  return year ? `${year}/${segs.join('/')}` : null;
}

function isGeoCandidate(doc: any): boolean {
  const primary = assetActiveFileInfo(doc);
  if (!primary) return false;
  if (primary.filename.toLowerCase().endsWith('.mp4') || primary.filename.toLowerCase().endsWith('.mov')) {
    return false;
  }
  if (doc.is_screenshot) return true;
  const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
  if (overrideSegs.length > 0) return true;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  return segs.length > 0;
}

function wouldRelocate(doc: any): boolean {
  if (!isGeoCandidate(doc)) return false;
  const target = geoDir(doc);
  if (!target) return false;
  const primary = assetActiveFileInfo(doc);
  return primary != null && primary.path !== target;
}

async function run() {
  const mongoUrl = 'mongodb://192.168.0.244:27017';
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db('maple');
  const assets = db.collection('assets');

  const docs = await assets.find({}).toArray();

  let count = 0;
  console.log('--- Relocation Candidates in DB ---');
  for (const doc of docs) {
    const primary = assetActiveFileInfo(doc as any);
    if (wouldRelocate(doc)) {
      count++;
      const target = geoDir(doc);
      console.log(`File: ${primary?.filename}`);
      console.log(`  Current Path:      ${primary?.path}`);
      console.log(`  Target Geo Path:   ${target}`);
      console.log(`  Metadata Override:`, JSON.stringify(doc.metadata_override));
      console.log(`  Place:            `, JSON.stringify(doc.place));
      console.log('-----------------------------------');
    }
  }
  console.log(`Total Candidates: ${count}`);

  await client.close();
}

run().catch(console.error);
