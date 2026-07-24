/**
 * Test-only fixture for `child-process-worker.test.ts` (#899). Stands in for
 * a native abort (Rust `panic=abort`, onnxruntime `terminate`, `bad_alloc`,
 * a Bun crash report): writes a distinctive marker to stderr, then exits
 * non-zero WITHOUT going through any graceful shutdown path — exactly the
 * shape of crash the stderr-tee + ring buffer in `child-process-worker.ts`
 * exists to capture.
 */
process.stderr.write('PANIC: simulated native abort — marker-899-stderr-tail\n');
process.exit(7);
