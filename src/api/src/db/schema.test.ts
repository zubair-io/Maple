import { describe, test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type {
  AssetDoc,
  FileInfo,
  UploadSessionDoc,
  BackupSessionDoc,
} from "./schema.ts";

describe("PhotoKit backup schema additions", () => {
  test("AssetDoc accepts phasset_links, deleted_from_photos, apple_rendered_path", () => {
    const doc: AssetDoc = {
      folder_id: {} as any,
      filename: "IMG.heic",
      abs_path: "/Photos/2024/Tokyo/03-15/IMG.heic",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      phasset_links: [
        { device_id: "uuid-1", phasset_local_id: "ABC/L0/001", first_seen: new Date() },
      ],
      deleted_from_photos: false,
      apple_rendered_path: "Photos/2024/Tokyo/03-15/IMG.rendered.jpg",
    };
    expect(doc.phasset_links?.length).toBe(1);
  });

  test("phasset_links accepts optional phasset_cloud_id for cross-device join", () => {
    const doc: AssetDoc = {
      folder_id: {} as any,
      filename: "IMG.heic",
      abs_path: "/Photos/2024/Tokyo/03-15/IMG.heic",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      phasset_links: [
        // First entry has a cloud id (iCloud Photos enabled on the device).
        {
          device_id: "device-A",
          phasset_local_id: "ABC/L0/001",
          phasset_cloud_id: "icloud-XYZ",
          first_seen: new Date(),
        },
        // Second entry omits it (iCloud off, local-only library).
        {
          device_id: "device-B",
          phasset_local_id: "DEF/L0/002",
          first_seen: new Date(),
        },
      ],
    };
    expect(doc.phasset_links?.length).toBe(2);
    expect(doc.phasset_links?.[0]!.phasset_cloud_id).toBe("icloud-XYZ");
    expect(doc.phasset_links?.[1]!.phasset_cloud_id).toBeUndefined();
  });

  test("UploadSessionDoc carries the resume key fields", () => {
    const s: UploadSessionDoc = {
      _id: {} as any,
      library_id: {} as any,
      device_id: "uuid-1",
      phasset_local_id: "ABC/L0/001",
      total_bytes: 1024,
      received_bytes: 0,
      chunk_size: 256 * 1024,
      created_at: new Date(),
      updated_at: new Date(),
      state: "open",
      target_rel_path: "2024/Tokyo/03-15/IMG.heic",
    };
    expect(s.state).toBe("open");
  });

  test("BackupSessionDoc summarises per-device progress", () => {
    const b: BackupSessionDoc = {
      _id: {} as any,
      library_id: {} as any,
      device_id: "uuid-1",
      started_at: new Date(),
      last_progress_at: new Date(),
      total_count: 100,
      uploaded_count: 1,
      failed_count: 0,
    };
    expect(b.uploaded_count).toBe(1);
  });
});

describe("FileInfo (content-addressed assets)", () => {
  test("matches the canonical shape: path, filename, library_id", () => {
    const libId = new ObjectId();
    const fi: FileInfo = {
      path: "vacation/2024",
      filename: "IMG_001.dng",
      library_id: libId,
    };
    expect(fi.path).toBe("vacation/2024");
    expect(fi.filename).toBe("IMG_001.dng");
    expect(fi.library_id.equals(libId)).toBe(true);
  });

  test("path of '' represents a file at the library root", () => {
    const fi: FileInfo = {
      path: "",
      filename: "root.dng",
      library_id: new ObjectId(),
    };
    expect(fi.path).toBe("");
  });

  test("deleted_at marker is optional and ISO-string", () => {
    const fi: FileInfo = {
      path: "x",
      filename: "y.dng",
      library_id: new ObjectId(),
      deleted_at: "2026-05-20T00:00:00Z",
    };
    expect(fi.deleted_at).toBe("2026-05-20T00:00:00Z");
  });

  test("attaches to AssetDoc as an array", () => {
    const libId = new ObjectId();
    const doc: AssetDoc = {
      folder_id: libId,
      filename: "IMG_001.dng",
      abs_path: "/lib/vacation/2024/IMG_001.dng",
      fileinfo: [
        { path: "vacation/2024", filename: "IMG_001.dng", library_id: libId },
      ],
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-20T00:00:00Z",
    };
    expect(Array.isArray(doc.fileinfo)).toBe(true);
    expect(doc.fileinfo).toHaveLength(1);
  });
});
