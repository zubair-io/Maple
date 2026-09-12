/*
 * vips-percent-probe.c
 *
 * Calls real libvips' own `vips_percent` (plus the `vips_hist_find` ->
 * `vips_hist_cum` -> `vips_hist_norm` chain it is built from) through its C
 * entry points, linked against the exact libvips-cpp dylib that sharp
 * bundles. It exists to pin, against the real library rather than a
 * reimplementation, the 23 `(percent, threshold)` reference pairs asserted
 * by `vips_percent_matches_libvips_on_a_uniform_histogram` and
 * `vips_percent_matches_libvips_on_a_skewed_histogram` in
 * `src/raw-pipeline/raw-core/src/raster_colour_lab_tests.rs` (the libvips
 * side of `normalise()`'s parity fix, PR-D / #3503, fix wave C3).
 *
 * Input is a raw little-endian float32 file (one band, N x 1 image) — the
 * probe reads it, reports the true min/max (and their truncation, which is
 * what `vips_hist_find` actually buckets on), then prints the threshold
 * `vips_percent` returns for each percentile given on the command line,
 * followed by the raw histogram / cumulative / normalised-cumulative
 * buffers so the whole chain can be inspected, not just the final answer.
 *
 * Build (macOS, from repo root, after `cd src/api && bun install` so
 * @img/sharp-libvips-darwin-arm64 is present):
 *
 *   SHARP_LIBVIPS=src/api/node_modules/@img/sharp-libvips-darwin-arm64/lib
 *   clang -O2 -o /tmp/vips-percent-probe src/scripts/parity/vips-percent-probe.c \
 *     "$SHARP_LIBVIPS"/libvips-cpp.*.dylib \
 *     -Wl,-rpath,"$(cd "$SHARP_LIBVIPS" && pwd)"
 *
 * (Swap `@img/sharp-libvips-darwin-arm64` for whichever platform package
 * `bun install` resolved on your machine/CI runner. The package ships the
 * versioned dylib only — `libvips-cpp.8.17.3.dylib`, no unversioned
 * symlink — so link the file directly rather than via `-lvips-cpp`.)
 *
 * Run, e.g. against a 101-sample ramp at every decile:
 *
 *   python3 -c "
 *   import struct
 *   vals = [b + 0.5 for b in range(101)]
 *   open('/tmp/ramp101.f32','wb').write(struct.pack('<101f', *vals))
 *   "
 *   /tmp/vips-percent-probe /tmp/ramp101.f32 0 1 2 5 10 25 50 75 90 95 99 100
 *
 * which reproduces the pairs in
 * `vips_percent_matches_libvips_on_a_uniform_histogram`. Swap the input
 * file and percentile list to reproduce
 * `vips_percent_matches_libvips_on_a_skewed_histogram`'s 80-near-black /
 * 20-spread distribution instead.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct _VipsImage VipsImage;
int vips_init(const char *argv0);
VipsImage *vips_image_new_from_memory(const void *data, size_t size, int w, int h, int bands, int format);
int vips_percent(VipsImage *in, double percent, int *threshold, ...);
int vips_min(VipsImage *in, double *out, ...);
int vips_max(VipsImage *in, double *out, ...);
int vips_hist_find(VipsImage *in, VipsImage **out, ...);
int vips_hist_cum(VipsImage *in, VipsImage **out, ...);
int vips_hist_norm(VipsImage *in, VipsImage **out, ...);
void *vips_image_write_to_memory(VipsImage *in, size_t *size);
char *vips_error_buffer(void);

#define VIPS_FORMAT_FLOAT 6

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <raw-f32-samples-file> [percent ...]\n", argv[0]);
    return 1;
  }
  if (vips_init(argv[0])) { fprintf(stderr, "vips_init failed\n"); return 1; }
  FILE *f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "open %s failed\n", argv[1]); return 1; }
  fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
  float *data = malloc(sz);
  if (fread(data, 1, sz, f) != (size_t) sz) { fprintf(stderr, "read failed\n"); return 1; }
  fclose(f);
  int n = sz / 4;
  VipsImage *im = vips_image_new_from_memory(data, sz, n, 1, 1, VIPS_FORMAT_FLOAT);
  if (!im) { fprintf(stderr, "new_from_memory: %s\n", vips_error_buffer()); return 1; }
  double mn, mx;
  if (vips_min(im, &mn, NULL) || vips_max(im, &mx, NULL)) { fprintf(stderr, "minmax: %s\n", vips_error_buffer()); return 1; }
  printf("n=%d min=%.9f max=%.9f trunc(min)=%d trunc(max)=%d\n", n, mn, mx, (int) mn, (int) mx);
  for (int i = 2; i < argc; i++) {
    double p = atof(argv[i]);
    int t = -12345;
    if (vips_percent(im, p, &t, NULL)) { printf("percent %g -> ERROR %s\n", p, vips_error_buffer()); continue; }
    printf("percent %g -> %d\n", p, t);
  }
  VipsImage *h = NULL, *c = NULL, *nm = NULL;
  if (vips_hist_find(im, &h, NULL) || vips_hist_cum(h, &c, NULL) || vips_hist_norm(c, &nm, NULL)) {
    fprintf(stderr, "hist chain: %s\n", vips_error_buffer()); return 1;
  }
  size_t hs = 0, cs = 0, ns = 0;
  unsigned int *hp = vips_image_write_to_memory(h, &hs);
  unsigned int *cp = vips_image_write_to_memory(c, &cs);
  unsigned int *np = vips_image_write_to_memory(nm, &ns);
  printf("hist bytes=%zu cum bytes=%zu norm bytes=%zu\n", hs, cs, ns);
  printf("HIST:");
  for (int i = 0; i < (int) (hs / 4); i++) if (hp[i]) printf(" %d:%u", i, hp[i]);
  printf("\nCUM:");
  for (int i = 0; i < (int) (cs / 4); i++) printf(" %u", cp[i]);
  printf("\nNORM:");
  for (int i = 0; i < (int) (ns / 4); i++) printf(" %u", np[i]);
  printf("\n");
  return 0;
}
