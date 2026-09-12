import math, unittest
from convert_lensfun_db import canonical, convert_distortion, convert_tca, convert_vignetting, hugin_scale_mm

class Canonical(unittest.TestCase):
    def test_pairs(self):
        for maker, exif, lf in [
            ("Sony", "FE 24-70mm F4 ZA OSS", "FE 24-70mm f/4 ZA OSS"),
            ("Canon", "EF70-200mm f/2.8L IS II USM", "Canon EF 70-200mm f/2.8L IS II USM"),
            ("Canon", "EF50mm f/1.2L USM", "Canon EF 50mm f/1.2L USM"),
            ("Fujifilm", "XF35mmF2 R WR", "XF 35mm f/2 R WR"),
        ]:
            self.assertEqual(canonical(maker, exif), canonical(maker, lf))
    def test_camera_maker_token(self):
        self.assertEqual(canonical("NIKON CORPORATION", "NIKON D850"), canonical("Nikon", "Nikon D850"))

class Conversion(unittest.TestCase):
    def test_ptlens_rescale_matches_liblensfun_rule(self):
        # Sony FE 24-70 f/4 at 24 mm: crop 1, aspect 1.5 → hugin scale = 43.2666/1/1.80278/2 = 12.0 mm; s = 24/12 = 2
        s = 24.0 / hugin_scale_mm(1.0, 1.5)
        self.assertAlmostEqual(s, 2.0, places=6)
        out = convert_distortion("ptlens", dict(a=0.01, b=-0.02, c=0.005), 24.0, 1.0, 1.5)
        d = 1 - 0.01 + 0.02 - 0.005
        self.assertAlmostEqual(out["scale"], 1.0)  # liblensfun absorbs the zoom d
        self.assertAlmostEqual(out["even"][0], -0.02 * s**2 / d**3)
        self.assertAlmostEqual(out["odd"][0], 0.005 * s / d**2)
        self.assertAlmostEqual(out["odd"][1], 0.01 * s**3 / d**4)
    def test_poly3_folds_1_minus_k1_into_scale(self):
        out = convert_distortion("poly3", dict(k1=-0.1), 50.0, 1.0, 1.5)
        self.assertAlmostEqual(out["scale"], 1.0)  # liblensfun absorbs the zoom d
        self.assertAlmostEqual(out["even"][0], -0.1 * (50.0 / hugin_scale_mm(1.0, 1.5))**2 / 1.1**3)
    def test_vignetting_uses_corner_scale(self):
        k = convert_vignetting("pa", dict(k1=-0.3, k2=0.4, k3=-0.5), 24.0, 1.0)
        s = 24.0 / (math.hypot(36, 24) / 2)
        self.assertAlmostEqual(k[0], -0.3 * s**2); self.assertAlmostEqual(k[1], 0.4 * s**4); self.assertAlmostEqual(k[2], -0.5 * s**6)
    def test_tca_poly3(self):
        red, blue = convert_tca("poly3", dict(vr=1.0002, vb=0.9998, cr=0.0, cb=0.0, br=0.00008, bb=-0.0002), 24.0, 1.0, 1.5)
        s = 24.0 / hugin_scale_mm(1.0, 1.5)
        self.assertEqual(red["scale"], 1.0002); self.assertAlmostEqual(red["even"][0], 0.00008 * s**2)
        self.assertEqual(blue["scale"], 0.9998); self.assertAlmostEqual(blue["even"][0], -0.0002 * s**2)

if __name__ == "__main__": unittest.main()
