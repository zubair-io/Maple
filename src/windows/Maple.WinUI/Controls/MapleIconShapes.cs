using System.Collections.Generic;

namespace Maple.WinUI.Controls
{
    /// <summary>One primitive of a Maple icon drawing (16×16 viewBox).</summary>
    public sealed record IconShape
    {
        public string? PathData { get; init; }                  // SVG path mini-language
        public (double Cx, double Cy, double R)? Circle { get; init; }
        public (double X, double Y, double W, double H, double Rx)? Rect { get; init; }
        public bool Filled { get; init; }
        public double Opacity { get; init; } = 1.0;
        public double? StrokeWidth { get; init; }               // null = renderer default
    }

    /// <summary>
    /// The Maple icon family — stroke-only 16×16 drawings shared across all
    /// shells. THE SAME PATH DATA is drawn by web
    /// (maple-common/src/lib/icons/maple-icon-registry.ts +
    /// tool-glyph-shapes.ts) and Apple
    /// (src/apple/Maple/Views/ToolGlyphShapes.swift); the three tables are
    /// kept in sync BY HAND — any edit to one must be mirrored in the others
    /// so an icon looks identical on every platform (#640).
    ///
    /// Chrome set renders at stroke 1.5; the editor tool glyphs carry their
    /// own 1.6 per the S5 drawing contract. Round caps/joins, no fills except
    /// shapes marked Filled.
    /// </summary>
    public static class MapleIconShapes
    {
        private const double ToolStroke = 1.6;

        private static IconShape P(string d) => new() { PathData = d };
        private static IconShape Pt(string d) => new() { PathData = d, StrokeWidth = ToolStroke };
        private static IconShape C(double cx, double cy, double r) => new() { Circle = (cx, cy, r) };
        private static IconShape Ct(double cx, double cy, double r) =>
            new() { Circle = (cx, cy, r), StrokeWidth = ToolStroke };
        private static IconShape R(double x, double y, double w, double h, double rx) =>
            new() { Rect = (x, y, w, h, rx) };
        private static IconShape Rt(double x, double y, double w, double h, double rx) =>
            new() { Rect = (x, y, w, h, rx), StrokeWidth = ToolStroke };
        private static IconShape SharpR(double x, double y, double w, double h) =>
            new() { Rect = (x, y, w, h, 0) };
        private static IconShape Dot(double x, double y) =>
            new() { PathData = $"M{x} {y}v0.01", StrokeWidth = ToolStroke };

        /// <summary>Teardrop outline shared by vibrance/saturation.</summary>
        private const string Droplet =
            "M8 2.8C6 5.2 4.3 7.4 4.3 9.6C4.3 11.64 5.96 13.3 8 13.3" +
            "C10.04 13.3 11.7 11.64 11.7 9.6C11.7 7.4 10 5.2 8 2.8Z";

        private static IconShape Frame() => Rt(2.6, 2.6, 10.8, 10.8, 2.8);

