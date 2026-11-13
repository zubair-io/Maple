"""Actual MLX trace ownership and premature-release rejection, not tier claims."""

import gc
import json
import sys
import unittest
import weakref
from functools import partial
from pathlib import Path

import mlx.core as mx
from mlx import nn
from probe_klein_memory import PhaseMemory, PredictLease
from probe_klein_native import verify_source

SOURCE = Path("/tmp/maple-removal-mlx-gen-source")
PINS = json.loads(Path(__file__).with_name("klein-research-models.json").read_text())


def compiled_linear(model):
    return mx.compile(lambda values: model(values))


class KleinMemoryProbeTests(unittest.TestCase):
    def test_actual_compiled_cache_clearing_alone_keeps_model_alive(self):
        if not SOURCE.exists():
            self.skipTest("Pinned upstream research source is not installed")
        verify_source(SOURCE, PINS["runtimeSource"])
        sys.path.insert(0, str(SOURCE / "src"))
        from mflux.utils.compiled_predict_cache import CompiledPredictCache

        model = nn.Linear(32, 32)
        reference = weakref.ref(model)
        cache = CompiledPredictCache()
        lease = PredictLease(
            cache.get_or_build(
                key="ownership-test",
                weights_token=model,
                build=partial(compiled_linear, model),
            )
        )
        values = mx.ones((1, 32))
        expected = model(values)
        actual = lease(values=values)
        mx.eval(expected, actual)
        self.assertTrue(bool(mx.array_equal(expected, actual).item()))
        cache.clear()
        del model
        gc.collect()
        self.assertIsNotNone(reference())
        lease.release()
        gc.collect()
        self.assertIsNone(reference())
        with self.assertRaisesRegex(RuntimeError, "Consumed one-shot"):
            lease(values=values)

    def test_incomplete_steps_cannot_release_or_publish_memory_evidence(self):
        experiment = PhaseMemory(True)
        experiment.lease = PredictLease(lambda **_: mx.zeros((1,)))
        with self.assertRaisesRegex(RuntimeError, "before all native"):
            experiment.call_after_loop(latents=mx.zeros((1,)))
        self.assertIsNotNone(experiment.lease.compiled)
        with self.assertRaisesRegex(RuntimeError, "Missing ordered"):
            experiment.report()


if __name__ == "__main__":
    unittest.main()
