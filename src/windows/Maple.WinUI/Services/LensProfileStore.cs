using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>A lens-profile condition the shell must show verbatim rather
    /// than render around: a reference the core does not understand, a
    /// profile missing from this device, a camera/lens mismatch, an
    /// unsupported calibration model.</summary>
    public sealed class LensProfileException : InvalidOperationException
    {
        public LensProfileException(string message) : base(message) { }
    }

    /// <summary>One interpolated calibration sample the resolver picked for a
    /// correction family (`distortion` / `ca` / `vignetting`).</summary>
    public sealed record LensProfileSample(
        string Family, double FocalMm, double? ApertureApex, double? FocusM, double Weight);

    /// <summary>What the core resolved for one RAW: where corrections come
    /// from and which families the calibration covers. Source `lcp` is the
    /// imported profile, `embedded` the DNG's own OpcodeList3 (which always
    /// wins), `none` no correction data at all.</summary>
    public sealed record LensProfileResolution(
        string Source, string Confidence,
        bool HasDistortion, bool HasCa, bool HasVignetting,
        IReadOnlyList<string> Approximations, IReadOnlyList<string> Unsupported,
        IReadOnlyList<LensProfileSample> Samples)
    {
        public bool Imported => Source == "lcp";
        public bool Embedded => Source == "embedded";
        public bool Approximate => Confidence == "approximate";
        public bool CoversAnyFamily => HasDistortion || HasCa || HasVignetting;

        /// <summary>Human-readable inventory for the Lens panel and the
        /// import dialog: source line, covered families, then every reported
        /// approximation and unsupported record on its own line.</summary>
        public string Describe()
        {
            if (Source == "none") return "This photo carries no lens correction data.";
            if (Embedded) return "The DNG's embedded lens corrections apply; an imported profile is not used.";
            var families = new[]
            {
                HasDistortion ? "distortion" : null,
                HasCa ? "chromatic aberration" : null,
                HasVignetting ? "vignetting" : null,
            }.Where(f => f != null);
            var lines = new List<string>
            {
                Approximate
                    ? "Imported profile matches; the frame is outside the calibrated range (approximate)."
                    : "Imported profile matches within the calibrated range.",
                "Covers: " + (families.Any() ? string.Join(", ", families) : "no supported family"),
            };
            lines.AddRange(Approximations.Select(a => "Approximation: " + a));
            lines.AddRange(Unsupported.Select(u => "Unsupported: " + u));
            return string.Join("\n", lines);
        }
    }

    /// <summary>The outcome of importing one `.lcp` for one photo.</summary>
    public sealed record ImportedLensProfile(
        string Reference, string Name, string Make, string Camera, string Lens,
        int SampleCount, LensProfileResolution Resolution)
    {
        /// <summary>The `lcp1-ack:` spelling — the sidecar record that the
        /// user explicitly accepted the resolver's approximations.</summary>
        public string AcknowledgedReference => LensProfileStore.Acknowledge(Reference);
    }

    /// <summary>
    /// User-owned LCP bytes, kept outside the photo library under
    /// `%LOCALAPPDATA%\Maple\LensProfiles\&lt;BLAKE3&gt;.lcp` and addressed by
    /// the digest the core's register call returns (#2435 / #3480). The
    /// sidecar names a profile; this store is what makes that name resolvable
    /// again after a restart. Originals are never touched, and a profile the
    /// sidecar names but this device does not hold is an error — Maple never
    /// substitutes another profile or silently renders without correction.
    /// </summary>
    public static class LensProfileStore
    {
        /// <summary>raw-ffi's own input bound.</summary>
        private const int MaximumBytes = 32 * 1024 * 1024;

        private static readonly Regex ReferenceShape =
            new("\\Alcp1(-ack)?:([0-9a-f]{64})\\z", RegexOptions.Compiled);

        public static string DirectoryPath { get; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "LensProfiles");

        /// <summary>The 64-hex BLAKE3 digest inside a `lcp1:` / `lcp1-ack:`
        /// reference. Anything else — another version, a path, uppercase hex
        /// — is refused before it can name a file.</summary>
        public static string Digest(string reference)
        {
            var match = ReferenceShape.Match(reference);
            if (!match.Success)
                throw new LensProfileException("Unsupported lens profile reference: " + reference);
            return match.Groups[2].Value;
        }

        public static bool IsAcknowledged(string reference) =>
            ReferenceShape.Match(reference) is { Success: true } m && m.Groups[1].Success;

        public static string Acknowledge(string reference) => "lcp1-ack:" + Digest(reference);

        public static string StoredPath(string reference) =>
            Path.Combine(DirectoryPath, Digest(reference) + ".lcp");

        /// <summary>Whether developing <paramref name="model"/> needs the
        /// profile bytes at all — the C# side of raw-core's
        /// `corrections_enabled`: the master toggle off, or every strength at
        /// zero, renders without any external profile.</summary>
        public static bool RequiresProfile(AdjustmentState model) =>
            !string.IsNullOrEmpty(model.LensProfile)
            && model.LensProfileEnable == ToggleMode.On
            && (model.LensCorrectionDistortion != 0
                || model.LensCorrectionCa != 0
                || model.LensCorrectionVignetting != 0);

        /// <summary>Register a `.lcp`, resolve it against the photo's real
        /// capture metadata and, once it resolves, keep its exact bytes under
        /// their digest. A camera/lens mismatch or unsupported model throws
        /// with the resolver's reason and stores nothing.</summary>
        public static ImportedLensProfile Import(string lcpPath, string rawPath)
        {
            var bytes = ReadBounded(lcpPath);
            var registered = Register(bytes);
            var reference = registered.GetProperty("reference").GetString()
                ?? throw new LensProfileException("The lens profile did not register.");
            var resolution = Resolve(rawPath, reference);
            Persist(bytes, StoredPath(reference));
            return new ImportedLensProfile(
                reference,
                Text(registered, "name") is { Length: > 0 } name ? name
                    : Text(registered, "lens") is { Length: > 0 } lens ? lens
                    : Path.GetFileNameWithoutExtension(lcpPath),
                Text(registered, "make"), Text(registered, "camera"), Text(registered, "lens"),
                registered.TryGetProperty("sampleCount", out var count) ? count.GetInt32() : 0,
                resolution);
        }

        /// <summary>Editor path: make the model's selected profile resolvable
        /// in this process before a develop of <paramref name="rawPath"/>.</summary>
        public static void RestoreForFile(string rawPath, AdjustmentState model)
        {
            if (RequiresProfile(model))
                RestoreReference(rawPath, model.LensProfile);
        }

        /// <summary>Queued-export path: the selection comes from the frozen
        /// sidecar snapshot, read by the SAME parser the develop will use
        /// (`maple_lens_profile_selected`), not by the live editor model.</summary>
        public static void RestoreForSidecar(string rawPath, string xmp)
        {
            var bytes = Encoding.UTF8.GetBytes(xmp);
            var selected = ReadResult(
                RawFfi.maple_lens_profile_selected(bytes, (nuint)bytes.Length, out var json), json);
            var reference = Text(selected, "reference");
            if (reference.Length > 0 && selected.GetProperty("enabled").GetBoolean())
                RestoreReference(rawPath, reference);
        }

        /// <summary>raw-core's `resolve_for_raw` wording for a reference this
        /// process has not registered — the one failure the store can repair.
        /// Every other resolver refusal (camera/lens mismatch, unsupported
        /// model) is reported verbatim, acknowledged or not.</summary>
        private const string NotRegistered = "not in the local cache";

        private static void RestoreReference(string rawPath, string reference)
        {
            var digest = Digest(reference);
            // Warm process cache, or a DNG whose embedded corrections take
            // priority: nothing to read from disk.
            try { Resolve(rawPath, reference); return; }
            catch (LensProfileException error) when (error.Message.Contains(NotRegistered, StringComparison.Ordinal))
            { /* fall through to the stored bytes */ }
            var path = StoredPath(reference);
            if (!File.Exists(path))
                throw new LensProfileException(
                    "The selected lens profile is missing from this device. Import the original .lcp again to restore this edit.");
            var registered = Register(ReadBounded(path));
            if (Digest(Text(registered, "reference")) != digest)
                throw new LensProfileException(
                    "The stored lens profile no longer matches this edit. Import the original .lcp again.");
            Resolve(rawPath, reference);
        }

        /// <summary>What the core would apply for <paramref name="reference"/>
        /// on this RAW (an empty reference reports the embedded state). Null
        /// only when the native core itself is unavailable; a decode that
        /// already succeeded makes every other failure impossible here.</summary>
        public static LensProfileResolution? AssessForFile(string rawPath, string reference)
        {
            try { return Resolve(rawPath, reference); }
            catch (Exception error) when (error is LensProfileException or JsonException
                or KeyNotFoundException or DllNotFoundException or EntryPointNotFoundException)
            {
                DiagLog.Write($"[lens] assess {Path.GetFileName(rawPath)}: {error.Message}");
                return null;
            }
        }

        /// <summary>Forget every registered profile — what an isolated render
        /// worker does between jobs. The restore paths above re-register from
        /// the stored bytes on the next develop.</summary>
        public static void ClearNativeCache()
        {
            if (RawFfi.maple_lens_profile_clear_cache() != 0)
                throw new LensProfileException(RawFfi.LastError() ?? "The lens profile cache could not be cleared.");
        }

        private static LensProfileResolution Resolve(string rawPath, string reference) =>
            ParseResolution(ReadResult(
                RawFfi.maple_lens_profile_resolve_file(rawPath, reference, out var json), json));

        private static JsonElement Register(byte[] bytes) =>
            ReadResult(RawFfi.maple_lens_profile_register(bytes, (nuint)bytes.Length, out var json), json);

        private static JsonElement ReadResult(int code, IntPtr json)
        {
            try
            {
                if (code != 0)
                    throw new LensProfileException(RawFfi.LastError() ?? $"Lens profile call failed (rc={code}).");
                var text = Marshal.PtrToStringUTF8(json)
                    ?? throw new LensProfileException("The lens profile call returned no result.");
                using var document = JsonDocument.Parse(text);
                return document.RootElement.Clone();
            }
            finally { RawFfi.maple_free_lens_profile_json(json); }
        }

        /// <summary>The `resolve_file` JSON shape (raw-core `Resolution::metadata`
        /// plus the embedded/none synthesis in raw-ffi) into the shell's record.</summary>
        public static LensProfileResolution ParseResolution(JsonElement result)
        {
            static IReadOnlyList<string> Strings(JsonElement e, string key) =>
                e.TryGetProperty(key, out var array) && array.ValueKind == JsonValueKind.Array
                    ? array.EnumerateArray().Select(v => v.GetString() ?? "").ToArray()
                    : Array.Empty<string>();
            static double? Number(JsonElement e, string key) =>
                e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
            var samples = new List<LensProfileSample>();
            foreach (var family in new[] { "distortion", "ca", "vignetting" })
            {
                if (!result.TryGetProperty(family, out var entries) || entries.ValueKind != JsonValueKind.Array)
                    continue;
                samples.AddRange(entries.EnumerateArray().Select(s => new LensProfileSample(
                    family, Number(s, "focalMm") ?? 0, Number(s, "apertureApex"), Number(s, "focusM"),
                    Number(s, "weight") ?? 0)));
            }
            return new LensProfileResolution(
                Text(result, "source"), Text(result, "confidence"),
                result.GetProperty("hasDistortion").GetBoolean(),
                result.GetProperty("hasCa").GetBoolean(),
                result.GetProperty("hasVignetting").GetBoolean(),
                Strings(result, "approximations"), Strings(result, "unsupported"), samples);
        }

        private static string Text(JsonElement element, string key) =>
            element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? "" : "";

        private static byte[] ReadBounded(string path)
        {
            using var input = File.OpenRead(path);
            if (input.Length == 0 || input.Length > MaximumBytes)
                throw new LensProfileException("A lens profile must be between 1 byte and 32 MiB.");
            var bytes = new byte[checked((int)input.Length)];
            input.ReadExactly(bytes);
            return bytes;
        }

        /// <summary>Write-then-rename so a crash mid-write never leaves a
        /// half profile under a digest that claims to name exact bytes.</summary>
        private static void Persist(byte[] bytes, string destination)
        {
            Directory.CreateDirectory(DirectoryPath);
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(temporary, bytes);
                File.Move(temporary, destination, overwrite: true);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }
}
