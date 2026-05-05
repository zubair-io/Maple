# Maple Self Hosted — Dockerfile
#
# Build context must be the monorepo root so we can include both the Bun
# server and the pre-built Angular UI bundle.
#
# Build:
#   docker build -f src/api/Dockerfile -t maple .
#
# Run (MongoDB must be accessible at MAPLE_MONGO_URI):
#   docker run -p 3000:3000 \
#     -e MAPLE_MONGO_URI=mongodb://host.docker.internal:27017 \
#     -v /path/to/photos:/photos \
#     -e MAPLE_ROOTS=/photos \
#     maple

# ---------------------------------------------------------------------------
# Stage 1: build the Angular UI (skip if dist/ is already committed)
# ---------------------------------------------------------------------------
FROM node:22-slim AS ui-builder

WORKDIR /build

# Copy Angular workspace files
COPY src/web/package.json src/web/package-lock.json* ./
RUN npm ci --legacy-peer-deps

COPY src/web/ .

# Build the Maple app (uses pre-built WASM from raw-wasm)
COPY src/web/projects/maple-common/src/lib/raw-pipeline/pkg/ \
     projects/maple-common/src/lib/raw-pipeline/pkg/

RUN npx ng build maple --configuration=production

# ---------------------------------------------------------------------------
# Stage 2: build the native libraw_ffi.so for Linux x86_64
# ---------------------------------------------------------------------------
FROM rust:1.82-slim AS rust-builder

WORKDIR /build

# Install build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY src/raw-pipeline/ raw-pipeline/
COPY src/Cargo.toml src/Cargo.lock* ./

# Build only the raw-ffi crate as a shared library
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/raw-pipeline/target \
    cd raw-pipeline && \
    cargo build --release -p raw-ffi && \
    # Copy the .so to a known location outside the cache
    cp target/release/libraw_ffi.so /libraw_ffi.so

# ---------------------------------------------------------------------------
# Stage 3: runtime image
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

# Copy Bun server source
COPY src/api/package.json src/api/bun.lock* ./
RUN bun install --production

COPY src/api/src/ src/
COPY src/api/tsconfig.json ./

# Copy Angular UI bundle from stage 1
# (or use the committed dist/ if the ui-builder stage is skipped)
COPY --from=ui-builder /build/dist/maple/browser/ /app/ui/

# Copy native shared library from stage 2
RUN mkdir -p native
COPY --from=rust-builder /libraw_ffi.so native/

ENV PORT=3000
ENV MAPLE_MONGO_URI=mongodb://localhost:27017
ENV MAPLE_MONGO_DB=maple
# Point the server at the bundled UI
ENV MAPLE_UI_DIST=/app/ui

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["bun", "src/index.ts"]
