using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private string? _shellVisualSourceSidecarHash;
    private string? ShellVisualMetadataFixture => _shellVisualSourceSidecarHash switch
    {
        null => null,
        "absent" => "sidecar-free",
        _ => "sidecar-backed",
    };

    private async Task<string> PrepareShellVisualLibraryAsync(string raw, string output)
    {
        var directory = Path.Combine(output, "visual-library");
        if (Directory.Exists(directory))
            throw new InvalidOperationException("Shell visual qualification requires a fresh library directory.");
        var library = await Task.Run(() =>
        {
            Directory.CreateDirectory(directory);
            var sourceHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(raw)));
            var sourceSidecar = SidecarStore.ReadSnapshot(raw);
            var sourceSidecarHash = SidecarStore.SnapshotHash(sourceSidecar);
            var files = Enumerable.Range(0, 64).Select(index =>
            {
                var path = Path.Combine(directory, $"Photo-{index:D3}.dng");
                File.Copy(raw, path);
                // Rich inspector qualification must start with its real sidecar,
                // before the production watcher and document snapshot are active.
                if (sourceSidecar != null)
                    File.WriteAllBytes(SidecarStore.SidecarPathFor(path), sourceSidecar);
                var sidecarHash = SidecarStore.SnapshotHash(SidecarStore.ReadSnapshot(path));
                if (sidecarHash != sourceSidecarHash)
                    throw new InvalidOperationException("Visual fixture sidecar differs from its source snapshot.");
                return (Path: path, SidecarHash: sidecarHash);
            }).ToArray();
            File.WriteAllText(Path.Combine(output, "visual-library.json"), JsonSerializer.Serialize(new
            {
                sourceHash,
                sourceSidecarHash,
                fileCount = files.Length,
                files = files.Select(file => new
                {
                    name = Path.GetFileName(file.Path),
                    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file.Path))),
                    sidecarSha256 = file.SidecarHash
                })
            }));
            return (Paths: files.Select(file => file.Path).ToArray(), SourceSidecarHash: sourceSidecarHash);
        });
        var paths = library.Paths;
        _shellVisualSourceSidecarHash = library.SourceSidecarHash;
        await ViewModel.LoadDirectoryAsync(directory);
        if (ViewModel.Photos.Count != paths.Length || ViewModel.Photos.Any(item => item.FileSizeBytes <= 0))
            throw new InvalidOperationException("Production folder scan did not load every visual fixture and its file metadata.");
        var deadline = Environment.TickCount64 + 90000;
        while (ViewModel.Photos.Any(item => item.ThumbnailPath == null))
        {
            if (Environment.TickCount64 >= deadline)
                throw new TimeoutException($"Visual library thumbnails incomplete: "
                    + $"{ViewModel.Photos.Count(item => item.ThumbnailPath != null)}/{paths.Length}");
            await Task.Delay(50);
        }
        return paths[0];
    }
}
