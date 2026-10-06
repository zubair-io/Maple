"""Guard reproducibility of the shared native/WASM/GPU exponential endpoints."""

import unittest
from pathlib import Path

from generate_nlm_exp_table import generate


class NlmExpTableTests(unittest.TestCase):
    def test_committed_table_matches_high_precision_generator(self):
        root = Path(__file__).resolve().parents[1]
        path = root / "src/raw-pipeline/raw-core/src/stages/nlm_exp_table.rs"
        self.assertEqual(path.read_text(encoding="utf-8"), generate())


if __name__ == "__main__":
    unittest.main()
