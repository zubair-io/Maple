# Editor layout fixture

`rgb-gradient.png` is a generated 512 × 384 RGB image for layout, edit, zoom, undo, and crop interaction tests. It contains no camera data: `R = floor(x × 255 / 511)`, `G = floor(y × 255 / 383)`, and `B = 64`. Rows use PNG filter 0 with lossless zlib compression.

Apple ImageIO reads its native extent, allowing the same live canvas and editor controls to run in clean checkouts. Camera RAW rendering remains covered by the separate RAW harness and real-photo interaction checks.
