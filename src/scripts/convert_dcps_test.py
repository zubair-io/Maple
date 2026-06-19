#!/usr/bin/env python3
import unittest
from pathlib import Path
import sys

# Add the directory containing convert_dcps.py to sys.path
sys.path.append(str(Path(__file__).resolve().parent))

import struct
from convert_dcps import srational_to_floats, read_matrix, dcp_preference, write_matrix, write_hsm_data

class TestConvertDCPs(unittest.TestCase):
    def test_srational_to_floats(self):
        # Normal case
        self.assertEqual(srational_to_floats((1, 2, 3, 4)), [0.5, 0.75])
        # Empty case
        self.assertEqual(srational_to_floats(()), [])
        # Division by zero
        self.assertEqual(srational_to_floats((1, 0)), [0.0])
        # Odd number of values (should ignore the last one as per implementation)
        self.assertEqual(srational_to_floats((1, 2, 3)), [0.5])

    def test_read_matrix(self):
        class MockTag:
            def __init__(self, value):
                self.value = value

        # Correct matrix
        tags = {"ColorMatrix1": MockTag((1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1))}
        self.assertEqual(len(read_matrix(tags, "ColorMatrix1")), 9)

        # Missing tag
        self.assertIsNone(read_matrix(tags, "ColorMatrix2"))

        # Malformed tag (too few elements)
        tags = {"ColorMatrix1": MockTag((1, 1, 1, 1))}
        self.assertIsNone(read_matrix(tags, "ColorMatrix1"))

    def test_write_matrix(self):
        buf = bytearray()
        m = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
        write_matrix(buf, m)
        self.assertEqual(len(buf), 9 * 4)
        # Check first value
        self.assertEqual(struct.unpack("<f", buf[:4])[0], 1.0)

    def test_write_hsm_data(self):
        buf = bytearray()
        values = [1.0, 2.0, 3.0]
        write_hsm_data(buf, values)
        self.assertEqual(len(buf), 3 * 4)
        self.assertEqual(struct.unpack("<f", buf[:4])[0], 1.0)

    def test_dcp_preference(self):
        # Tier 0: Adobe Standard v2
        self.assertEqual(dcp_preference("Adobe Standard v2.dcp")[0], 0)
        self.assertEqual(dcp_preference("Adobe_Standard_v2.dcp")[0], 0)

        # Tier 1: Adobe Standard
        self.assertEqual(dcp_preference("Adobe Standard.dcp")[0], 1)
        self.assertEqual(dcp_preference("Adobe_Standard.dcp")[0], 1)

        # Tier 2: Camera Default
        self.assertEqual(dcp_preference("Camera Default.dcp")[0], 2)

        # Tier 3: Camera Standard
        self.assertEqual(dcp_preference("Camera Standard.dcp")[0], 3)
        self.assertEqual(dcp_preference("Camera_Standard.dcp")[0], 3)

        # Tier 4-7: Other creative variants
        self.assertEqual(dcp_preference("Camera Faithful.dcp")[0], 4)
        self.assertEqual(dcp_preference("Camera Landscape.dcp")[0], 5)
        self.assertEqual(dcp_preference("Camera Neutral.dcp")[0], 6)
        self.assertEqual(dcp_preference("Camera Portrait.dcp")[0], 7)

        # Tier 9: Anything else
        self.assertEqual(dcp_preference("Some Other Profile.dcp")[0], 9)

if __name__ == "__main__":
    unittest.main()
