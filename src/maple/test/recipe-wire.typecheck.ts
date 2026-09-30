// Compiled by tsconfig.test.json. An unused @ts-expect-error fails CI if a
// future type change accidentally permits a Rust-rejected recipe (#3553).
import { createBuilderState } from '../src/builder-state';
import type { RecipeOp, RecipeOutput } from '../src/recipe';

const state = createBuilderState(new Uint8Array([1]));
state.ops.push({ op: 'resize', withoutEnlargement: true });
state.ops.push({ op: 'blur', sigma: null });
state.ops.push({ op: 'convolve', width: 1, height: 1, kernel: [1] });
state.ops.push({ op: 'composite', layers: [{ aux: { off: 0, len: 4 }, raw: null }] });
state.output = { format: 'jpeg', chromaSubsampling: '4:2:0' };
state.output = { format: 'raw' };

// @ts-expect-error Unknown operation names are rejected.
state.ops.push({ op: 'reszie', width: 12 });
// @ts-expect-error Rust rejects unknown operation fields.
state.ops.push({ op: 'resize', widht: 12 });
// @ts-expect-error Gamma requires the wire exponent, not the public argument name.
state.ops.push({ op: 'gamma', gamma: 2.2 });
// @ts-expect-error Extract's height is required by serde.
state.ops.push({ op: 'extract', left: 0, top: 0, width: 1 });
// @ts-expect-error Rust's rename_all expects camelCase fields here.
state.ops.push({ op: 'extend', extend_with: 'background' });
// @ts-expect-error RGB tuples must contain exactly three channels.
state.ops.push({ op: 'tint', rgb: [1, 2] });
// @ts-expect-error RGBA tuples must contain exactly four channels.
state.ops.push({ op: 'flatten', background: [1, 2, 3] });
// @ts-expect-error Filter newtype fields are checked too.
state.ops.push({ op: 'blur', precision: 'float' });
// @ts-expect-error Convolution requires a kernel.
state.ops.push({ op: 'convolve', width: 1, height: 1 });
// @ts-expect-error Unknown composite layer fields are rejected.
state.ops.push({ op: 'composite', layers: [{ aux: { off: 0, len: 4 }, opacity: 0.5 }] });
state.ops.push({
  op: 'composite',
  // @ts-expect-error Raw layer dimensions require a channel count.
  layers: [{ aux: { off: 0, len: 4 }, raw: { width: 1, height: 1 } }],
});
// @ts-expect-error Auxiliary byte references require their length.
state.ops.push({ op: 'composite', layers: [{ aux: { off: 0 } }] });
// @ts-expect-error A PNG setting cannot be emitted for JPEG.
state.output = { format: 'jpeg', compressionLevel: 6 };
// @ts-expect-error RAW has no encoder options.
state.output = { format: 'raw', quality: 90 };
// @ts-expect-error Output container names must match Rust.
state.output = { format: 'jpg' };

// Accessors must narrow the union before using variant-specific fields.
function dimensions(op: RecipeOp): number | undefined {
  // @ts-expect-error Not every operation has a width.
  void op.width;
  return op.op === 'resize' ? op.width : undefined;
}
function quality(output: RecipeOutput): number | undefined {
  // @ts-expect-error Not every output supports quality.
  void output.quality;
  return output.format === 'jpeg' || output.format === 'avif' ? output.quality : undefined;
}
void dimensions;
void quality;
