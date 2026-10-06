"""Execute the shipping WASM SIMD helper against its exact scalar oracle."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
STAGES = ROOT / "src/raw-pipeline/raw-core/src/stages"
SCALAR_SHA = "45c34f8b043ec616757532e60075696032233e9ac5e243d5439bcf5a33763043"


def run():
    source = (STAGES / "nlm.rs").read_text()
    signature = "fn fast_neg_exp(x: f32) -> f32 {"
    assert source.count(signature) == 1, "Scalar oracle signature changed"
    start = source.index(signature)
    end = source.index("\n}\n", start) + 2
    scalar = source[start:end]
    # An intentional oracle change must review/update this seal, not silently
    # make a handwritten approximation the reference for the vector path.
    assert hashlib.sha256(scalar.encode()).hexdigest() == SCALAR_SHA
    constants = "const FAST_EXP_RANGE: f32 = 8.0;\nconst FAST_EXP_TABLE_SIZE: usize = 512;"
    assert all(line in source for line in constants.splitlines())
    assert '+simd128' in (ROOT / "src/raw-pipeline/raw-wasm/.cargo/config.toml").read_text()
    wrapper = constants + "\n" + scalar + "\n"
    wrapper += f'#[path={json.dumps(str(STAGES / "nlm_exp_table.rs"))}] mod table;\n'
    wrapper += "fn fast_exp_table() -> &'static [f32; 513] { &table::VALUES }\n"
    wrapper += f'#[path={json.dumps(str(STAGES / "nlm_accumulate.rs"))}] mod actual;\n'
    wrapper += (ROOT / "tools/fixtures/nlm_simd_witness.rs").read_text()
    with tempfile.TemporaryDirectory(prefix="maple-nlm-simd-") as directory:
        path = Path(directory)
        rust = path / "witness.rs"
        wasm = path / "witness.wasm"
        rust.write_text(wrapper)
        # Direct rustc intentionally excludes all shipping exports, Cargo cache,
        # and platform bindings; #[path] compiles the real helper and LUT.
        env = dict(os.environ)
        env.pop("RUSTFLAGS", None)
        subprocess.run([
            "rustc", "--edition=2021", "--crate-type=cdylib",
            "--target=wasm32-unknown-unknown", "-C", "target-feature=+simd128",
            "-C", "opt-level=3", str(rust), "-o", str(wasm),
        ], check=True, env=env)
        javascript = r"""
const fs = require('node:fs');
(async () => {
  const bytes = fs.readFileSync(process.argv[1]);
  if (!WebAssembly.validate(bytes)) throw new Error('Invalid WASM artifact');
  const {instance} = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const rc = e.run();
  const result = {rc, checks:e.checks(), failure:Array.from({length:5},(_,i)=>e.failure(i))};
  if (rc !== 0 || result.checks !== 630042) throw new Error(JSON.stringify(result));
  for (let field=0; field<4; field++) {
    const fresh = await WebAssembly.instantiate(bytes, {});
    let trapped = false;
    try { fresh.instance.exports.mismatched_length(field); }
    catch (error) { if (!(error instanceof WebAssembly.RuntimeError)) throw error; trapped = true; }
    if (!trapped) throw new Error('Missing length assertion '+field);
  }
  console.log(JSON.stringify({...result, lengthAssertions:4}));
})().catch(error => { console.error(error); process.exitCode=1; });
"""
        subprocess.run(["node", "-e", javascript, str(wasm)], check=True)
        print(json.dumps({
            "scalarSourceSha256": SCALAR_SHA,
            "helperSha256": hashlib.sha256((STAGES / "nlm_accumulate.rs").read_bytes()).hexdigest(),
            "tableSha256": hashlib.sha256((STAGES / "nlm_exp_table.rs").read_bytes()).hexdigest(),
            "wasmSha256": hashlib.sha256(wasm.read_bytes()).hexdigest(),
        }))


if __name__ == "__main__":
    run()
