using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Maple.WinUI.Native;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    public sealed record LensProfileFacts(string Source, string Description, bool Distortion, bool Ca, bool Vignetting);

    public sealed record ImportedLensProfile(string Reference, string Name, string Description, bool Approximate, bool Embedded);

    /// <summary>User-owned profile bytes, addressed by the core's BLAKE3 digest.
    /// Files are cached outside the photo library; originals are never changed.</summary>
    public static class LensProfileStore
    {
        private const int MaximumBytes = 32 * 1024 * 1024;
        private static readonly string DirectoryPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "LensProfiles");

        internal static string Digest(string reference)
        {
            var match = Regex.Match(reference, "\\Alcp1(?:-ack)?:([0-9a-f]{64})\\z");
            if (!match.Success) throw new InvalidOperationException("Unsupported lens profile reference.");
            return match.Groups[1].Value;
        }

        private static JsonElement Register(byte[] bytes)
        {
            var code = LensProfileNative.maple_lens_profile_register(bytes, (nuint)bytes.Length, out var json);
            return ReadResult(code, json);
        }

        private static JsonElement ReadResult(int code, IntPtr json)
        {
            try
            {
                if (code != 0) throw new InvalidOperationException(RawFfi.LastError() ?? $"Lens profile failed (rc={code}).");
                using var document = JsonDocument.Parse(Marshal.PtrToStringUTF8(json) ?? throw new JsonException("Lens profile result missing."));
                return document.RootElement.Clone();
            }
            finally { LensProfileNative.maple_free_lens_profile_json(json); }
        }

        private static byte[] ReadBounded(string path)
        {
            using var input = File.OpenRead(path);
            if (input.Length > MaximumBytes) throw new InvalidOperationException("Lens profiles must be smaller than 32 MiB.");
            var bytes = new byte[checked((int)input.Length)];
            input.ReadExactly(bytes);
            return bytes;
        }

        public static ImportedLensProfile Import(string path, string rawPath)
        {
            var bytes = ReadBounded(path);
            var registered = Register(bytes);
            var reference = registered.GetProperty("reference").GetString()!;
            var resolved = Resolve(rawPath, reference);
            Directory.CreateDirectory(DirectoryPath);
            var destination = Path.Combine(DirectoryPath, Digest(reference) + ".lcp");
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { File.WriteAllBytes(temporary, bytes); File.Move(temporary, destination, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return new ImportedLensProfile(reference,
                registered.GetProperty("name").GetString() ?? registered.GetProperty("lens").GetString() ?? "Imported lens profile",
                Describe(resolved), resolved.GetProperty("confidence").GetString() == "approximate",
                resolved.GetProperty("source").GetString() == "embedded");
        }

        /// <summary>Before develop, determine embedded priority from the actual
        /// cached RAW. Only a file requiring the external profile reads its cache.</summary>
        public static void RestoreForFile(string rawPath, AdjustmentState model)
        {
            var reference = model.LensProfile;
            if (string.IsNullOrEmpty(reference) || model.LensProfileEnable == ToggleMode.Off
                || (model.LensCorrectionDistortion == 0 && model.LensCorrectionCa == 0 && model.LensCorrectionVignetting == 0)) return;
            // A warm profile or embedded OpcodeList3 needs no filesystem I/O.
            // This query uses the RAW itself and does not depend on optional
            // camera colour-support metadata being understood by this shell.
            try { Resolve(rawPath, reference); return; }
            catch (InvalidOperationException) { /* Restore exact cached bytes below. */ }
            var path = Path.Combine(DirectoryPath, Digest(reference) + ".lcp");
            if (!File.Exists(path)) throw new InvalidOperationException("The selected lens profile is missing from this device. Import the original LCP to restore this edit.");
            var registered = Register(ReadBounded(path));
            if (Digest(registered.GetProperty("reference").GetString()!) != Digest(reference))
                throw new InvalidOperationException("The cached lens profile does not match this edit. Import the original LCP.");
            Resolve(rawPath, reference);
        }

        private static JsonElement Resolve(string rawPath, string reference)
        {
            var code = LensProfileNative.maple_lens_profile_resolve_file(rawPath, reference, out var json);
            return ReadResult(code, json);
        }

        public static LensProfileFacts? AssessForFile(string rawPath, string reference)
        {
            try
            {
                var resolved = Resolve(rawPath, reference);
                return new LensProfileFacts(resolved.GetProperty("source").GetString() ?? "none", Describe(resolved), resolved.GetProperty("hasDistortion").GetBoolean(),
                    resolved.GetProperty("hasCa").GetBoolean(), resolved.GetProperty("hasVignetting").GetBoolean());
            }
            catch (Exception error) when (error is InvalidOperationException or JsonException
                or System.Collections.Generic.KeyNotFoundException or DllNotFoundException or EntryPointNotFoundException)
            { return null; }
        }

        private static string Describe(JsonElement result)
        {
            if (result.GetProperty("source").GetString() == "none") return "No lens correction data.";
            if (result.GetProperty("source").GetString() == "embedded") return "Embedded lens corrections take priority.";
            var text = new StringBuilder("Imported LCP: ").Append(result.GetProperty("confidence").GetString()).AppendLine();
            foreach (var key in new[] { "approximations", "unsupported" })
                foreach (var warning in result.GetProperty(key).EnumerateArray()) text.AppendLine(warning.GetString());
            foreach (var family in new[] { "distortion", "ca", "vignetting" })
                if (result.TryGetProperty(family, out var samples))
                    foreach (var sample in samples.EnumerateArray())
                        text.AppendLine($"{family}: {sample.GetProperty("focalMm").GetDouble():0.##} mm, weight {sample.GetProperty("weight").GetDouble():0.###}");
            return text.ToString().Trim();
        }
    }

    internal static class LensProfileNative
    {
        [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int maple_lens_profile_register(byte[] xml, nuint length, out IntPtr json);
        [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int maple_lens_profile_resolve_file([MarshalAs(UnmanagedType.LPUTF8Str)] string path,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string reference, out IntPtr json);
        [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void maple_free_lens_profile_json(IntPtr json);
    }
}
