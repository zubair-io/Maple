// src/scripts/lensfun_reference.cpp — prints liblensfun's answers for the
// cases Maple's Lensfun port is tested against (#3565). Build with
// src/scripts/lensfun_reference.sh <lensfun-checkout>.
//
// Written against the lensfun master header at commit 12f5976 (the
// post-0.3.95 API): the configured header is emitted flat as
// <build>/lensfun.h, so it is included as <lensfun.h> with -I <build>;
// lfLens exposes its name as the `Maker` / `Model` lfMLstr fields (there is
// no GetMaker()/GetModel()); and lfModifier takes the image focal, crop and
// size in its constructor, after which the argument-less Enable*Correction()
// overloads pick the lens's own calibration.
//
// Lookups that worked, verbatim: FindCamerasExt(maker, model) with the EXIF
// maker/model strings and no search flags, and FindLenses(camera, maker,
// model) with the Lensfun `<model>` text (the Fujifilm lens is matched from
// its `lang="en"` name). Neither the LF_SEARCH_LOOSE flag nor a NULL lens
// maker was needed for any case.
//
// Every case must land on an exact calibration sample, so that no focal
// spline / inverse-distance interpolation is folded into the reference:
// the harness asserts that the calibration liblensfun selected carries the
// case's own focal (and aperture and distance for vignetting) and exits 1
// otherwise. A lens whose selected calibration set has no vignetting
// samples at all yields factors of exactly 1 (ApplyColorModification
// reports nothing to do) and is recorded in the JSON's "notes".
#include <lensfun.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

struct Case {
    const char *cmaker, *cmodel, *lmaker, *lmodel;
    float crop;
    int w, h;
    float focal, aperture, distance;
};

static bool same(float a, float b) { return std::fabs(a - b) < 1e-4f; }

static std::string num(float v) {
    char buf[32];
    snprintf(buf, sizeof buf, "%g", v);
    return buf;
}

static void note_once(std::vector<std::string> &notes, const std::string &note) {
    for (const std::string &n : notes)
        if (n == note) return;
    notes.push_back(note);
}

