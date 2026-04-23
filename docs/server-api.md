# Maple Server API

Bun + Elysia HTTP server. All routes under `/api/*`.

## Authentication

Every `/api/*` endpoint requires a bearer token, with these exceptions:

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/register/{begin,finish}`
- `POST /api/auth/login/{begin,finish}`
- `POST /api/auth/logout`

Supply the token as `Authorization: Bearer <jwt>`. Unauthenticated requests
to protected routes return `401 { "error": "authentication required" }`.

Tokens come from `/api/auth/register/finish` or `/api/auth/login/finish`.
JWT is HS256, signed with `JWT_SECRET`, 7-day TTL.

---

```api
openapi: 3.0.3
info:
  title: Maple Server
  description: >
    Local HTTP API for the Maple photo library. Manages registered
    source folders on disk, streams thumbnails / previews / originals,
    round-trips XMP sidecars, and gates everything behind passkey + JWT
    auth.
  version: 0.1.0

servers:
  - url: http://localhost:3000
    description: Local dev server

security:
  - BearerAuth: []

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    Error:
      type: object
      properties:
        error: { type: string }

    User:
      type: object
      properties:
        id: { type: string, description: "Mongo ObjectId as hex string" }
        display_name: { type: string }

    SourceFolder:
      type: object
      properties:
        id: { type: string }
        uuid: { type: string, format: uuid }
        name: { type: string }
        current_path: { type: string }
        available: { type: boolean }
        added_at: { type: string, format: date-time }
        stats:
          type: object
          properties:
            asset_count: { type: integer }
            indexed_count: { type: integer }
            bytes_total: { type: integer }

    FolderInfo:
      type: object
      properties:
        name: { type: string }
        path: { type: string, description: "Relative to source folder root" }
        imageCount: { type: integer }
        subfolderCount: { type: integer }

    ImageInfo:
      type: object
      properties:
        path: { type: string, description: "Relative to source folder root" }
        filename: { type: string }
        sizeBytes: { type: integer }
        modifiedAt: { type: string, format: date-time }
        hasSidecar: { type: boolean }

