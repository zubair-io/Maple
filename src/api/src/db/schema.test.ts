import { describe, test, expect } from "bun:test";
import type { AssetDoc, UploadSessionDoc, BackupSessionDoc } from "./schema.ts";

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
