using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano
{
    /// <summary>
    /// Pano ML provisioning for Windows (#2583) — the PanoProvisioner /
    /// PanoProvisionManifest equivalent from the Apple shell. Two artifact
    /// sets, both pinned:
    ///  - the ALIKED + LightGlue ONNX models (URLs + SHA-256 from
    ///    src/raw-pipeline/maple-pano/models.toml — maple-cli re-verifies the
    ///    same hashes before every stitch), and
    ///  - the ONNX Runtime 1.23.2 win-x64 dylib from the official Microsoft
    ///    release (the repo pins no Windows zip hash; maple-cli's libloading
    ///    preflight rejects any dll below ORT API 1.22, which is the guard).
    /// Defaults live under %LOCALAPPDATA%\Maple, overridable via AppSettings.
    /// </summary>
    public sealed class PanoProvisioner
    {
        private sealed record ModelPin(string FileName, string Url, long Size, string Sha256);

        // Mirrors maple-pano/models.toml exactly.
        private static readonly ModelPin[] Models =
        {
            new("aliked-n16rot-top2k-1280.onnx",
                "https://raw.githubusercontent.com/ikeboo/ALIKED-LightGlue-ONNX/77f70ddb0ee16690b674b76e7e0f5fb7c1c0e70a/onnx/aliked-n16rot-top2k-1280.onnx",
                13021915,
                "e3caf45d4ffcae936b10772ca2466365bfc863f7e119a8d19bc55529beace7d4"),
            new("lightglue_for_aliked.onnx",
                "https://raw.githubusercontent.com/ikeboo/ALIKED-LightGlue-ONNX/77f70ddb0ee16690b674b76e7e0f5fb7c1c0e70a/onnx/lightglue_for_aliked.onnx",
                45844463,
                "33fffedd24f39f25b139fb66f9090481d276799cef7b0ea56eb6bc0986987c38"),
        };

        private const string OrtZipUrl =
            "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip";
        private const string OrtZipDllEntry = "onnxruntime-win-x64-1.23.2/lib/onnxruntime.dll";
        /// <summary>SHA-256 of the extracted 1.23.2 win-x64 onnxruntime.dll —
        /// the installed-artifact pin, mirroring Apple's installedSha256.
        /// Supply-chain guard for the user-writable install location; the CLI
        /// preflight additionally enforces the ORT API version at load.</summary>
        private const string OrtDllSha256 =
            "dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea";

        private static string MapleAppData => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple");

        public string ModelsDir { get; }
        public string OrtDylibPath { get; }
        public string? CliPath { get; }

        public PanoProvisioner(AppSettings settings)
        {
            ModelsDir = settings.PanoModelsDir
                ?? Path.Combine(MapleAppData, "pano-models");
            OrtDylibPath = settings.PanoOrtDylibPath
                ?? Path.Combine(MapleAppData, "ort", "onnxruntime.dll");
            CliPath = ResolveCliPath(settings.PanoCliPath);
        }

        /// <summary>maple-cli.exe: explicit setting → beside the app exe →
        /// the repo build output (developer convenience).</summary>
        private static string? ResolveCliPath(string? configured)
        {
            var candidates = new[]
            {
                configured,
                Path.Combine(AppContext.BaseDirectory, "maple-cli.exe"),
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
                    @"..\..\..\..\..\..\..\raw-pipeline\target\release\maple-cli.exe")),
            };
            return candidates.FirstOrDefault(p => p != null && File.Exists(p));
        }

        public bool CliPresent => CliPath != null;

        /// <summary>One provisioning check = ~180 MB of hashing, so it runs
        /// once per dialog on the thread pool and the result is reused.</summary>
        public sealed record ProvisionState(bool Cli, bool Models, bool Ort)
        {
            public bool IsProvisioned => Cli && Models && Ort;
            public string Summary =>
                $"maple-cli: {(Cli ? "ready" : "missing")} · " +
                $"models: {(Models ? "ready" : "missing")} · " +
                $"ONNX Runtime: {(Ort ? "ready" : "missing")}";
        }

        public Task<ProvisionState> CheckAsync() => Task.Run(
            () => new ProvisionState(CliPresent, ModelsVerified(), OrtVerified()));

        /// <summary>Present AND hash-verified — a same-size corrupted install
        /// must re-provision rather than fail later inside the stitch.
        /// Blocking I/O: call off the UI thread (CheckAsync).</summary>
        private bool OrtVerified() =>
            File.Exists(OrtDylibPath) && FileSha256(OrtDylibPath) == OrtDllSha256;

        private bool ModelsVerified() => Models.All(m =>
        {
            var path = Path.Combine(ModelsDir, m.FileName);
            return File.Exists(path)
                && new FileInfo(path).Length == m.Size
                && FileSha256(path) == m.Sha256;
        });

        private static string FileSha256(string path)
        {
            using var stream = File.OpenRead(path);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }

        /// <summary>Download whatever is missing (models SHA-256-verified
        /// against the repo pins; the ORT dll extracted from the official
        /// 1.23.2 release zip and pin-verified). ~180 MB on a cold machine.
        /// Blocking I/O + hashing: run on the thread pool.</summary>
        public async Task ProvisionAsync(Action<string> progress, CancellationToken ct)
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };

            if (!ModelsVerified())
            {
                Directory.CreateDirectory(ModelsDir);
                foreach (var model in Models)
                {
                    var path = Path.Combine(ModelsDir, model.FileName);
                    if (File.Exists(path) && new FileInfo(path).Length == model.Size
                        && FileSha256(path) == model.Sha256)
                        continue;
                    progress($"Downloading {model.FileName} ({model.Size / (1024 * 1024)} MB)…");
                    var bytes = await http.GetByteArrayAsync(model.Url, ct);
                    var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                    if (sha != model.Sha256)
                        throw new InvalidOperationException(
                            $"{model.FileName}: SHA-256 mismatch (got {sha}) — refusing to install.");
                    await File.WriteAllBytesAsync(path, bytes, ct);
                }
            }

            if (!OrtVerified())
            {
                progress("Downloading ONNX Runtime 1.23.2 (win-x64)…");
                Directory.CreateDirectory(Path.GetDirectoryName(OrtDylibPath)!);
                var zipPath = OrtDylibPath + ".zip.tmp";
                try
                {
                    // Download INSIDE the cleanup scope: a cancelled or failed
                    // transfer must not strand a 120 MB .zip.tmp on disk.
                    await using (var body = await http.GetStreamAsync(OrtZipUrl, ct))
                    await using (var file = File.Create(zipPath))
                    {
                        await body.CopyToAsync(file, ct);
                    }
                    progress("Extracting onnxruntime.dll…");
                    using var zip = ZipFile.OpenRead(zipPath);
                    var entry = zip.GetEntry(OrtZipDllEntry)
                        ?? throw new InvalidOperationException(
                            $"ORT zip is missing {OrtZipDllEntry}.");
                    entry.ExtractToFile(OrtDylibPath, overwrite: true);
                    var sha = FileSha256(OrtDylibPath);
                    if (sha != OrtDllSha256)
                    {
                        File.Delete(OrtDylibPath);
                        throw new InvalidOperationException(
                            $"onnxruntime.dll SHA-256 mismatch (got {sha}) — refusing to install.");
                    }
                }
                finally
                {
                    try { File.Delete(zipPath); } catch { /* best effort */ }
                }
            }
            progress("Pano runtime ready.");
        }
    }
}
