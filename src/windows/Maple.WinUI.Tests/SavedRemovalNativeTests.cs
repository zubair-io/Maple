// #1472: shipping C# decode/chain + actual Rust, RAW, XMP and companions.
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Generated;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class SavedRemovalNativeTests(ITestOutputHelper output) : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "maple-windows-removal-" + Guid.NewGuid().ToString("N"));
    private static string Fixture => Path.Combine(AppContext.BaseDirectory, "Fixtures", "removal");
    private string Raw => Path.Combine(root, "photo.dng");
    private string Sidecar => SidecarStore.SidecarPathFor(Raw);

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }

    private bool Stage()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: native saved-removal consumers require MAPLE_RAW_FFI_DLL.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        Directory.CreateDirectory(Path.Combine(root, ".maple", "inpaint"));
        File.Copy(Path.Combine(Fixture, "source.dng"), Raw);
        var description = XElement.Parse(File.ReadAllText(Path.Combine(Fixture, "saved.xmp")));
        var xml = new XElement(XNamespace.Get(XmpSchema.RdfNs) + "RDF", description).ToString();
        File.WriteAllText(Sidecar, xml);
        using var records = JsonDocument.Parse(description.Attribute(XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals")!.Value);
        var record = records.RootElement[0];
        var mask = record.GetProperty("accepted").GetProperty("mask").GetString()![7..];
        var patch = record.GetProperty("patch").GetString()![7..];
        File.Copy(Path.Combine(Fixture, "mask.mimf"), Path.Combine(root, ".maple", "inpaint", mask + ".mask"));
        File.Copy(Path.Combine(Fixture, "patch.f16"), Path.Combine(root, ".maple", "inpaint", patch + ".f16"));
        return true;
    }

    private unsafe float[] ReferenceScene(XmpSidecarDocument document, int cap)
    {
        var snapshot = Path.Combine(root, "reference.xmp");
        File.WriteAllText(snapshot, XmpWriter.Serialize(document));
        var buffer = new MapleSceneLinearBufferF32();
        var rc = RawFfi.maple_render_file_scene_linear_sized_f32(Raw, snapshot, (uint)cap, 1, IntPtr.Zero, &buffer);
        Assert.True(rc == 0, RawFfi.LastError());
        try { return new ReadOnlySpan<float>(buffer.f32_rgba, checked((int)(buffer.width * buffer.height * 4))).ToArray(); }
        finally { RawFfi.maple_free_scene_linear_buffer_f32(&buffer); }
    }

    [Theory]
    [InlineData(16)]
    [InlineData(4)]
    public void Live_decode_preserves_the_verified_saved_scene_at_native_and_preview_sizes(int cap)
    {
        if (!Stage()) return;
        var doc = SidecarStore.Load(Raw)!;
        doc.Adjustments.Profile = ProfileMode.Neutral;
        doc.Adjustments.AutoExposure = ToggleMode.Off;
        doc.Adjustments.Exposure = 1.25;
        var model = doc.Adjustments.Clone();
        doc.Adjustments = RenderEngine.StripChainStages(model);
        var expected = ReferenceScene(doc, cap);
        var actual = RenderEngine.Decode(Raw, model, cap, 1, IntPtr.Zero);
        Assert.Equal(expected, actual.Pixels);
        Assert.Contains(actual.Pixels, value => value > 1f);
        Assert.Equal(File.ReadAllBytes(Path.Combine(Fixture, "source.dng")), File.ReadAllBytes(Raw));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("corrupt")]
    [InlineData("source")]
    [InlineData("future")]
    public void Incomplete_saved_edits_refuse_live_decode_instead_of_showing_original_pixels(string failure)
    {
        if (!Stage()) return;
        var doc = SidecarStore.Load(Raw)!;
        var patch = Directory.GetFiles(Path.Combine(root, ".maple", "inpaint"), "*.f16").Single();
        switch (failure)
        {
            case "missing": File.Delete(patch); break;
            case "corrupt": File.WriteAllBytes(patch, new byte[] { 0, 1 }); break;
            case "source":
                var bytes = File.ReadAllBytes(Raw);
                bytes[^1] ^= 1;
                File.WriteAllBytes(Raw, bytes);
                break;
            case "future":
                doc.Adjustments.InpaintRemovals = doc.Adjustments.InpaintRemovals!.Replace("\"schema\":4", "\"schema\":99");
                File.WriteAllText(Sidecar, XmpWriter.Serialize(doc));
                break;
        }
        Assert.Throws<InvalidOperationException>(() => RenderEngine.Decode(Raw, doc.Adjustments, 16, 1, IntPtr.Zero));
    }

    [Fact]
    public void Scalar_ticks_reuse_the_prepared_saved_scene_without_companion_io()
    {
        if (!Stage()) return;
        var model = SidecarStore.Load(Raw)!.Adjustments;
        model.Profile = ProfileMode.Neutral;
        var image = RenderEngine.Decode(Raw, model, 16, 1, IntPtr.Zero);
        var beforePixels = (float[])image.Pixels.Clone();
        var beforeXml = File.ReadAllText(Sidecar);
        var first = new byte[image.Width * image.Height * 4];
        var second = new byte[first.Length];
        float[]? scratch = null;
        RenderEngine.RenderTick(image, model, ref scratch, first);
        var priorScratch = scratch;
        Directory.Delete(Path.Combine(root, ".maple", "inpaint"), recursive: true);
        model.Exposure = 2;
        RenderEngine.RenderTick(image, model, ref scratch, second);
        Assert.Same(priorScratch, scratch);
        Assert.False(first.SequenceEqual(second));
        Assert.Equal(beforePixels, image.Pixels);
        Assert.Equal(beforeXml, File.ReadAllText(Sidecar));
        Assert.Equal(File.ReadAllBytes(Path.Combine(Fixture, "source.dng")), File.ReadAllBytes(Raw));
    }

    [Theory]
    [InlineData(false, false, "http://ns.justmaple.app/photo/1.0/")]
    [InlineData(true, false, "http://ns.justmaple.app/1.0/")]
    [InlineData(false, true, "http://ns.justmaple.app/1.0/")]
    [InlineData(true, true, "http://ns.justmaple.app/photo/1.0/")]
    public void Actual_decode_accepts_scalar_and_secondary_RDF_payloads(bool scalar, bool secondary, string uri)
    {
        if (!Stage()) return;
        var model = SidecarStore.Load(Raw)!.Adjustments;
        var expected = RenderEngine.Decode(Raw, model, 16, 1, IntPtr.Zero).Pixels;
        var xml = XDocument.Parse(File.ReadAllText(Sidecar));
        var description = xml.Descendants(XNamespace.Get(XmpSchema.RdfNs) + "Description").Single();
        description.Attribute(XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals")!.Remove();
        var owner = secondary ? new XElement(description.Name) : description;
        if (secondary) description.Parent!.Add(owner);
        var name = XNamespace.Get(uri) + "InpaintRemovals";
        if (scalar) owner.Add(new XElement(name, new XCData(model.InpaintRemovals!)));
        else owner.SetAttributeValue(name, model.InpaintRemovals);
        File.WriteAllText(Sidecar, xml.ToString());
        var parsed = SidecarStore.Load(Raw)!;
        Assert.Equal(model.InpaintRemovals, parsed.Adjustments.InpaintRemovals);
        Assert.Equal(expected, RenderEngine.Decode(Raw, parsed.Adjustments, 16, 1, IntPtr.Zero).Pixels);
        SidecarStore.Save(Raw, parsed);
        Assert.Equal(expected, RenderEngine.Decode(Raw, SidecarStore.Load(Raw)!.Adjustments, 16, 1, IntPtr.Zero).Pixels);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("nested")]
    [InlineData("stale")]
    [InlineData("malformed")]
    public void Decode_refuses_an_invalid_or_newer_on_disk_stack_even_with_an_original_only_model(string kind)
    {
        if (!Stage()) return;
        var xml = XDocument.Parse(File.ReadAllText(Sidecar));
        var description = xml.Descendants(XNamespace.Get(XmpSchema.RdfNs) + "Description").Single();
        var name = XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals";
        if (kind == "duplicate") description.Add(new XElement(name, "[]"));
        if (kind == "nested")
        {
            description.Attribute(name)!.Remove();
            description.Add(new XElement(name, new XElement("payload", "[]")));
        }
        File.WriteAllText(Sidecar, kind == "malformed" ? "<invalid" : xml.ToString());
        var before = File.ReadAllText(Sidecar);
        Assert.Throws<InvalidOperationException>(() => RenderEngine.Decode(Raw, new AdjustmentState(), 16, 1, IntPtr.Zero));
        Assert.Equal(before, File.ReadAllText(Sidecar));
    }

    private ExportRecipe Recipe(string format) => new()
    {
        SchemaVersion = 1, Name = "Saved removal", Format = format,
        Quality = format == "jpeg" ? 85u : format == "avif" ? 55u : null,
        BitDepth = format == "tiff" ? 16u : 8u, MaxLongEdge = null,
        OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
        NamingTemplate = "{original}.{ext}", Destination = "directory", Directory = root,
        Watermark = null, OverwritePolicy = "error",
    };

    [Theory]
    [InlineData("png")]
    [InlineData("jpeg")]
    [InlineData("tiff")]
    [InlineData("avif")]
    public async Task Actual_native_queue_exports_saved_snapshots_and_refuses_missing_assets(string format)
    {
        if (!Stage()) return;
        var priorXml = File.ReadAllText(Sidecar);
        var doc = SidecarStore.Load(Raw)!;
        var snapshot = ExportSnapshot.Serialize(priorXml, doc.Adjustments);
        var runner = new ExportQueueRunner(new ExportQueueStore(Path.Combine(root, "ledger")), new NativeExportRecipeExecutor());
        var savedJob = runner.Create(Recipe(format), new[] { new ExportInput(Raw, snapshot, "saved", null) }, Array.Empty<string>());
        var saved = await runner.RunAsync(savedJob.Id, false, CancellationToken.None);
        Assert.Equal("applied", saved.Entries[0].Status);
        var savedBytes = File.ReadAllBytes(saved.Entries[0].OutputPath);
        // Diagnostic control: pass original-only parameters directly to the
        // native executor; do not modify the source sidecar to create it.
        doc.Adjustments.InpaintRemovals = null;
        var controlJob = runner.Create(Recipe(format), new[] { new ExportInput(Raw, XmpWriter.Serialize(doc), "control", null) }, Array.Empty<string>());
        var control = await runner.RunAsync(controlJob.Id, false, CancellationToken.None);
        Assert.Equal("applied", control.Entries[0].Status);
        Assert.False(savedBytes.SequenceEqual(File.ReadAllBytes(control.Entries[0].OutputPath)));
        File.Delete(Directory.GetFiles(Path.Combine(root, ".maple", "inpaint"), "*.f16").Single());
        var missingJob = runner.Create(Recipe(format), new[] { new ExportInput(Raw, snapshot, "incomplete", null) }, Array.Empty<string>());
        var missing = await runner.RunAsync(missingJob.Id, false, CancellationToken.None);
        Assert.Equal("failed", missing.Entries[0].Status);
        Assert.False(File.Exists(missing.Entries[0].OutputPath));
        Assert.False(File.Exists(missing.Entries[0].TempPath));
        Assert.Equal(priorXml, File.ReadAllText(Sidecar));
        Assert.Equal(File.ReadAllBytes(Path.Combine(Fixture, "source.dng")), File.ReadAllBytes(Raw));
    }

    [Fact]
    public void Cold_saved_derivative_keeps_prior_output_when_a_companion_is_lost()
    {
        if (!Stage()) return;
        var priorXml = File.ReadAllText(Sidecar);
        var cached = Path.Combine(root, "preview.jpg");
        Assert.Equal(0, ThumbnailRenderer.Render(Raw, cached, 2560, avif: false));
        var before = File.ReadAllBytes(cached);
        File.Delete(Directory.GetFiles(Path.Combine(root, ".maple", "inpaint"), "*.f16").Single());
        Assert.NotEqual(0, ThumbnailRenderer.Render(Raw, cached, 2560, avif: false));
        Assert.Equal(before, File.ReadAllBytes(cached));
        Assert.Equal(priorXml, File.ReadAllText(Sidecar));
        Assert.Equal(File.ReadAllBytes(Path.Combine(Fixture, "source.dng")), File.ReadAllBytes(Raw));
        Assert.Empty(Directory.GetFiles(root, "*.tmp.develop.*"));
    }
}
