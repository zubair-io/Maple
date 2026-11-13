import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.modules.setdefault("dbus", types.ModuleType("dbus"))

import accessibility_smoke


def record(**overrides):
    base = {
        "path": "/org/a11y/atspi/accessible/root",
        "depth": 0,
        "name": "Maple",
        "role": 23,
        "interfaces": ["org.a11y.atspi.Accessible"],
        "states": [],
        "actions": [],
    }
    base.update(overrides)
    return base


class FormatTreeTest(unittest.TestCase):
    def test_dump_includes_name_role_states_actions_and_depth(self) -> None:
        dump = accessibility_smoke.format_tree(
            [
                record(),
                record(
                    path="/org/a11y/atspi/accessible/42",
                    depth=2,
                    name="Light",
                    role=43,
                    interfaces=[
                        "org.a11y.atspi.Accessible",
                        "org.a11y.atspi.Action",
                    ],
                    states=[8, 25, 30],
                    actions=["click"],
                ),
            ]
        )
        self.assertIn("name='Maple' role=23", dump)
        self.assertIn(
            "    /org/a11y/atspi/accessible/42 name='Light' role=43 "
            "states=[enabled, showing, visible] actions=[click]",
            dump,
        )

    def test_stale_and_defunct_states_are_named(self) -> None:
        dump = accessibility_smoke.format_tree([record(states=[6, 27])])
        self.assertIn("states=[defunct, stale]", dump)

    def test_unknown_state_falls_back_to_its_number(self) -> None:
        dump = accessibility_smoke.format_tree([record(states=[999])])
        self.assertIn("states=[999]", dump)

    def test_node_without_actions_or_states_shows_empty_metadata(self) -> None:
        dump = accessibility_smoke.format_tree([record(name="Exposure")])
        self.assertIn("name='Exposure'", dump)
        self.assertIn("states=[] actions=[]", dump)


class DecodeStateSetTest(unittest.TestCase):
    def test_low_word_bits_are_state_numbers(self) -> None:
        words = [(1 << 8) | (1 << 25) | (1 << 30), 0]
        self.assertEqual(accessibility_smoke.decode_state_set(words), [8, 25, 30])

    def test_high_word_bits_continue_after_31(self) -> None:
        self.assertEqual(
            accessibility_smoke.decode_state_set([1 << 6, (1 << 0) | (1 << 9)]),
            [6, 32, 41],
        )

    def test_empty_bitfield_has_no_states(self) -> None:
        self.assertEqual(accessibility_smoke.decode_state_set([0, 0]), [])

    def test_node_states_reads_the_get_state_method(self) -> None:
        # AT-SPI's Accessible interface exposes GetState (`au`); there is no
        # GetStateSet, whose D-Bus error used to be swallowed as `states=[]`.
        class Accessible:
            def GetState(self):
                return [(1 << 6) | (1 << 27), 0]

        self.assertEqual(accessibility_smoke.node_states(Accessible()), [6, 27])


if __name__ == "__main__":
    unittest.main()
