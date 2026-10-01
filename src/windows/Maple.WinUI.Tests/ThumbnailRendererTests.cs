using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class ThumbnailRendererTests(ITestOutputHelper output)
{
    private const string Edited = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" +
        "<rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"-2\"/></rdf:RDF>";
    private const string Film = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" +
        "<rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"-2\" " +
        "xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:FilmLook=\"black_white_ilford_delta_100\" papp:FilmStrength=\"100\"/></rdf:RDF>";

    [Fact]
    public void Cold_native_derivatives_honor_edits_film_and_invalid_sidecars()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL unset; the CI job supplies its real Rust library.");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var directory = Path.Combine(Path.GetTempPath(), "maple-thumb-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "photo.dng");
            File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng"), raw);
            var original = SHA256.HashData(File.ReadAllBytes(raw));
            var sidecar = SidecarStore.SidecarPathFor(raw);
            var cached = ThumbCachePaths.SharedThumbPathFor(raw);
            Directory.CreateDirectory(Path.GetDirectoryName(cached)!);
            File.WriteAllText(sidecar, "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description/></rdf:RDF>");
            var firstRc = ThumbnailRenderer.Render(raw, cached, 512, avif: true);
            Assert.True(firstRc == 0, Maple.WinUI.Native.RawFfi.LastError());
            var defaultBytes = File.ReadAllBytes(cached);
            Assert.Equal("ftyp", System.Text.Encoding.ASCII.GetString(defaultBytes, 4, 4));
            Assert.True(ThumbnailRenderer.IsFresh(cached, raw));

            File.WriteAllText(sidecar, Edited);
            File.SetLastWriteTimeUtc(sidecar, File.GetLastWriteTimeUtc(cached).AddSeconds(2));
            Assert.False(ThumbnailRenderer.IsFresh(cached, raw));
            Assert.Equal(0, ThumbnailRenderer.Render(raw, cached, 512, avif: true));
            var editedBytes = File.ReadAllBytes(cached);
            Assert.False(defaultBytes.SequenceEqual(editedBytes), "Exposure must change the developed thumbnail.");
            File.SetLastWriteTimeUtc(sidecar, File.GetLastWriteTimeUtc(cached).AddSeconds(-1));
            Assert.True(ThumbnailRenderer.IsFresh(cached, raw));

            File.WriteAllText(sidecar, Film);
            Assert.Equal(0, ThumbnailRenderer.Render(raw, cached, 512, avif: true));
            var filmBytes = File.ReadAllBytes(cached);
            Assert.False(editedBytes.SequenceEqual(filmBytes), "The bundled film LUT must affect actual encoded pixels.");
            Assert.Equal(Film, File.ReadAllText(sidecar));
            foreach (var invalid in new[] { "<broken", Film.Replace("black_white_ilford_delta_100", "missing_lut") })
            {
                File.WriteAllText(sidecar, invalid);
                Assert.NotEqual(0, ThumbnailRenderer.Render(raw, cached, 512, avif: true));
                Assert.Equal(filmBytes, File.ReadAllBytes(cached));
                Assert.Equal(invalid, File.ReadAllText(sidecar));
            }
            Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(raw)));
            Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(cached)!, "*.tmp.develop.*"));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void Freshness_checks_real_original_and_sidecar_times()
    {
        var directory = Path.Combine(Path.GetTempPath(), "maple-thumb-fresh-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "photo.dng");
            var cached = Path.Combine(directory, "thumb.avif");
            File.WriteAllText(raw, "original");
            Assert.False(ThumbnailRenderer.IsFresh(cached, raw));
            File.WriteAllText(cached, "cache");
            File.SetLastWriteTimeUtc(raw, DateTime.UtcNow.AddMinutes(-2));
            Assert.True(ThumbnailRenderer.IsFresh(cached, raw));
            File.WriteAllText(SidecarStore.SidecarPathFor(raw), Edited);
            File.SetLastWriteTimeUtc(SidecarStore.SidecarPathFor(raw), DateTime.UtcNow.AddMinutes(1));
            Assert.False(ThumbnailRenderer.IsFresh(cached, raw));
            File.Delete(SidecarStore.SidecarPathFor(raw));
            File.SetLastWriteTimeUtc(raw, DateTime.UtcNow.AddMinutes(1));
            Assert.False(ThumbnailRenderer.IsFresh(cached, raw));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
