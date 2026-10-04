using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task<string> PrepareShellVisualLibraryAsync(string raw, string output)
    {
        var directory = Path.Combine(output, "visual-library");
        if (Directory.Exists(directory))
            throw new InvalidOperationException("Shell visual qualification requires a fresh library directory.");
        var paths = await Task.Run(() =>
        {
            Directory.CreateDirectory(directory);
            var sourceHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(raw)));
            var sourceSidecar = Services.Xmp.SidecarStore.SidecarPathFor(raw);
            var sourceSidecarHash = SidecarHash(raw);
            var files = Enumerable.Range(0, 64).Select(index =>
            {
                var path = Path.Combine(directory, $"Photo-{index:D3}.dng");
                File.Copy(raw, path);
                // Rich inspector qualification must start with its real sidecar,
                // before the production watcher and document snapshot are active.
                if (sourceSidecarHash != "absent")
                    File.Copy(sourceSidecar, Services.Xmp.SidecarStore.SidecarPathFor(path));
                if (SidecarHash(path) != sourceSidecarHash)
                    throw new InvalidOperationException("Visual fixture sidecar differs from its source snapshot.");
                return path;
            }).ToArray();
            File.WriteAllText(Path.Combine(output, "visual-library.json"), JsonSerializer.Serialize(new
            {
                sourceHash,
                sourceSidecarHash,
                fileCount = files.Length,
                files = files.Select(path => new
                {
                    name = Path.GetFileName(path),
                    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))),
                    sidecarSha256 = SidecarHash(path)
                })
            }));
            return files;

            static string SidecarHash(string photo)
            {
                var sidecar = Services.Xmp.SidecarStore.SidecarPathFor(photo);
                return File.Exists(sidecar)
                    ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sidecar))) : "absent";
            }
        });
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
