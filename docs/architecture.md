# Maple — Architecture Overview

Maple is a non-destructive photo editor for macOS, iPadOS, and iOS built by Just Maple. It supports RAW and standard image formats, persists all edits to XMP sidecars (never touching originals), and renders through a GPU-backed Core Image pipeline.

For deep dives into specific systems, see the companion docs:

- [Image Pipeline & Editing](./pipeline.md) — decode, filter chain, two-phase rendering, editing lifecycle
- [Zoom System](./zoom.md) — retina-aware coordinate system, pinch gesture, viewport clipping
- [Caching](./caching.md) — all 5 cache layers, locations, eviction, flow diagram
- [Product Status](./product-status.md) — what's built, what's left, phase breakdown

---

## Tech Stack

| Layer                 | Technology                                 | Purpose                                                          |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **UI**                | SwiftUI                                    | Three-column shell, sliders, gestures, toolbar                   |
| **State**             | `@Observable` (Observation framework)      | `EditSession`, `UnifiedLibraryViewModel` — no Combine            |
| **Image decode**      | `CIRAWFilter` (Core Image)                 | RAW demosaic for 750+ formats (DNG, CR3, NEF, ARW...)            |
| **Image processing**  | `CIFilter` chain (Core Image)              | 11 adjustments composed as a lazy filter graph                   |
| **GPU render**        | `CIContext` backed by `MTLDevice`          | Metal-accelerated tiling for images up to 100+ MP                |
| **Sidecar**           | Custom XMP writer (`crs:` namespace)       | Adobe-compatible `.xmp` files, auto-saved on slider change       |
| **Thumbnails**        | ImageIO (`CGImageSource`)                  | Embedded JPEG extraction from RAW, disk + memory cache           |
| **Network**           | AMSMB2                                     | Direct SMB file share browsing and sidecar read/write            |
| **Photos library**    | PhotoKit (`PHAsset`, `PHImageManager`)     | Apple Photos integration                                         |
| **Filesystem**        | Security-scoped bookmarks, POSIX `opendir` | Sandboxed access to user-selected folders                        |
| **Package structure** | Swift Package Manager                      | `MapleCore` package for all non-UI code; thin SwiftUI app target |

---

## Module Boundary

```
Maple (app target)          MapleCore (SPM package)
├── Views/                        ├── Pipeline/
│   ├── AppShell.swift            │   ├── RAWDecodeEngine.swift
│   ├── BrowseMode/               │   ├── ImageEditPipeline.swift
│   │   ├── ImageGridView.swift   │   ├── EditSession.swift
│   │   └── SourceTreeView.swift  │   ├── CIFilterMapping.swift
│   ├── FullImageMode/            │   └── RenderedPreviewCache.swift
│   │   └── FullImageView.swift   ├── Export/
│   └── DetailPanel/              │   ├── ExportEngine.swift
│       └── ColorTabView.swift    │   └── ExportConfiguration.swift
└── DesignSystem/                 ├── Library/
    └── JM.swift (tokens)         │   ├── UnifiedLibraryViewModel.swift
                                  │   ├── ThumbnailLoader.swift
                                  │   └── ThumbnailDiskCache.swift
                                  ├── Sidecar/
                                  │   ├── XMPSidecarStore.swift
                                  │   └── SidecarPathResolver.swift
                                  ├── Filesystem/
                                  │   └── FilesystemSource.swift
                                  ├── SMB/
                                  │   └── SMBSource.swift
                                  └── Model/
                                      ├── AdjustmentModel.swift
                                      └── ImageAsset.swift
```

All business logic lives in `MapleCore`. The app target contains only SwiftUI views and the design system. Platform `#if` guards are confined to the view layer.

---

## Concurrency Model

| Component                 | Isolation             | Pattern                                                                                            |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `EditSession`             | `@MainActor`          | All state mutations on main thread. RAW decode offloaded via `Task.detached`.                      |
| `UnifiedLibraryViewModel` | `@MainActor`          | `loadGeneration` counter prevents stale async loads from writing into the current folder's arrays. |
| `ThumbnailLoader`         | `actor`               | Concurrency-limited (6 slots) with checked continuation waiters.                                   |
| `XMPSidecarStore`         | `actor`               | Serialized read/write access to sidecar files.                                                     |
| `FilesystemSource`        | `@unchecked Sendable` | Single-threaded access assumed (called from `@MainActor` view model).                              |
| `ImageEditPipeline`       | `@unchecked Sendable` | Thread-safe — `CIContext` is thread-safe, `CIImage` is immutable.                                  |

### Race Condition Prevention

Folder switching uses a generation counter:

```swift
loadGeneration &+= 1
let gen = loadGeneration

// ... async work ...

guard gen == loadGeneration else { return }  // stale — another folder was selected
assetSlots[index] = asset  // safe — this is still the current folder
```

Every `await` boundary in `loadAssets` and `loadPage` checks the generation before writing state. If the user clicks three folders in quick succession, only the last one's data lands in the arrays.

---

## Security-Scoped Bookmarks

Sandboxed access to user-selected folders is managed through security-scoped bookmarks:

1. **User picks a folder** — `fileImporter` returns a security-scoped URL
2. `**FilesystemSource.addFolder(url:)**` — starts scope, saves bookmark, stores URL in `scopedURLs`
3. **App launch** — `BookmarkStore.restore()` resolves bookmarks, `rootContainers()` populates `scopedURLs`, calls `markReady()`
4. **Last-folder restore** — `await filesystemSource.ensureReady()` blocks until `rootContainers()` completes, preventing EPERM on cold start
5. **Directory listing** — `findScopedParent(for: url)` walks `scopedURLs` to find the bookmarked ancestor, then `startAccessingSecurityScopedResource()` on that URL

---

## XMP Sidecar Persistence

All edits are non-destructive. `AdjustmentModel` is serialized to XMP using the `crs:` (Camera Raw Settings) namespace for Adobe compatibility, plus `papp:` for app-specific data (ratings, flags, labels).

| Asset Source                | Sidecar Location                         | Example                                                        |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| **Local filesystem**        | Sibling `.xmp` file                      | `/Photos/IMG_001.xmp` (next to `IMG_001.CR3`)                  |
| **SMB network share**       | Sibling `.xmp` file (written via AMSMB2) | `smb://server/share/IMG_001.xmp`                               |
| **Apple Photos (PhotoKit)** | App Support directory                    | `~/Library/Application Support/MapleMaple/sidecars/{UUID}.xmp` |

Sidecars are written with a 500ms debounce after each slider change. On `endEditing`, the sidecar is flushed synchronously before clearing state.
