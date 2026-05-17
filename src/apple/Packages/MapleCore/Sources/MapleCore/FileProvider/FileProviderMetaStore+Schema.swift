// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore+Schema.swift
import Foundation

enum FileProviderMetaStoreSchema {
    /// Bump when the table layout changes; the store reads
    /// `PRAGMA user_version` and runs migrations to reach `current`.
    static let current: Int32 = 1

    static let createV1 = """
    CREATE TABLE IF NOT EXISTS fp_meta (
        domain          TEXT NOT NULL,
        local_basename  TEXT NOT NULL,
        asset_id        TEXT NOT NULL,
        conflict_basename TEXT,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (domain, local_basename)
    );
    """
}