static bool run(lfDatabase &db, const Case &c, bool &first, std::vector<std::string> &notes) {
    const lfCamera **cams = db.FindCamerasExt(c.cmaker, c.cmodel);
    if (!cams) {
        fprintf(stderr, "no camera %s %s\n", c.cmaker, c.cmodel);
        return false;
    }
    const lfLens **lenses = db.FindLenses(cams[0], c.lmaker, c.lmodel);
    if (!lenses) {
        fprintf(stderr, "no lens %s %s for camera %s %s\n", c.lmaker, c.lmodel, c.cmaker, c.cmodel);
        lf_free(cams);
        return false;
    }
    const lfLens *lens = lenses[0];
    const std::string name = std::string(lens->Maker) + " " + lens->Model;
    const std::string label = name + " @ " + num(c.focal) + "mm";
    if (strcmp(lens->Model, c.lmodel) != 0)
        note_once(notes, name + ": looked up as \\\"" + c.lmodel + "\\\" (a lang=\\\"en\\\" alias); the JSON carries Lensfun's default <model> text");

    // Exact-sample guard: the reference must not contain interpolated terms.
    lfLensCalibDistortion lcd;
    if (!lens->InterpolateDistortion(c.crop, c.focal, lcd) || !same(lcd.Focal, c.focal)) {
        fprintf(stderr, "%s: focal %g is not an exact <distortion focal> sample\n", label.c_str(), c.focal);
        lf_free(lenses);
        lf_free(cams);
        return false;
    }
    lfLensCalibTCA lctca;
    if (!lens->InterpolateTCA(c.crop, c.focal, lctca) || !same(lctca.Focal, c.focal)) {
        fprintf(stderr, "%s: focal %g is not an exact <tca focal> sample\n", label.c_str(), c.focal);
        lf_free(lenses);
        lf_free(cams);
        return false;
    }
    lfLensCalibVignetting lcv;
    const bool has_vignetting = lens->InterpolateVignetting(c.crop, c.focal, c.aperture, c.distance, lcv);
    if (has_vignetting && !(same(lcv.Focal, c.focal) && same(lcv.Aperture, c.aperture) && same(lcv.Distance, c.distance))) {
        fprintf(stderr, "%s: aperture %g / distance %g is not an exact <vignetting> sample (nearest focal=%g aperture=%g distance=%g)\n",
                label.c_str(), c.aperture, c.distance, lcv.Focal, lcv.Aperture, lcv.Distance);
        lf_free(lenses);
        lf_free(cams);
        return false;
    }
    if (!has_vignetting)
        note_once(notes, name + " (calibration crop " + num(lcd.CalibAttr.CropFactor) +
                             ") has no vignetting samples in the calibration set liblensfun selected for camera crop " + num(c.crop) +
                             "; its vignetting factors are 1 because EnableVignettingCorrection enables nothing");
    fprintf(stderr, "%s: calibration crop %g aspect %g, distortion model %d, vignetting %s\n", label.c_str(),
            lcd.CalibAttr.CropFactor, lcd.CalibAttr.AspectRatio, (int)lcd.Model, has_vignetting ? "yes" : "none");

    const float pts[5][2] = {{c.w / 2.0f, c.h / 2.0f}, {c.w / 4.0f, c.h / 4.0f}, {0, 0}, {c.w - 1.0f, c.h - 1.0f}, {c.w - 1.0f, c.h / 2.0f}};
    printf("%s{\"camera\":{\"maker\":\"%s\",\"model\":\"%s\"},\"lens\":{\"maker\":\"%s\",\"model\":\"%s\"},"
           "\"crop\":%g,\"width\":%d,\"height\":%d,\"focal\":%g,\"aperture\":%g,\"distance\":%g,\"points\":[",
           first ? "" : ",", c.cmaker, c.cmodel, lens->Maker, lens->Model, c.crop, c.w, c.h, c.focal, c.aperture, c.distance);
    first = false;
    for (int i = 0; i < 5; i++) printf("%s[%g,%g]", i ? "," : "", pts[i][0], pts[i][1]);

    printf("],\"distortion\":[");
    lfModifier mod(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    mod.EnableDistortionCorrection();
    for (int i = 0; i < 5; i++) {
        alignas(16) float r[2] = {pts[i][0], pts[i][1]};
        mod.ApplyGeometryDistortion(pts[i][0], pts[i][1], 1, 1, r);
        printf("%s[%.6f,%.6f]", i ? "," : "", r[0], r[1]);
    }

    printf("],\"tca\":[");
    lfModifier tca(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    tca.EnableTCACorrection();
    for (int i = 0; i < 5; i++) {
        alignas(16) float r[6] = {pts[i][0], pts[i][1], pts[i][0], pts[i][1], pts[i][0], pts[i][1]};
        tca.ApplySubpixelDistortion(pts[i][0], pts[i][1], 1, 1, r);
        printf("%s[[%.6f,%.6f],[%.6f,%.6f],[%.6f,%.6f]]", i ? "," : "", r[0], r[1], r[2], r[3], r[4], r[5]);
    }

    printf("],\"vignetting\":[");
    lfModifier vig(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    vig.EnableVignettingCorrection(c.aperture, c.distance);
    for (int i = 0; i < 5; i++) {
        alignas(16) float px[3] = {1, 1, 1};
        vig.ApplyColorModification(px, pts[i][0], pts[i][1], 1, 1, LF_CR_3(RED, GREEN, BLUE), 3 * sizeof(float));
        printf("%s%.6f", i ? "," : "", px[1]);
    }
    printf("]}\n");
    lf_free(lenses);
    lf_free(cams);
    return true;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <db-dir> <db-commit>\n", argv[0]);
        return 2;
    }
    lfDatabase db;
    if (db.Load(argv[1]) != LF_NO_ERROR) {
        fprintf(stderr, "db load failed\n");
        return 1;
    }
    // Focal lengths are exact <distortion focal> and <tca focal> samples;
    // aperture/distance pairs are exact <vignetting> samples where the lens
    // has any (see the plan's Task 1 and the JSON "notes").
    const Case cases[] = {
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 24, 5.6f, 5},
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 33, 5.6f, 5},
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 70, 5.6f, 5},
        {"Canon", "Canon EOS 5D Mark III", "Canon", "Canon EF 70-200mm f/2.8L IS II USM", 1.0f, 5760, 3840, 70, 4, 6.6f},
        {"Canon", "Canon EOS 5D Mark III", "Canon", "Canon EF 70-200mm f/2.8L IS II USM", 1.0f, 5760, 3840, 200, 4, 6.6f},
        {"Fujifilm", "X-T3", "Fujifilm", "XF 35mm f/2 R WR", 1.5f, 6240, 4160, 35, 2.8f, 10},
    };
    std::vector<std::string> notes = {
        "Sony FE 24-70mm f/4 ZA OSS: the plan's 35mm case runs at 33mm because the crop-1 calibration set samples distortion at 24/33/50/70 only",
        "Canon EF 70-200mm f/2.8L IS II USM: focus distance 6.6m instead of the plan's 10m because the aperture-4 vignetting samples are at 1.1/2.2/6.6/1000m",
        "Fujifilm XF 35mm f/2 R WR: focus distance 10m instead of the plan's 3m because every vignetting sample is at 10m or 1000m",
    };
    printf("{\"db_commit\":\"%s\",\"cases\":[", argv[2]);
    bool first = true;
    bool ok = true;
    for (const Case &c : cases) ok = run(db, c, first, notes) && ok;
    printf("],\"notes\":[");
    for (size_t i = 0; i < notes.size(); i++) printf("%s\"%s\"", i ? "," : "", notes[i].c_str());
    printf("]}\n");
    return ok ? 0 : 1;
}
