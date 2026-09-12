#!/usr/bin/env bash
# src/scripts/lensfun_reference.sh <lensfun-checkout> — builds liblensfun
# (static, no python, no tools) and regenerates
# test-fixtures/qualification/lensfun-reference.json.
#
# Only the `lensfun` target is built: the checkout's python helper package
# does not build on this Mac and is not needed. The configured header is
# written flat as <build>/lensfun.h by lensfun's CMake, so the harness is
# compiled with -I <build> and includes <lensfun.h>.
set -euo pipefail
LF="${1:?lensfun checkout}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$LF/build" && cd "$LF/build"
cmake .. -DBUILD_STATIC=ON -DBUILD_TESTS=OFF -DBUILD_LENSTOOL=OFF -DINSTALL_HELPER_SCRIPTS=OFF \
  -DINSTALL_PYTHON_MODULE=OFF -DBUILD_DOC=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build . --target lensfun -j8 >/dev/null
c++ -std=c++17 -O2 -I "$LF/build" "$ROOT/src/scripts/lensfun_reference.cpp" \
  "$LF/build/libs/lensfun/liblensfun.a" $(pkg-config --cflags --libs glib-2.0) -o "$LF/build/lensfun_reference"
mkdir -p "$ROOT/test-fixtures/qualification"
"$LF/build/lensfun_reference" "$LF/data/db" "$(git -C "$LF" rev-parse --short HEAD)" \
  | python3 -m json.tool > "$ROOT/test-fixtures/qualification/lensfun-reference.json"
echo "wrote test-fixtures/qualification/lensfun-reference.json"