        public static readonly IReadOnlyDictionary<string, IconShape[]> Shapes =
            new Dictionary<string, IconShape[]>
            {
                // ── Chrome set (maple-icon-registry.ts) ─────────────────────
                ["chevron-right"] = new[] { P("M6 3l5 5-5 5") },
                ["chevron-left"] = new[] { P("M10 3l-5 5 5 5") },
                ["chevron-down"] = new[] { P("M3 6l5 5 5-5") },
                ["folder"] = new[] { P("M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z") },
                ["folder-open"] = new[] { P("M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v.5H2.5L2 12a1 1 0 001 1h10l1-5.5") },
                ["photos"] = new[] { R(2.5, 3.5, 11, 9, 1.5), C(6, 7, 1), P("M13 10l-3-3-5 5") },
                ["heart"] = new[] { P("M8 13s-5-2.8-5-6.3A2.7 2.7 0 018 5a2.7 2.7 0 015 1.7C13 10.2 8 13 8 13z") },
                ["check"] = new[] { P("M3 8l3.5 3.5L13 5") },
                ["x"] = new[] { P("M4 4l8 8M12 4l-8 8") },
                ["plus"] = new[] { P("M8 3v10M3 8h10") },
                ["search"] = new[] { C(7, 7, 4), P("M10 10l3 3") },
                ["star"] = new[] { P("M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z") },
                ["star-filled"] = new[]
                {
                    new IconShape
                    {
                        PathData = "M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z",
                        Filled = true,
                    },
                },
                ["flag"] = new[] { P("M4 2v12M4 3h8l-2 2.5L12 8H4") },
                ["dot"] = new[] { new IconShape { Circle = (8, 8, 2.5), Filled = true } },
                ["sort"] = new[] { P("M4 4l2-2 2 2M6 2v10M12 12l-2 2-2-2M10 14V4") },
                ["filter"] = new[] { P("M2.5 3.5h11l-4 5v4l-3 1.5V8.5l-4-5z") },
                ["grid-sm"] = new[]
                {
                    SharpR(2.5, 2.5, 3, 3), SharpR(6.5, 2.5, 3, 3), SharpR(10.5, 2.5, 3, 3),
                    SharpR(2.5, 6.5, 3, 3), SharpR(6.5, 6.5, 3, 3), SharpR(10.5, 6.5, 3, 3),
                    SharpR(2.5, 10.5, 3, 3), SharpR(6.5, 10.5, 3, 3), SharpR(10.5, 10.5, 3, 3),
                },
                ["grid-lg"] = new[]
                {
                    SharpR(2.5, 2.5, 4.5, 4.5), SharpR(9, 2.5, 4.5, 4.5),
                    SharpR(2.5, 9, 4.5, 4.5), SharpR(9, 9, 4.5, 4.5),
                },
                ["info"] = new[] { C(8, 8, 5.5), P("M8 7.5v3.5M8 5.5v.01") },
                ["droplet"] = new[] { P("M8 2.5S3.5 7 3.5 10A4.5 4.5 0 008 14.5 4.5 4.5 0 0012.5 10C12.5 7 8 2.5 8 2.5z") },
                ["tag"] = new[] { P("M2.5 8.5l6 6 6-6V2.5h-6l-6 6z"), C(10, 6, 1) },
                ["scope"] = new[] { P("M2 13h2l1-4 1 6 1-8 1 10 1-7 1 5 1-3 1 2h3") },
                ["back"] = new[] { P("M10 3L5 8l5 5M5 8h9") },
                ["zoom-in"] = new[] { C(7, 7, 4), P("M10 10l3 3M7 5v4M5 7h4") },
                ["zoom-out"] = new[] { C(7, 7, 4), P("M10 10l3 3M5 7h4") },
                ["split"] = new[] { R(2.5, 3.5, 11, 9, 1), P("M8 3.5v9") },
                ["export"] = new[] { P("M8 2.5v8M5 5.5l3-3 3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2") },
                ["edit"] = new[] { P("M3 13l1-3 7-7 2 2-7 7-3 1zM10 4l2 2") },
                ["eyedrop"] = new[] { P("M11 2.5l2.5 2.5-1.5 1.5L10.5 5l-5.5 5.5L3 12l-.5 1.5 1.5-.5 1.5-1.5L11 6l-1-1 1.5-1.5z") },
                ["map-pin"] = new[]
                {
                    P("M8 14s-4.5-4-4.5-7.5A4.5 4.5 0 018 2a4.5 4.5 0 014.5 4.5C12.5 10 8 14 8 14z"),
                    C(8, 6.5, 1.5),
                },
                ["camera"] = new[] { R(2.5, 4.5, 11, 8, 1.5), C(8, 8.5, 2.5), P("M6 4.5l1-1.5h2l1 1.5") },
                ["history"] = new[]
                {
                    P("M2.5 8a5.5 5.5 0 105.5-5.5c-1.8 0-3.4.9-4.4 2.3M2.5 2.5v2.5H5"),
                    P("M8 5v3.2l2 1.3"),
                },
                ["copy"] = new[] { R(5.5, 5.5, 8, 8, 1), P("M3.5 10.5v-7a1 1 0 011-1h7") },
                ["paste"] = new[] { R(3.5, 4.5, 9, 9, 1), P("M6 4.5V3h4v1.5M6 3h4") },
                ["revert"] = new[] { P("M2.5 3v3.5H6"), P("M3 6.5A5.5 5.5 0 118 13.5") },
                ["sidebar"] = new[]
                {
                    R(2, 3.5, 12, 9, 1.5),
                    P("M6 3.5v9"),
                    new IconShape { PathData = "M2.5 4.5H5.5v7H2.5z", Filled = true, Opacity = 0.3 },
                },
                ["inspector"] = new[]
                {
                    R(2, 3.5, 12, 9, 1.5),
                    P("M10 3.5v9"),
                    new IconShape { PathData = "M10.5 4.5H13.5v7H10.5z", Filled = true, Opacity = 0.3 },
                },
                ["filmstrip"] = new[]
                {
                    R(2.5, 2.5, 11, 11, 1), P("M4 4v8M12 4v8"), P("M4 7h1M4 9h1M11 7h1M11 9h1"),
                },
                ["ellipsis-horizontal"] = new[]
                {
                    new IconShape { Circle = (4, 8, 1), Filled = true },
                    new IconShape { Circle = (8, 8, 1), Filled = true },
                    new IconShape { Circle = (12, 8, 1), Filled = true },
                },
                ["share-up-square"] = new[]
                {
                    P("M8 2v8M5 5l3-3 3 3"),
                    P("M3.5 9v3a1 1 0 001 1h7a1 1 0 001-1V9"),
                },
                ["undo-uturn"] = new[] { P("M2.5 6.5L5 4l2.5 2.5"), P("M5 4v4a3 3 0 003 3h5.5") },
                ["redo-uturn"] = new[] { P("M13.5 6.5L11 4 8.5 6.5"), P("M11 4v4a3 3 0 01-3 3H2.5") },
                ["clear-circle-fill"] = new[]
                {
                    new IconShape
                    {
                        PathData =
                            "M2.5 8A5.5 5.5 0 1 0 13.5 8A5.5 5.5 0 1 0 2.5 8Z" +
                            "M8 6.94L9.97 4.97L11.03 6.03L9.06 8L11.03 9.97L9.97 11.03" +
                            "L8 9.06L6.03 11.03L4.97 9.97L6.94 8L4.97 6.03L6.03 4.97Z",
                        Filled = true,
                    },
                },
                ["smart-source-wand"] = new[] { P("M3 13L11 5"), P("M13 2v2M12 3h2M14 5l-1 1M11 4l1 1") },
                ["album-stack"] = new[] { R(4.5, 2.5, 9, 6, 1), R(3, 5, 10, 6, 1), R(2, 7.5, 12, 6, 1) },
                ["keyword-hash"] = new[] { P("M6 2.5l-1 11M11 2.5l-1 11M3 6h10M3 10h10") },
                ["person-circle"] = new[] { C(8, 8, 5.5), C(8, 6.5, 1.75), P("M4.5 12.5a3.5 3.5 0 017 0") },
                ["gear"] = new[]
                {
                    C(8, 8, 2.2),
                    P("M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"),
                },

                // ── S5 editor tool glyphs (#640, tool-glyph-shapes.ts) ──────
                ["tool-exposure"] = new[]
                {
                    Ct(8, 8, 2.3),
                    Pt("M8 2.2v1.3M8 13.8v-1.3M2.2 8h1.3M13.8 8h-1.3" +
                       "M3.9 3.9l0.92 0.92M12.1 3.9l-0.92 0.92" +
                       "M3.9 12.1l0.92-0.92M12.1 12.1l-0.92-0.92"),
                },
                ["tool-brightness"] = new[] { Ct(8, 8, 2.2), Pt("M8 2.2v1.5M8 13.8v-1.5M2.2 8h1.5M13.8 8h-1.5") },
                ["tool-contrast"] = new[] { Ct(8, 8, 4.8), Pt("M8 3.2v9.6") },
                ["tool-highlights"] = new[]
                {
                    Ct(8, 6.6, 2.4),
                    Pt("M4.32 2.92l0.71 0.71M11.68 2.92l-0.71 0.71M2.8 6.6h1M13.2 6.6h-1"),
                    Pt("M2.4 12.4h11.2"),
                },
                ["tool-shadows"] = new[]
                {
                    Pt("M9.95 3.18C7.78 2.3 5.29 2.98 3.87 4.85C2.44 6.71 2.44 9.29 3.87 11.15" +
                       "C5.29 13.02 7.78 13.7 9.95 12.82C8.11 11.92 6.95 10.05 6.95 8" +
                       "C6.95 5.95 8.11 4.08 9.95 3.18Z"),
                },
                ["tool-whites"] = new[] { Ct(8, 8, 4.8), Pt("M5.8 9L8 6.8l2.2 2.2") },
                ["tool-blacks"] = new[] { Ct(8, 8, 4.8), Pt("M5.8 7L8 9.2l2.2-2.2") },
                ["tool-temp"] = new[] { Pt("M7.2 3.4v6"), Ct(7.2, 11.3, 1.9), Pt("M9 4.8h1.4M9 7.2h1.4") },
                ["tool-tint"] = new[] { Ct(6.3, 8, 3.5), Ct(9.7, 8, 3.5) },
                ["tool-vibrance"] = new[] { Pt(Droplet), Pt("M6.6 10.8h2.8") },
                ["tool-saturation"] = new[] { Pt(Droplet), Pt("M6.6 10.8h2.8"), Pt("M6.7 8.4h2.6") },
                ["tool-hsl"] = new[]
                {
                    Pt("M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"),
                    Ct(5.6, 4.6, 1.4), Ct(10, 8, 1.4), Ct(7.2, 11.4, 1.4),
                },
                ["tool-bw"] = new[] { Ct(8, 8, 4.8), Pt("M8 3.2v9.6"), Pt("M5 5.6h2.3M4.3 8h3M5 10.4h2.3") },
                ["tool-clarity"] = new[] { Pt("M8 2.8L13.2 8L8 13.2L2.8 8Z"), Pt("M5.8 8h4.4") },
                ["tool-texture"] = new[]
                {
                    Pt("M2.6 5.6c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0"),
                    Pt("M2.6 11c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0"),
                },
                ["tool-dehaze"] = new[] { Pt("M5 3.8h8.4M2.6 6.6h10.8M2.6 9.4h8.8M5 12.2h8.4") },
                ["tool-vignette"] = new[] { Frame(), Ct(8, 8, 3.1) },
                ["tool-grain"] = new[]
                {
                    Frame(),
                    Dot(5.4, 5.6), Dot(9.8, 4.9), Dot(7.2, 7.8),
                    Dot(11.1, 8.4), Dot(5.9, 10.6), Dot(9.4, 11.2),
                },
                ["tool-color-grade"] = new[] { Ct(8, 8, 4.8), Dot(8, 5.4), Dot(5.8, 9.2), Dot(10.2, 9.2) },
                ["tool-sharpen"] = new[] { Pt("M2.6 12.2H5L8 4.2l3 8h2.4") },
                ["tool-noise"] = new[] { Pt("M2.6 8.4L4.2 5.2L5.8 11.2L7.4 6.4L8.8 8.4H13.4") },
                ["tool-color-nr"] = new[] { Dot(2.8, 8.4), Dot(4.4, 5.8), Dot(6, 10.6), Pt("M7.8 8.4H13.4") },
                ["tool-crop"] = new[] { Pt("M4.6 2.6v8.8h8.8"), Pt("M2.6 4.6h8.8v8.8") },
                ["tool-presets"] = new[] { Rt(5.2, 2.8, 8, 8, 2), Rt(2.8, 5.2, 8, 8, 2) },
            };
    }
}
