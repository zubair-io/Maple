/**
 * `person_segmentations` — detected people and their skin mask metadata
 * for the web editor subject masks (#4284, #3300 slice 3).
 *
 * Each row holds the stage model id, the array of detected people with their
 * normalised bounding boxes, and creation timestamp. Rasters are content-addressed
 * derivatives keyed by FNV-1a digest and stored in the raster cache.
 */

export const PERSON_SEGMENTATIONS_TABLE_DDL = `
CREATE TABLE person_segmentations (
  asset_id   TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  persons    TEXT NOT NULL CHECK (json_valid(persons)),
  created_at TEXT NOT NULL
);
`;

export const PERSON_SEGMENTATIONS_INDEX_DDL = `
CREATE INDEX person_segmentations_model
  ON person_segmentations (model);
`;
