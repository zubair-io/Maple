using System.Runtime.CompilerServices;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class ThumbnailRendererSidecarTests(ITestOutputHelper output)
{
    private const string Description = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" +
        "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" " +
        "xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" {0}/></rdf:RDF></x:xmpmeta>";
    private static readonly string MetadataOnly = string.Format(Description,
        "xmp:Rating=\"3\" xmp:Label=\"Red\" papp:Flag=\"pick\" papp:Profile=\"Auto\" crs:Version=\"11.0\" crs:HasSettings=\"True\"");
    private static readonly string Authored = string.Format(Description, "crs:Exposure2012=\"-2\"");
    private const string EmptyRdf = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/></x:xmpmeta>";

    private bool NativeUnavailable()
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
            return false;
        }
        output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL unset; the CI job supplies its real Rust library.");
        return true;
    }

    private static string NewDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "maple-thumb-sidecar-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    [Fact]
    public void Only_authored_adjustments_count_as_render_adjustments()
    {
        if (NativeUnavailable()) return;
        Assert.False(ThumbnailRenderer.HasRenderAdjustments(""));
        Assert.False(ThumbnailRenderer.HasRenderAdjustments(EmptyRdf));
        Assert.False(ThumbnailRenderer.HasRenderAdjustments(MetadataOnly));
        Assert.True(ThumbnailRenderer.HasRenderAdjustments(Authored));
        Assert.True(ThumbnailRenderer.HasRenderAdjustments(string.Format(Description, "papp:Profile=\"Neutral\"")));
        Assert.True(ThumbnailRenderer.HasRenderAdjustments("<broken"));
    }

    private static (int Rc, byte[]? Bytes) RenderBytes(string raw, string cached)
    {
        File.Delete(cached);
        var rc = ThumbnailRenderer.Render(raw, cached, 512, avif: true);
        return (rc, File.Exists(cached) ? File.ReadAllBytes(cached) : null);
    }

    [Theory]
    [InlineData("photo.dng", true)]
    [InlineData("photo.x3f", false)]
    public void Sidecars_without_render_adjustments_render_exactly_like_no_sidecar(string name, bool decodable)
    {
        if (NativeUnavailable()) return;
        var directory = NewDirectory();
        try
        {
            var raw = Path.Combine(directory, name);
            if (decodable) File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng"), raw);
            else File.WriteAllBytes(raw, new byte[4096]);
            var cached = Path.Combine(directory, "thumb.avif");
            var baseline = RenderBytes(raw, cached);
            var baselineError = RawFfi.LastError();
            var sidecar = SidecarStore.SidecarPathFor(raw);
            foreach (var content in new[] { "", EmptyRdf, MetadataOnly })
            {
                File.WriteAllText(sidecar, content);
                var result = RenderBytes(raw, cached);
                Assert.Equal(baseline.Rc, result.Rc);
                Assert.Equal(baseline.Bytes, result.Bytes);
                Assert.Equal(baselineError, RawFfi.LastError());
                Assert.Equal(content, File.ReadAllText(sidecar));
            }
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void Authored_edits_develop_on_a_supported_raw_instead_of_taking_the_camera_path()
    {
        if (NativeUnavailable()) return;
        var directory = NewDirectory();
        try
        {
            var raw = Path.Combine(directory, "photo.dng");
            File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng"), raw);
            var cached = Path.Combine(directory, "thumb.avif");
            Assert.NotEqual(0, RenderBytes(raw, cached).Rc);
            File.WriteAllText(SidecarStore.SidecarPathFor(raw), Authored);
            Assert.Equal(0, ThumbnailRenderer.Render(raw, cached, 512, avif: true));
            Assert.Equal("ftyp", System.Text.Encoding.ASCII.GetString(File.ReadAllBytes(cached), 4, 4));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void Authored_edits_on_an_undecodable_sensor_fail_closed_without_writing_a_derivative()
    {
        if (NativeUnavailable()) return;
        var directory = NewDirectory();
        try
        {
            var raw = Path.Combine(directory, "photo.x3f");
            File.WriteAllBytes(raw, new byte[4096]);
            var cached = Path.Combine(directory, "thumb.avif");
            File.WriteAllText(SidecarStore.SidecarPathFor(raw), Authored);
            Assert.NotEqual(0, ThumbnailRenderer.Render(raw, cached, 512, avif: true));
            Assert.False(File.Exists(cached));
            Assert.Empty(Directory.EnumerateFiles(directory, "*.tmp.develop.*"));
            Assert.Equal(Authored, File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public void Unedited_recovery_is_allowed_for_metadata_only_sidecars_and_refused_for_authored_ones()
    {
        if (NativeUnavailable()) return;
        var directory = NewDirectory();
        try
        {
            var raw = Path.Combine(directory, "photo.x3f");
            var sidecar = SidecarStore.SidecarPathFor(raw);
            File.WriteAllText(sidecar, MetadataOnly);
            Assert.True(ThumbnailRenderer.CanDevelopUneditedFallback(raw));
            File.WriteAllText(sidecar, Authored);
            Assert.False(ThumbnailRenderer.CanDevelopUneditedFallback(raw));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
