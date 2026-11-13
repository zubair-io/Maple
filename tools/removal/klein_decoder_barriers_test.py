"""Real upstream whole-frame decoder equality and failure-scope restoration."""

import json
import sys
import unittest
from pathlib import Path

import mlx.core as mx
from klein_decoder_barriers import DecoderBarriers
from mlx.utils import tree_map
from probe_klein_native import verify_source

SOURCE = Path("/tmp/maple-removal-mlx-gen-source")
PINS = json.loads(Path(__file__).with_name("klein-research-models.json").read_text())


class KleinDecoderBarriersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SOURCE.exists():
            raise unittest.SkipTest("Pinned upstream research source is not installed")
        verify_source(SOURCE, PINS["runtimeSource"])
        sys.path.insert(0, str(SOURCE / "src"))
        from mflux.models.flux2.model.flux2_vae.decoder.decoder import Flux2Decoder

        mx.random.seed(3941)
        cls.decoder = Flux2Decoder()
        cls.decoder.update(
            tree_map(lambda a: a.astype(mx.bfloat16), cls.decoder.parameters())
        )
        mx.eval(cls.decoder.parameters())

    def test_actual_whole_decoder_keeps_identical_unclipped_samples(self):
        values = mx.random.normal((1, 32, 8, 8)).astype(mx.bfloat16)
        expected = self.decoder(values)
        mx.eval(expected)
        probe = DecoderBarriers(self.decoder)
        methods = {type(b): type(b).__call__ for _, b in probe.blocks}
        with probe.active():
            actual = self.decoder(values)
            mx.eval(actual)
        self.assertTrue(bool(mx.array_equal(expected, actual).item()))
        self.assertEqual(actual.shape, (1, 3, 64, 64))
        self.assertEqual(len(probe.report()["rows"]), 21)
        for cls, method in methods.items():
            self.assertIs(cls.__call__, method)
        with self.assertRaisesRegex(RuntimeError, "one decode"):
            with probe.active():
                pass

    def test_partial_decode_restores_methods_and_refuses_report(self):
        from mflux.models.flux2.model.flux2_vae.decoder.conv_in import Flux2ConvIn

        probe = DecoderBarriers(self.decoder)
        original = Flux2ConvIn.__call__
        unrelated = Flux2ConvIn(32, 32)
        values = mx.zeros((1, 32, 8, 8), dtype=mx.bfloat16)
        with self.assertRaisesRegex(RuntimeError, "diagnostic interruption"):
            with probe.active():
                mx.eval(unrelated(values))
                self.assertEqual(probe.rows, [])
                mx.eval(self.decoder.conv_in(values))
                raise RuntimeError("diagnostic interruption")
        self.assertIs(Flux2ConvIn.__call__, original)
        with self.assertRaisesRegex(RuntimeError, "Missing ordered"):
            probe.report()


if __name__ == "__main__":
    unittest.main()