paths:

  # ─────────────────────── Health / readiness ───────────────────────

  /api/health:
    get:
      summary: Liveness probe + MongoDB status
      security: []
      responses:
        "200":
          description: Server is up. Mongo block reflects current connection state.
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
                  mongo:
                    type: object
                    properties:
                      state: { type: string, enum: [unconnected, connecting, connected, failed] }
                      error: { type: string, nullable: true }
                      uri: { type: string }
                      db: { type: string }

  # ───────────────────────────── Auth ─────────────────────────────

  /api/auth/status:
    get:
      summary: Auth bootstrap status
      security: []
      description: >
        Returns `first_run: true` when no users exist yet — the UI uses this
        to switch the login page into owner-registration mode.
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  users: { type: integer }
                  first_run: { type: boolean }

  /api/auth/register/begin:
    post:
      summary: Start passkey registration
      security: []
      description: >
        **Phase 1A:** only permitted when no users exist yet. Returns
        WebAuthn `PublicKeyCredentialCreationOptions` + a `session_id`
        the client must echo in `register/finish`.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [display_name]
              properties:
                display_name: { type: string, minLength: 1, maxLength: 64 }
      responses:
        "200":
          description: Challenge issued
          content:
            application/json:
              schema:
                type: object
                properties:
                  session_id: { type: string, format: uuid }
                  options:
                    type: object
                    description: WebAuthn PublicKeyCredentialCreationOptions
        "403":
          description: Registration closed (a user already exists)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "503":
          description: Database unavailable

  /api/auth/register/finish:
    post:
      summary: Complete passkey registration
      security: []
      description: >
        Verifies the attestation response, creates the user + credential,
        and returns a JWT. Also creates (or adopts) the owner's library.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [session_id, display_name, credential]
              properties:
                session_id: { type: string }
                display_name: { type: string }
                credential:
                  type: object
                  description: WebAuthn RegistrationResponseJSON
      responses:
        "200":
          description: Registered
          content:
            application/json:
              schema:
                type: object
                properties:
                  token: { type: string }
                  user: { $ref: "#/components/schemas/User" }
        "400":
          description: Challenge expired or verification failed

  /api/auth/login/begin:
    post:
      summary: Start passkey authentication
      security: []
      responses:
        "200":
          description: Challenge issued
          content:
            application/json:
              schema:
                type: object
                properties:
                  session_id: { type: string }
                  options:
                    type: object
                    description: WebAuthn PublicKeyCredentialRequestOptions

  /api/auth/login/finish:
    post:
      summary: Complete passkey authentication
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [session_id, credential]
              properties:
                session_id: { type: string }
                credential:
                  type: object
                  description: WebAuthn AuthenticationResponseJSON
      responses:
        "200":
          description: Logged in
          content:
            application/json:
              schema:
                type: object
                properties:
                  token: { type: string }
                  user: { $ref: "#/components/schemas/User" }
        "400":
          description: Unknown credential or verification failed

  /api/auth/me:
    get:
      summary: Current user from bearer token
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  user: { $ref: "#/components/schemas/User" }
        "401":
          description: Missing or invalid token

  /api/auth/logout:
    post:
      summary: No-op; client drops its stored token
      security: []
      responses:
        "200":
          description: OK

  # ──────────────────────── Source folders ───────────────────────
  # These are the user-registered disk roots. Every filesystem route
  # below takes a `source_folder_id` referring to one of these.

  /api/source-folders:
    get:
      summary: List registered source folders
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  source_folders:
                    type: array
                    items: { $ref: "#/components/schemas/SourceFolder" }
        "503":
          description: Database unavailable
    post:
      summary: Register a new source folder
      description: >
        Validates the path (must be absolute, exist, be a readable
        directory), inserts the source folder doc, and writes a
        `.maple/source.json` marker inside the folder (best-effort;
        read-only mounts skip the marker silently).
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [path]
              properties:
                path: { type: string, description: "Absolute path on the server host" }
                name: { type: string, description: "Display name. Defaults to basename." }
      responses:
        "200":
          description: Registered (or already existed)
          content:
            application/json:
              schema:
                type: object
                properties:
                  source_folder: { $ref: "#/components/schemas/SourceFolder" }
                  created: { type: boolean }
        "400":
          description: Path invalid (not absolute, not a directory, not readable)

  /api/source-folders/preview:
    post:
      summary: Dry-run path validation for the add-folder UI
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [path]
              properties:
                path: { type: string }
      responses:
        "200":
          description: Validation result
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
                  absolute_path: { type: string }
                  already_registered: { type: boolean }
                  existing_source_folder_id:
                    type: string
                    nullable: true

  /api/source-folders/{id}:
    delete:
      summary: Unregister a source folder
      description: >
        Removes the `source_folders` doc and any cached `assets` rows. The
        originals on disk are never touched.
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Removed
        "404":
          description: Not found

  # ─────────────────────── Tree navigation ───────────────────────

  /api/folders:
    get:
      summary: List direct subfolders of a path inside a source folder
      description: >
        Non-recursive. Each folder carries cheap child counts used for the
        tree UI ("N photos" badge). Returns **503** if the source-folder
        mount is stuck (e.g., stale SMB) so handlers never hang forever.
      parameters:
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
        - in: query
          name: path
          schema: { type: string, default: "" }
          description: Relative to the source folder root. Empty = root.
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  source_folder_id: { type: string }
                  path: { type: string }
                  folders:
                    type: array
                    items: { $ref: "#/components/schemas/FolderInfo" }
        "404":
          description: Path not found or escapes the source root
        "503":
          description: Source folder unresponsive (mount may be stale)

  /api/images:
    get:
      summary: List image files
      description: >
        Non-recursive by default (lists direct children of `folder`). Set
        `recursive=true` to walk the subtree; omit `folder` entirely to
        walk the whole source folder.
      parameters:
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
        - in: query
          name: folder
          schema: { type: string }
        - in: query
          name: recursive
          schema: { type: boolean, default: false }
        - in: query
          name: offset
          schema: { type: integer, default: 0 }
        - in: query
          name: limit
          schema: { type: integer, default: 100 }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  source_folder_id: { type: string }
                  folder: { type: string }
                  total: { type: integer }
                  offset: { type: integer }
                  limit: { type: integer }
                  images:
                    type: array
                    items: { $ref: "#/components/schemas/ImageInfo" }
        "404":
          description: Folder not found or escapes the source root
        "503":
          description: Source folder unresponsive

  # ─────────────────────── Image bytes ───────────────────────

  /api/thumbnails/{path}:
    get:
      summary: Thumbnail (560px long edge, JPEG)
      description: >
        Generated on first request via `sharp` and cached in
        `<folder>/.maple/thumbs/<filename>.jpg` alongside the original.
        Cache is invalidated on mtime change.
      parameters:
        - in: path
          name: path
          required: true
          schema: { type: string }
          description: >
            Relative to the source folder root. Percent-encode spaces
            and non-ASCII per segment; slashes stay literal.
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: JPEG bytes
          content:
            image/jpeg:
              schema: { type: string, format: binary }
        "404":
          description: Source file missing or thumbnail generation failed

  /api/preview/{path}:
    get:
      summary: Preview render (2048px long edge, JPEG)
      description: >
        Like `/thumbnails` but at 2048px. Cached in
        `<folder>/.maple/previews/`.
      parameters:
        - in: path
          name: path
          required: true
          schema: { type: string }
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: JPEG bytes
          content:
            image/jpeg:
              schema: { type: string, format: binary }
        "404":
          description: Source file missing or preview generation failed

  /api/originals/{path}:
    get:
      summary: Stream the untouched original file
      description: >
        Used by the web editor to fetch the DNG/RAW bytes for client-side
        WASM decoding. Returns the raw bytes with whatever Content-Type
        `Bun.file` infers.
      parameters:
        - in: path
          name: path
          required: true
          schema: { type: string }
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: File bytes
          content:
            application/octet-stream:
              schema: { type: string, format: binary }
        "404":
          description: File not found

  # ────────────────────────── Sidecars ──────────────────────────

  /api/sidecars/{path}:
    get:
      summary: Read the XMP sidecar for an image
      description: >
        Sidecars live as siblings of the original: `IMG_001.DNG` →
        `IMG_001.xmp`. Returns **204** (empty body) when no sidecar
        exists yet so clients don't treat it as an error.
      parameters:
        - in: path
          name: path
          required: true
          schema: { type: string }
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: XMP document
          content:
            application/rdf+xml:
              schema: { type: string }
        "204":
          description: No sidecar exists yet
        "404":
          description: Source folder unknown
    put:
      summary: Write the XMP sidecar for an image
      description: >
        Body is raw RDF/XML (Content-Type `application/rdf+xml`). Server
        parses as text — do not send JSON.
      parameters:
        - in: path
          name: path
          required: true
          schema: { type: string }
        - in: query
          name: source_folder_id
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/rdf+xml:
            schema: { type: string }
      responses:
        "200":
          description: Written
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
        "404":
          description: Source folder unknown
```

## Notes

- **URL-encoding:** the path-parameter endpoints (`thumbnails`, `preview`,
  `originals`, `sidecars`) percent-decode each path segment server-side, so
  filenames containing spaces or non-ASCII characters must be
  `encodeURIComponent`'d per-segment on the client (slashes stay literal).
- **SMB-stuck-mount defense:** `folders` and `images` wrap their filesystem
  work in a timeout (`withFsTimeout`, 8 s for listings, 60 s for recursive
  walks). A stale mount surfaces as **503** instead of hanging the handler.
- **Caches:** thumbnails and previews are stored next to the originals under
  `.maple/thumbs` and `.maple/previews`, keyed by filename + mtime. Removing
  a source folder doesn't prune these — they're write-through caches, not
  canonical state.
