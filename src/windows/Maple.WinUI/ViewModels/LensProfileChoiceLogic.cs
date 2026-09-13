// LensProfileChoiceLogic — the Windows Lens panel's profile dropdown
// (#3568, Windows slice of the bundled-Lensfun epic #3564), WinUI-free by
// design (the decision half of MainWindow.LensProfile.cs, the same split
// WhiteBalancePickLogic.cs uses for the white-balance eyedropper).
//
// Mirrors the Apple panel's pure mapping,
// `LensProfileChoice.build` (MapleCore/Editor/LensProfileChoice.swift): the
// SAME two raw-ffi entry points (`maple_lens_profile_resolve_file`,
// `maple_lens_profile_compatible`, bound in Native/RawFfi.LensProfile.cs and
// wrapped by Services/LensProfileStore.cs) feed this function, which turns
// already-decoded results into the dropdown's option list and the short
// source line under it — no FFI, no file I/O, no ViewModel — so it is
// unit-tested with literal records (Maple.WinUI.Tests/LensProfileChoiceLogicTests.cs).

using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One entry of the profile ComboBox. `Value` is exactly what
    /// gets written to `model.LensProfile` through
    /// <c>EditSessionViewModel.SelectLensProfile</c> — `""` for Automatic,
    /// `lensfun1:&lt;slug&gt;` for a bundled pick, or the sidecar's existing
    /// `lcp1(-ack):&lt;digest&gt;` for an imported profile. `ToString()`
    /// returns <see cref="Label"/> so a plain <c>ComboBox.ItemsSource</c> of
    /// these needs no `DisplayMemberPath` — the same shape
    /// <c>WhiteBalancePresets.Names</c> uses for its own combo, one level
    /// simpler since that list has no separate value/label pair.</summary>
    public sealed record LensProfileOption(string Value, string Label)
    {
        public override string ToString() => Label;
    }

    /// <summary>What <see cref="LensProfileChoiceLogic.Build"/> hands the
    /// panel: the dropdown's options (Automatic first) and the short source
    /// line under it.</summary>
    public sealed record LensProfileChoiceResult(IReadOnlyList<LensProfileOption> Options, string SourceLine);

    public static class LensProfileChoiceLogic
    {
        /// <summary>What selecting "Automatic" writes into `model.LensProfile`.</summary>
        public const string AutomaticValue = "";

        private const string BundledPrefix = "lensfun1:";

        /// <summary>
        /// Builds the dropdown state from already-resolved evidence:
        /// <paramref name="reference"/> is the model's current
        /// `papp:LensProfile` (`""` = Automatic); <paramref name="autoMatch"/>
        /// is what <c>maple_lens_profile_resolve_file(path, "")</c> resolved
        /// (the automatic match, independent of the current selection);
        /// <paramref name="current"/> is what the last decode resolved for
        /// <paramref name="reference"/> itself (already published by
        /// <c>EditSessionViewModel.PublishLensProfile</c>); <paramref name="compatible"/>
        /// is <c>maple_lens_profile_compatible</c>'s list for this RAW's
        /// camera body.
        /// </summary>
        public static LensProfileChoiceResult Build(
            string reference,
            LensProfileResolution? autoMatch,
            LensProfileResolution? current,
            IReadOnlyList<CompatibleLens> compatible)
        {
            var automaticLabel = autoMatch is { Lensfun: true, Lens: { Length: > 0 } lens } ? lens : "no match";
            var options = new List<LensProfileOption>
            {
                new(AutomaticValue, $"Automatic — {automaticLabel}"),
            };

            options.AddRange(compatible
                .OrderBy(l => l.Maker, StringComparer.Ordinal)
                .ThenBy(l => l.Model, StringComparer.Ordinal)
                .Select(l => new LensProfileOption(BundledPrefix + l.Slug, $"{l.Maker} {l.Model}")));

            // The selected reference is normally already one of the two
            // branches above (Automatic, or a lens this body's compatible
            // list names); append it defensively when it is neither — a
            // stale sidecar naming a bundled lens the current camera match
            // no longer lists, or an imported `lcp1(-ack):` reference (#3395,
            // which stays the override for a lens Lensfun lacks) — so the
            // dropdown always shows what is actually selected instead of
            // silently falling back to Automatic.
            if (reference.Length > 0 && !options.Any(o => o.Value == reference))
            {
                var label = reference.StartsWith(BundledPrefix, StringComparison.Ordinal)
                    ? current?.Lens is { Length: > 0 } currentLens ? currentLens : reference[BundledPrefix.Length..]
                    : "Imported profile";
                options.Add(new LensProfileOption(reference, label));
            }

            var sourceLine = current?.Source switch
            {
                "lensfun" => $"Lensfun database {current.DbVersion ?? "unknown"} · CC BY-SA 3.0",
                "lcp" => "Imported profile",
                "embedded" => "Embedded corrections",
                _ => "No lens correction data",
            };

            return new LensProfileChoiceResult(options, sourceLine);
        }

        /// <summary>True once there is something the master toggle can turn
        /// on: either the current selection resolves to real coverage, or
        /// the dropdown offers a pickable lens beyond Automatic. Mirrors
        /// Apple's `LensProfileChoice.isAvailable` — broader than gating on
        /// embedded corrections alone, since a Lensfun match can correct a
        /// RAW that carries no embedded `OpcodeList3` at all.</summary>
        public static bool IsAvailable(LensProfileResolution? current, IReadOnlyList<LensProfileOption> options) =>
            (current?.CoversAnyFamily ?? false) || options.Any(o => o.Value.Length > 0);
    }
}
