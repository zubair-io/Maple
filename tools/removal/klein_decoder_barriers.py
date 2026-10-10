"""#3941: evaluate exact whole-frame native VAE blocks; no tiled decoding.

The pinned upstream model must already be verified by probe_klein_native. Only
the specific decoder instances are intercepted, and class methods are restored
even if decoding fails. This changes graph evaluation boundaries, not operators,
weights, precision or image geometry. Actual output equality must be measured.
"""

import time
from contextlib import contextmanager

import mlx.core as mx


class DecoderBarriers:
    def __init__(self, decoder):
        mid = decoder.mid_block
        if len(mid.resnets) != 2 or len(mid.attentions) != 1:
            raise ValueError("Unexpected pinned VAE mid-block topology")
        blocks = [
            ("conv_in", decoder.conv_in),
            ("mid.resnet0", mid.resnets[0]),
            ("mid.attention", mid.attentions[0]),
            ("mid.resnet1", mid.resnets[1]),
        ]
        if len(decoder.up_blocks) != 4:
            raise ValueError("Unexpected pinned VAE up-block topology")
        for i, up in enumerate(decoder.up_blocks):
            if len(up.resnets) != 3 or len(up.upsamplers) != (0 if i == 3 else 1):
                raise ValueError("Unexpected pinned VAE resnet/upsample topology")
            blocks.extend((f"up{i}.resnet{j}", r) for j, r in enumerate(up.resnets))
            blocks.extend((f"up{i}.sample{j}", r) for j, r in enumerate(up.upsamplers))
        blocks.extend(
            [("conv_norm_out", decoder.conv_norm_out), ("conv_out", decoder.conv_out)]
        )
        self.blocks = blocks
        self.labels = {id(block): label for label, block in blocks}
        self.rows = []
        self.entered = False
        self.restored = False

    def _wrapped(self, original):
        def evaluate(block, *args, **kwargs):
            result = original(block, *args, **kwargs)
            label = self.labels.get(id(block))
            if label is None:
                return result
            started = time.perf_counter()
            mx.eval(result)
            if result.ndim != 4 or not bool(mx.all(mx.isfinite(result)).item()):
                raise ValueError("Invalid native VAE block samples or geometry")
            self.rows.append(
                {
                    "block": label,
                    "output_nchw": list(result.shape),
                    "output_dtype": str(result.dtype),
                    "materialization_ms": (time.perf_counter() - started) * 1000,
                    "mlx_active_bytes": mx.get_active_memory(),
                    "mlx_cache_bytes": mx.get_cache_memory(),
                    "mlx_peak_active_bytes": mx.get_peak_memory(),
                }
            )
            return result

        return evaluate

    @contextmanager
    def active(self):
        if self.entered:
            raise RuntimeError("Decoder barrier experiment requires one decode")
        self.entered = True
        originals = {type(block): type(block).__call__ for _, block in self.blocks}
        try:
            for cls, original in originals.items():
                cls.__call__ = self._wrapped(original)
            yield
        finally:
            for cls, original in originals.items():
                cls.__call__ = original
            self.restored = True

    def report(self):
        if not self.restored or [r["block"] for r in self.rows] != [
            label for label, _ in self.blocks
        ]:
            raise RuntimeError(
                "Missing ordered native decoder materialization evidence"
            )
        return {
            "rows": self.rows,
            "class_methods_restored": self.restored,
            "resized": False,
            "tiled": False,
            "precision_changed": False,
            "equality_scope": "Graph materialization control only; compare actual pre-clipped native output bytes before claiming pixel equality.",
        }
