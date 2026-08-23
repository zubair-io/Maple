using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>§2.6 Data plots specimens for the Molecules L1 gallery page
    /// (wave N3b, #3012) — see MuiGalleryWindow.MoleculesL1.cs for the
    /// section split rationale. Histogram, Waveform, Parade, Vectorscope,
    /// CurvePlot, ConnectionGraph, HeatmapLayer.
    ///
    /// Every sample dataset below is a closed-form curve (a Gaussian bump,
    /// a sine wave) rather than <see cref="Random"/> — a gallery specimen
    /// must render identically on every run, the same reasoning
    /// SliderMatrixUITests' fixed budgets and this repo's other
    /// deterministic-fixture conventions already follow.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildDataPlotSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Data plots"));

            var bins = 48;
            AddSpecimen(panel, "Histogram", "RGB distribution plot.", new MuiHistogram
            {
                RedValues = Bump(bins, peakAt: 0.62, width: 0.22, scale: 900),
                GreenValues = Bump(bins, peakAt: 0.5, width: 0.28, scale: 1000),
                BlueValues = Bump(bins, peakAt: 0.35, width: 0.18, scale: 600),
            });

            AddSpecimen(panel, "Waveform", "Luma waveform.", new MuiWaveform
            {
                Luma = SineUnit(64, cycles: 2.5),
            });

            AddSpecimen(panel, "Parade", "Three-channel waveform.", new MuiParade
            {
                RedValues = SineUnit(32, cycles: 1.5, phase: 0.0),
                GreenValues = SineUnit(32, cycles: 1.5, phase: 0.15),
                BlueValues = SineUnit(32, cycles: 1.5, phase: 0.3),
            });

            AddSpecimen(panel, "Vectorscope", "Chroma scatter plot.", new MuiVectorscope
            {
                Samples = new List<MuiVectorscopeSample>
                {
                    new(0.9, 0.2, 0.2), // red
                    new(0.9, 0.6, 0.3), // skin tone
                    new(0.85, 0.7, 0.4),
                    new(0.2, 0.8, 0.3), // green
                    new(0.2, 0.4, 0.9), // blue
                    new(0.9, 0.9, 0.2), // yellow
                    new(0.6, 0.2, 0.8), // magenta
                    new(0.7, 0.55, 0.35),
                },
            });

            AddSpecimen(panel, "Curve Plot", "Draggable point curve.", Row(
                new MuiCurvePlot(),
                new MuiCurvePlot
                {
                    Points = new List<MuiCurvePoint>
                    {
                        new(0, 0.05),
                        new(0.3, 0.15),
                        new(0.7, 0.85),
                        new(1, 0.95),
                    },
                }));

            AddSpecimen(panel, "Connection Graph", "Node-link graph.", new MuiConnectionGraph
            {
                Nodes = new List<MuiConnectionGraphNode>
                {
                    new("hub", "Library", 0.5, 0.15),
                    new("a", "Japan", 0.15, 0.55),
                    new("b", "Iceland", 0.5, 0.55),
                    new("c", "Peru", 0.85, 0.55),
                    new("d", "Kyoto", 0.15, 0.9),
                },
                Links = new List<MuiConnectionGraphLink>
                {
                    new("hub", "a"),
                    new("hub", "b"),
                    new("hub", "c"),
                    new("a", "d"),
                },
            });

            AddSpecimen(panel, "Heatmap Layer", "Density overlay synced to a camera.", new MuiHeatmapLayer
            {
                Density = DensityGrid(rows: 6, cols: 10),
            });
        }

        /// <summary>A Gaussian bump over <paramref name="count"/> bins,
        /// scaled by <paramref name="scale"/>.</summary>
        private static IReadOnlyList<double> Bump(int count, double peakAt, double width, double scale)
        {
            var values = new double[count];
            for (var i = 0; i < count; i++)
            {
                var x = (double)i / (count - 1);
                var d = (x - peakAt) / width;
                values[i] = scale * Math.Exp(-d * d);
            }
            return values;
        }

        /// <summary>A rectified sine wave over <paramref name="count"/>
        /// samples, mapped into 0..1.</summary>
        private static IReadOnlyList<double> SineUnit(int count, double cycles, double phase = 0)
        {
            var values = new double[count];
            for (var i = 0; i < count; i++)
            {
                var x = (double)i / (count - 1);
                values[i] = 0.5 + 0.45 * Math.Sin((x * cycles + phase) * Math.PI * 2);
            }
            return values;
        }

        private static IReadOnlyList<IReadOnlyList<double>> DensityGrid(int rows, int cols)
        {
            var grid = new List<IReadOnlyList<double>>();
            for (var r = 0; r < rows; r++)
            {
                var row = new double[cols];
                for (var c = 0; c < cols; c++)
                {
                    var dx = (double)c / (cols - 1) - 0.65;
                    var dy = (double)r / (rows - 1) - 0.4;
                    row[c] = Math.Max(0, 1 - (dx * dx + dy * dy) * 3.2);
                }
                grid.Add(row);
            }
            return grid;
        }
    }
}
