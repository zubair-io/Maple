"""#3941: one-shot phase ownership experiment; no native pixel approximations.

Run resident and release in separate fresh processes with identical probe inputs.
Releasing the compiled closure matters: upstream retains its local predict until
decode completes. A lease lets that local reference outlive the underlying trace.
This consumes the model instance; it cannot generate a second image afterward.
"""

import argparse
import gc
import json
import time
from contextlib import nullcontext
from pathlib import Path

import mlx.core as mx
from probe_klein_native import STEPS, run


class PredictLease:
    def __init__(self, compiled):
        self.compiled = compiled

    def __call__(self, **kwargs):
        if self.compiled is None:
            raise RuntimeError("Consumed one-shot prediction lease")
        return self.compiled(**kwargs)

    def release(self):
        self.compiled = None


class PhaseMemory:
    def __init__(self, release, small_cache=False, decoder_blocks=False):
        if small_cache and not release:
            raise ValueError("Small-cache experiment requires phase release")
        if decoder_blocks and not small_cache:
            raise ValueError("Decoder-block experiment requires bounded cache release")
        self.release = release
        self.small_cache = small_cache
        self.decoder_blocks = decoder_blocks
        self.decoder_barriers = None
        self.rows = []
        self.steps = 0
        self.pipe = None
        self.lease = None
        self.started = time.perf_counter()

    def prepare(self):
        # Concrete research control, not an app setting or environment variable.
        # Upstream respects this pre-existing host cap when loading the model.
        if self.small_cache:
            mx.set_cache_limit(1_000_000_000)
            mx.clear_cache()

    def snapshot(self, phase):
        from mflux.utils.runtime_memory import RuntimeMemory

        mx.synchronize()
        row = {
            "phase": phase,
            "elapsed_ms": (time.perf_counter() - self.started) * 1000,
            "mlx_active_bytes": mx.get_active_memory(),
            "mlx_cache_bytes": mx.get_cache_memory(),
            "mlx_peak_active_bytes": mx.get_peak_memory(),
            "runtime_memory": RuntimeMemory.snapshot(phase).to_metadata(),
        }
        self.rows.append(row)
        print(json.dumps(row), flush=True)

    def attach(self, pipe):
        if self.pipe is not None:
            raise RuntimeError("Memory experiment requires one fresh model instance")
        self.pipe = pipe
        if self.decoder_blocks:
            from klein_decoder_barriers import DecoderBarriers

            self.decoder_barriers = DecoderBarriers(pipe.vae.decoder)
        self.snapshot("loaded")
        encode = pipe._encode_prompt_pair

        def encode_once(**kwargs):
            if pipe.text_encoder is None:
                raise RuntimeError("Consumed one-shot text encoder")
            result = encode(**kwargs)
            mx.eval(*[value for value in result if value is not None])
            self.snapshot("prompt_encoded")
            if self.release:
                pipe.text_encoder = None
                pipe.prompt_cache.clear()
                gc.collect()
                mx.clear_cache()
                self.snapshot("text_encoder_released")
            return result

        pipe._encode_prompt_pair = encode_once
        build = pipe.compiled_predict_cache.get_or_build

        def get_or_build(**kwargs):
            if self.lease is not None:
                raise RuntimeError("Memory experiment forbids model reuse")
            self.lease = PredictLease(build(**kwargs))
            return self.lease

        pipe.compiled_predict_cache.get_or_build = get_or_build
        pipe.callbacks.register(self)

    def call_in_loop(self, *, latents, **_):
        mx.eval(latents)
        self.steps += 1

    def call_after_loop(self, *, latents, **_):
        if self.steps != STEPS or self.lease is None:
            raise RuntimeError("Cannot release before all native inference steps")
        mx.eval(latents)
        self.snapshot("denoised")
        if self.release:
            self.lease.release()
            self.pipe.compiled_predict_cache.clear()
            self.pipe.transformer = None
            gc.collect()
            mx.clear_cache()
            self.snapshot("transformer_released")

    def decode_scope(self):
        return (
            self.decoder_barriers.active()
            if self.decoder_barriers is not None
            else nullcontext()
        )

    def report(self):
        expected = ["loaded", "prompt_encoded"]
        if self.release:
            expected.append("text_encoder_released")
        expected.append("denoised")
        if self.release:
            expected.append("transformer_released")
        expected.extend(["before_decode", "after_decode"])
        if [row["phase"] for row in self.rows] != expected:
            raise RuntimeError("Missing ordered phase memory evidence")
        return {
            "mode": (
                "release-blocks-small-cache"
                if self.decoder_blocks
                else "release-small-cache"
                if self.small_cache
                else "release"
                if self.release
                else "resident"
            ),
            "rows": self.rows,
            "cache_limit_changed": self.small_cache,
            "explicit_cache_limit_bytes": 1_000_000_000 if self.small_cache else None,
            "peak_reset_during_inference": False,
            "native_math_changed": False,
            "instance_consumed": self.release,
            "decoder_barriers": (
                self.decoder_barriers.report()
                if self.decoder_barriers is not None
                else None
            ),
            "scope": "Synchronized phase snapshots, not a total system/device peak or supported lower-memory Mac qualification.",
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["upstream", "model", "image", "mask", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--crop", type=int, nargs=4, required=True)
    parser.add_argument("--float-input", type=Path)
    parser.add_argument(
        "--mode",
        choices=[
            "resident",
            "release",
            "release-small-cache",
            "release-blocks-small-cache",
        ],
        required=True,
    )
    args = parser.parse_args()
    run(
        args.upstream,
        args.model,
        args.image,
        args.mask,
        tuple(args.crop),
        args.output,
        args.float_input,
        PhaseMemory(
            args.mode != "resident",
            args.mode in ["release-small-cache", "release-blocks-small-cache"],
            args.mode == "release-blocks-small-cache",
        ),
    )
