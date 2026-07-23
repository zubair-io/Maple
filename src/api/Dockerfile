# Maple Self Hosted — Dockerfile
#
# Self-contained build: every artifact (the WASM image-pipeline blob, the
# Angular SPA bundle, the native libraw_ffi.so, and the Bun runtime) is
# produced inside Docker. The only thing you need on the host is Docker.
#
# Build context must be the monorepo root so the build can see src/api,
# src/web, and src/raw-pipeline.
#
# Build:
#   docker build -f src/api/Dockerfile -t maple .
#
# Run (MongoDB must be accessible at MAPLE_MONGO_URI):
#   docker run -p 3000:3000 \
#     -e MAPLE_MONGO_URI=mongodb://host.docker.internal:27017 \
#     -v /path/to/photos:/photos \
#     -e MAPLE_ROOTS=/photos \
#     -v maple_config:/app/config \
#     maple
#
# The JWT signing secret is stored in MongoDB (server_state.jwt_secret), so it
# survives container recreates and is shared across instances on its own. The
# -v maple_config:/app/config mount only persists the on-disk FALLBACK secret
# used if Mongo is unreachable at boot — keeping it stabilises that degraded
# path too.

# ---------------------------------------------------------------------------
# Stage 0: build the raw-wasm image-pipeline blob from source.
#
# raw-wasm needs nightly Rust + rust-src + the wasm32 target so wasm-pack
# can rebuild std with atomics + bulk-memory + mutable-globals (required for
# the wasm-bindgen-rayon thread pool). The toolchain pin lives in
# src/raw-pipeline/raw-wasm/rust-toolchain.toml; rustup honours it
# automatically.
# ---------------------------------------------------------------------------
FROM rust:1.83-slim AS wasm-builder

WORKDIR /build

# wasm-pack needs curl + ca-certs to fetch its release bundle; install once.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

COPY src/raw-pipeline/ raw-pipeline/

# Run the canonical build script. The fast-path stamp won't trigger on a
# fresh image; first build does the full compile, subsequent layer-cache
# rebuilds skip on identical Rust sources.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/raw-pipeline/target \
    bash raw-pipeline/raw-wasm/build.sh \
 && cp -R raw-pipeline/raw-wasm/pkg /wasm-pkg

# ---------------------------------------------------------------------------
# Stage 1: build the Angular UI bundle.
#
# Uses bun (not npm) — the workspace is a bun-locked workspace; the stale
# package-lock.json is a leftover. bun runs @angular/cli without issue.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS ui-builder

WORKDIR /build

# Install workspace deps with the lockfile so the build is reproducible.
COPY src/web/package.json src/web/bun.lock* ./
RUN bun install --frozen-lockfile

COPY src/web/ .

# Drop the WASM blob produced in stage 0 into the location the Angular
# build expects (and that the sync-raw-wasm.sh script normally writes to).
COPY --from=wasm-builder /wasm-pkg/ \
     projects/maple-common/src/lib/raw-pipeline/pkg/

# Invoke ng directly to skip the `prebuild:maple` npm-lifecycle hook, which
# tries to rebuild raw-wasm — already produced by the wasm-builder stage and
# copied in above. The path it expects (../raw-pipeline/raw-wasm/build.sh)
# also doesn't exist inside this stage, so the hook would always fail here.
#
# `--max-old-space-size=4096` raises Node's V8 heap to 4 GB during the
# Angular build. Without this, hosts with limited RAM (≤ 2 GB free) get
# OOM-killed by the kernel during esbuild minification — the symptom is
# `Killed` with no stack trace. Bun itself doesn't honour NODE_OPTIONS,
# but ng-cli spawns Node for esbuild, which does.
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN bun x ng build maple --configuration=production

# ---------------------------------------------------------------------------
# Stage 2: build the native libraw_ffi.so for the runtime image's arch.
# Stable Rust; entirely independent of the wasm-builder stage.
# ---------------------------------------------------------------------------
FROM rust:1.83-slim AS rust-builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY src/raw-pipeline/ raw-pipeline/

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/raw-pipeline/target \
    cd raw-pipeline \
 && cargo build --release -p raw-ffi \
 && cp target/release/libraw_ffi.so /libraw_ffi.so

# CPU-only speech-to-text runtime. Model weights download on first use.
FROM debian:bookworm-slim AS whisper-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG WHISPER_CPP_TAG=v1.7.4
# `-DBUILD_SHARED_LIBS=OFF` statically links libwhisper + the libggml* libs into
# the binary, so the runtime image needs only the CLI — not the whole set of
# `.so` files whisper.cpp otherwise splits them into (libwhisper.so, libggml.so,
# libggml-base.so, libggml-cpu.so). Copying just the binary from a shared build
# left it unable to load `libwhisper.so.1` at runtime. OpenMP (libgomp) is still
# linked dynamically even here, hence `libgomp1` in the runtime apt line below.
RUN git clone --depth 1 --branch "${WHISPER_CPP_TAG}" https://github.com/ggerganov/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build /src/build -j --target whisper-cli \
 && cp /src/build/bin/whisper-cli /whisper-cli

# ---------------------------------------------------------------------------
# Stage 3: runtime image — Bun server + UI bundle + native FFI.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

COPY --from=whisper-builder /whisper-cli /usr/local/bin/whisper-cli

# curl is needed for HEALTHCHECK; unzip is needed by the face worker's
# zero-config buffalo_s bootstrap (src/api/src/enrichment/face-models.ts).
#
# ffmpeg backs video poster-frame extraction (#1649, src/thumbs/video-poster.ts).
# Without it, video assets get no thumbnail, no preview, no caption and no face
# detection — the pipeline degrades cleanly (stages skip with
# `no-video-decoder`) but the feature is simply absent, so it belongs in the
# image rather than being left to the operator. It is the largest single
# addition to this layer; if image size ever becomes a constraint, a static
# ffmpeg build or a `--no-install-recommends`-trimmed variant is the lever, not
# dropping it.
#
# libgomp1 is whisper.cpp's OpenMP runtime — the statically-linked whisper-cli
# above still loads it dynamically, and the bun-slim base doesn't ship it, so
# without it every transcription fails with a `libgomp.so.1` loader error.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ffmpeg libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Bun server deps.
COPY src/api/package.json src/api/bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY src/api/src/ src/
COPY src/api/tsconfig.json ./

# Angular bundle from stage 1.
COPY --from=ui-builder /build/dist/maple/browser/ /app/ui/

# Native shared library from stage 2.
RUN mkdir -p native
COPY --from=rust-builder /libraw_ffi.so native/

ENV PORT=3000
ENV MAPLE_MONGO_URI=mongodb://localhost:27017
ENV MAPLE_MONGO_DB=maple
ENV MAPLE_UI_DIST=/app/ui
# JWT secret: the primary store is the DB (server_state.jwt_secret), which
# persists in Mongo and is shared across instances — see src/auth/jwt-secret.repo.ts.
# This path is only the FALLBACK used when Mongo is unreachable at boot. Point
# it at the persistent /app/config volume (not the ephemeral container layer)
# so even the degraded path doesn't rotate the secret on every recreate.
ENV MAPLE_JWT_SECRET_FILE=/app/config/jwt.secret

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["bun", "src/index.ts"]
