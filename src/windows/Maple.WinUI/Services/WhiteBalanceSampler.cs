// WhiteBalanceSampler — the Windows half of the neutral eyedropper (#2434),
// WinUI-free so Maple.WinUI.Tests can link it and CI's raw_ffi.dll can drive
// it against the committed grey RAW.
//
// One cold, explicit analysis per pick: the current edit model is written to
// a private probe sidecar (a pending debounced autosave must not make the
// sampler develop with stale lens/decode settings — Apple's
// `WhiteBalanceSampler` stages the same way), raw-ffi's
// `maple_sample_white_balance_oriented` solves the neutral at the normalised
// display-oriented point, and the result is gated against the slider domain
// before the caller may commit it. Originals are never written; the probe
// lives in the temp directory and is removed before the call returns.

using System;
using System.IO;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services
{
    /// <summary>Why a pick did not land — one entry per thing the
    /// photographer can do about it (raw-ffi codes 11–14 plus the two host
    /// preconditions), matching Swift's <c>WhiteBalanceSampleError</c>.</summary>
    public enum WhiteBalanceSampleFailure
    {
        OutsideImage,
        Clipped,
        TooDark,
        OutOfDomain,
        UnsupportedAsset,
        Failed,
    }

    /// <summary>The sampler's answer: the pair and the derivation version
    /// stamped as <c>papp:WbAlgorithmVersion</c>.</summary>
    public readonly record struct WhiteBalanceSample(double Temperature, double Tint, uint AlgorithmVersion);

    public sealed class WhiteBalanceSampleException : Exception
    {
        public WhiteBalanceSampleFailure Failure { get; }

        public WhiteBalanceSampleException(WhiteBalanceSampleFailure failure, string? detail = null)
            : base(WhiteBalanceSampler.MessageFor(failure))
        {
            Failure = failure;
            Detail = detail;
        }

        /// <summary>raw-ffi's own message (<c>maple_last_error</c>) for the
        /// log; never shown, the actionable <see cref="Exception.Message"/> is.</summary>
        public string? Detail { get; }
    }

    public static class WhiteBalanceSampler
    {
        // The canonical slider bounds (ADJUSTMENT_SCHEMA `temperature` /
        // `tint`), the same domain gate Apple's picker applies before a
        // sample may reach the model (WhiteBalancePicker.swift).
        private const double MinTemperature = 2000.0;
        private const double MaxTemperature = 12000.0;
        private const double MinTint = -150.0;
        private const double MaxTint = 150.0;

        /// <summary>The RAW containers the decoder samples; a rendered JPEG/
        /// TIFF has no scene-linear neutral to solve (the RAW subset of the
        /// library's supported set in EditSessionViewModel.Library.cs).</summary>
        private static readonly string[] RawExtensions =
        {
            ".dng", ".arw", ".cr3", ".cr2", ".nef", ".orf", ".rw2", ".pef", ".raf", ".srw",
        };

        public static bool IsRawPath(string path) =>
            Array.IndexOf(RawExtensions, Path.GetExtension(path).ToLowerInvariant()) >= 0;

        public static WhiteBalanceSampleFailure FailureForCode(int code) => code switch
        {
            11 => WhiteBalanceSampleFailure.OutsideImage,
            12 => WhiteBalanceSampleFailure.Clipped,
            13 => WhiteBalanceSampleFailure.TooDark,
            14 => WhiteBalanceSampleFailure.OutOfDomain,
            _ => WhiteBalanceSampleFailure.Failed,
        };

        /// <summary>User-facing text — each names the retry, never "sampling
        /// failed" (the same lines Apple shows).</summary>
        public static string MessageFor(WhiteBalanceSampleFailure failure) => failure switch
        {
            WhiteBalanceSampleFailure.OutsideImage =>
                "That point is outside the photo. Pick a neutral area inside the image.",
            WhiteBalanceSampleFailure.Clipped =>
                "That area is blown out. Pick a darker white or gray surface.",
            WhiteBalanceSampleFailure.TooDark =>
                "That area is too dark. Pick a brighter white or gray surface.",
            WhiteBalanceSampleFailure.OutOfDomain =>
                "That color is not a plausible neutral. Pick a different white or gray surface.",
            WhiteBalanceSampleFailure.UnsupportedAsset =>
                "The eyedropper needs a RAW photo. Open the original RAW to sample white balance.",
            _ => "The RAW could not be sampled. Check that the original is available, then try again.",
        };

        /// <summary>A result may land only if it is finite, inside the slider
        /// domain, and carries a derivation version.</summary>
        public static bool IsInDomain(WhiteBalanceSample sample) =>
            double.IsFinite(sample.Temperature) && double.IsFinite(sample.Tint)
            && sample.Temperature >= MinTemperature && sample.Temperature <= MaxTemperature
            && sample.Tint >= MinTint && sample.Tint <= MaxTint
            && sample.AlgorithmVersion > 0;

        /// <summary>
        /// Sample the neutral at (<paramref name="nx"/>, <paramref name="ny"/>)
        /// — normalised [0, 1] in the uncropped, display-oriented frame — for
        /// the RAW at <paramref name="rawPath"/>, developing with
        /// <paramref name="model"/>. Blocking; call off the UI thread. Throws
        /// <see cref="WhiteBalanceSampleException"/> with the actionable
        /// message for every rejection.
        /// </summary>
        public static WhiteBalanceSample Sample(string rawPath, AdjustmentState model, double nx, double ny)
        {
            if (!IsRawPath(rawPath))
                throw new WhiteBalanceSampleException(WhiteBalanceSampleFailure.UnsupportedAsset);
            using var probe = new ProbeSidecar(model);
            var rc = RawFfi.maple_sample_white_balance_oriented(
                rawPath, probe.Path, (float)nx, (float)ny, out var native);
            if (rc != 0)
                throw new WhiteBalanceSampleException(FailureForCode(rc), RawFfi.LastError());
            var sample = new WhiteBalanceSample(native.temperature, native.tint, native.algorithm_version);
            return IsInDomain(sample)
                ? sample
                : throw new WhiteBalanceSampleException(WhiteBalanceSampleFailure.OutOfDomain);
        }

        /// <summary>
        /// The picker's Auto choice: raw-core's AUTO analysis (the same
        /// estimator the AUTO button runs) developed against
        /// <paramref name="model"/>, of which only the white-balance pair is
        /// returned — tone and AE stay the user's. Blocking; call off the UI
        /// thread. Null when the analysis fails (the message is logged).
        /// </summary>
        public static (double Temperature, double Tint)? EstimateAuto(string rawPath, AdjustmentState model)
        {
            using var probe = new ProbeSidecar(model);
            var rc = RawFfi.maple_compute_auto_adjustments(rawPath, probe.Path, 1, out var auto);
            if (rc != 0)
            {
                DiagLog.Write($"[wb] auto white balance rc={rc}: {RawFfi.LastError()}");
                return null;
            }
            return double.IsFinite(auto.temperature) && double.IsFinite(auto.tint)
                ? (Math.Clamp(auto.temperature, MinTemperature, MaxTemperature), Math.Clamp(auto.tint, MinTint, MaxTint))
                : null;
        }

        /// <summary>The current model serialised to a private temp sidecar
        /// for the duration of one native call.</summary>
        private sealed class ProbeSidecar : IDisposable
        {
            private readonly string _directory;

            public string Path { get; }

            public ProbeSidecar(AdjustmentState model)
            {
                _directory = System.IO.Path.Combine(
                    System.IO.Path.GetTempPath(), "maple-wb-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(_directory);
                Path = System.IO.Path.Combine(_directory, "probe.xmp");
                File.WriteAllText(Path, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model.Clone() }));
            }

            public void Dispose()
            {
                try
                {
                    Directory.Delete(_directory, recursive: true);
                }
                catch (IOException)
                {
                    // Best effort: a leftover probe in %TEMP% is harmless.
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }
    }
}
