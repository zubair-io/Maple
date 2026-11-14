using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ImportedWhiteBalanceTests
{
    private static string Xml(string attributes) =>
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:WhiteBalance=\"Auto\" " + attributes + "/></rdf:RDF></x:xmpmeta>";

    [ImportedWhiteBalanceNativeFact]
    public async Task UnrelatedEditsWaitForPartialHydrationBeforeCentralRenderSubmission()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var raw = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var sidecar = Path.Combine(Path.GetTempPath(), $"maple-pending-render-{Guid.NewGuid():N}.xmp");
        try
        {
            foreach (var version in new[] { 1, 2, 3, 4, 5 })
            foreach (var axis in new[] { "crs:Temperature=\"5700\"", "crs:Tint=\"12\"" })
            {
                File.WriteAllText(sidecar, Xml(axis
                    + $" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"{version}\""));
                var model = XmpParser.Parse(File.ReadAllText(sidecar))!.Adjustments;
                var scheduler = new RenderScheduler();
                scheduler.RequestRender(new AdjustmentState());
                var previous = scheduler.Pending;
                using var running = new SemaphoreSlim(0);
                using var release = new ManualResetEventSlim(false);
                var estimates = new ImportedAutoEstimates((path, snapshot) =>
                {
                    running.Release();
                    release.Wait();
                    ImportedWhiteBalanceResolver.ResolveInPlace(path, snapshot);
                });
                estimates.Focus(raw);
                var pending = estimates.ResolveAsync(raw, model);
                try
                {
                    Assert.True(await running.WaitAsync(TimeSpan.FromSeconds(10)));
                    model.Exposure = 1.25;
                    scheduler.RequestRender(model.Clone());
                    model.Contrast = 17;
                    scheduler.RequestRender(model.Clone());
                    Assert.Same(previous, scheduler.Pending);
                    Assert.Equal(1, scheduler.DetailInvalidations);
                }
                finally { release.Set(); await pending; }
                Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(model, (await pending)!));
                scheduler.RequestRender(model.Clone());
                Assert.Equal(1.25, scheduler.Pending!.Exposure);
                Assert.Equal(17, scheduler.Pending.Contrast);
                Assert.Equal(5, scheduler.Pending.WhiteBalanceScaleVersion);
                Assert.NotNull(scheduler.Pending.ImportedWhiteBalance!.Resolved);
                Assert.Equal(2, scheduler.DetailInvalidations);
            }
            // Name-only Auto still presents its As Shot first frame.
            var auto = new RenderScheduler();
            auto.RequestRender(XmpParser.Parse(Xml(""))!.Adjustments);
            Assert.NotNull(auto.Pending);
        }
        finally { File.Delete(sidecar); }
    }

    [ImportedWhiteBalanceNativeFact]
    public async Task PendingPartialHydrationRejectsSliderWritesResetsAndCommits()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var raw = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var sidecar = Path.Combine(Path.GetTempPath(), $"maple-pending-wb-{Guid.NewGuid():N}.xmp");
        try
        {
            foreach (var version in new[] { 1, 2, 3, 4, 5 })
            foreach (var temperature in new[] { true, false })
            foreach (var deferred in new[] { true, false })
            {
                File.WriteAllText(sidecar, Xml((temperature ? "crs:Tint=\"12\"" : "crs:Temperature=\"5700\"")
                    + $" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"{version}\""));
                var document = XmpParser.Parse(File.ReadAllText(sidecar))!;
                var session = new EditSessionViewModel();
                var slider = new AdjustmentSliderViewModel(session, temperature ? "Temp" : "Tint",
                    temperature ? 2000 : -150, temperature ? 12000 : 150, 1,
                    temperature ? m => m.Temperature : m => m.Tint,
                    temperature ? WhiteBalanceProvenance.SetManualTemperature : WhiteBalanceProvenance.SetManualTint,
                    commitOnRelease: deferred);
                // A sidecar reload can interrupt a parked gesture on the prior model.
                if (deferred) slider.Value = temperature ? 6200 : 20;
                session.Adjustments = document.Adjustments;
                slider.IsEnabled = WhiteBalanceProvenance.CanEdit(session.Adjustments);
                slider.SyncFromModel();
                Assert.False(slider.IsEnabled);
                var untouched = XmpWriter.Serialize(document);
                using var running = new SemaphoreSlim(0);
                using var release = new ManualResetEventSlim(false);
                var estimates = new ImportedAutoEstimates((path, model) =>
                {
                    running.Release();
                    release.Wait();
                    ImportedWhiteBalanceResolver.ResolveInPlace(path, model);
                });
                estimates.Focus(raw);
                var pending = estimates.ResolveAsync(raw, session.Adjustments);
                try
                {
                    Assert.True(await running.WaitAsync(TimeSpan.FromSeconds(10)));
                    slider.Value = temperature ? 7000 : 30;
                    slider.CommitDeferred();
                    slider.Reset();
                    slider.ResetModelValue(session.Adjustments);
                    Assert.Equal(0, session.Commits);
                    Assert.Equal(untouched, XmpWriter.Serialize(document));
                    Assert.False(WhiteBalanceProvenance.CanEdit(session.Adjustments));
                }
                finally { release.Set(); await pending; }
                Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(session.Adjustments, (await pending)!));
                slider.IsEnabled = WhiteBalanceProvenance.CanEdit(session.Adjustments);
                slider.SyncFromModel();
                Assert.True(slider.IsEnabled);
                var otherAxis = temperature ? session.Adjustments.Tint : session.Adjustments.Temperature;
                slider.Value += temperature ? 100 : 1;
                slider.CommitDeferred();
                Assert.Equal(1, session.Commits);
                Assert.Null(session.Adjustments.ImportedWhiteBalance);
                Assert.Equal(5, session.Adjustments.WhiteBalanceScaleVersion);
                Assert.Equal(otherAxis, temperature ? session.Adjustments.Tint : session.Adjustments.Temperature);
                File.WriteAllText(sidecar, XmpWriter.Serialize(document));
                var saved = XmpParser.Parse(File.ReadAllText(sidecar))!.Adjustments;
                Assert.InRange(Math.Abs(session.Adjustments.Temperature - saved.Temperature), 0, 0.005);
                Assert.InRange(Math.Abs(session.Adjustments.Tint - saved.Tint), 0, 0.005);
            }
        }
        finally { File.Delete(sidecar); }
    }

    [ImportedWhiteBalanceNativeFact]
    public async Task ExternalSingleAxisSidecarReloadResolvesWithoutRedecodingTheBase()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var raw = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var sidecar = Path.Combine(Path.GetTempPath(), $"maple-reload-wb-{Guid.NewGuid():N}.xmp");
        try
        {
            foreach (var version in new[] { 1, 2, 3, 4, 5 })
            foreach (var axis in new[] { "crs:Temperature=\"5700\"", "crs:Tint=\"12\"" })
            {
                File.WriteAllText(sidecar, Xml(axis + $" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"{version}\""));
                var document = XmpParser.Parse(File.ReadAllText(sidecar))!;
                var model = document.Adjustments;
                var intent = model.ImportedWhiteBalance;
                var before = model.Clone();
                before.ImportedWhiteBalance = null;
                before.Temperature = 4800;
                before.Tint = 3;
                Assert.False(RenderEngine.DecodeInputsChanged(before, model));
                Assert.True(ImportedAutoEstimates.StartsWithoutDecode(before, model));
                var expected = model.Clone();
                ImportedWhiteBalanceResolver.ResolveInPlace(raw, expected);
                var estimates = new ImportedAutoEstimates(ImportedWhiteBalanceResolver.ResolveInPlace);
                estimates.Focus(raw);
                var resolved = await estimates.ResolveAsync(raw, model);
                Assert.NotNull(resolved);
                Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(model, resolved!));
                Assert.Equal((expected.Temperature, expected.Tint), (model.Temperature, model.Tint));
                Assert.Equal(5, model.WhiteBalanceScaleVersion);
                Assert.False(ImportedAutoEstimates.StartsWithoutDecode(before, model));
                model.Exposure = 1.25;
                File.WriteAllText(sidecar, XmpWriter.Serialize(document));
                Assert.Equal(intent, XmpParser.Parse(File.ReadAllText(sidecar))!.Adjustments.ImportedWhiteBalance);
            }
        }
        finally { File.Delete(sidecar); }
    }

    [ImportedWhiteBalanceNativeFact]
    public void NativeColdResolverMatchesTheSharedEstimatorAndCachesThePair()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var bytes = File.ReadAllBytes(source);
        var directory = Path.Combine(Path.GetTempPath(), $"maple-auto-wb-native-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "source.dng");
            var sidecar = Path.Combine(directory, "source.xmp");
            File.WriteAllBytes(raw, bytes);
            File.WriteAllText(sidecar, Xml(""));
            var doc = XmpParser.Parse(File.ReadAllText(sidecar))!;
            Assert.Equal(0, RawFfi.maple_compute_auto_adjustments(raw, null, 1, out var auto));
            ImportedWhiteBalanceResolver.ResolveInPlace(raw, doc.Adjustments);
            var (temperature, tint) = (doc.Adjustments.Temperature, doc.Adjustments.Tint);
            // The request and AUTO measure one light on two probes of the RAW. They
            // agree within the estimator's fixed-point tolerance (raw-core's corpus cell).
            Assert.InRange(Math.Abs(Math.Log2(temperature / auto.temperature)), 0, 0.03);
            Assert.InRange(Math.Abs(tint - auto.tint), 0, 1.5);
            Assert.Equal(WbSource.Auto, doc.Adjustments.WbSource);
            Assert.Equal(WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion, doc.Adjustments.WbAlgorithmVersion);
            Assert.Equal(0, doc.Adjustments.Exposure);
            Assert.Equal(bytes, File.ReadAllBytes(raw));
            Assert.Equal(Xml(""), File.ReadAllText(sidecar));
            // Reusing a resolved model must not open or estimate the RAW again.
            ImportedWhiteBalanceResolver.ResolveInPlace("/not-a-file.dng", doc.Adjustments);
            Assert.Equal((temperature, tint), (doc.Adjustments.Temperature, doc.Adjustments.Tint));
            // A fresh import of the same RAW resolves to the same pair.
            var again = XmpParser.Parse(Xml(""))!;
            ImportedWhiteBalanceResolver.ResolveInPlace(raw, again.Adjustments);
            Assert.Equal((temperature, tint), (again.Adjustments.Temperature, again.Adjustments.Tint));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("")]
    [InlineData("crs:Temperature=\"6500\"")]
    [InlineData("crs:Tint=\"0\"")]
    [InlineData("crs:Temperature=\"8500\"")]
    public void RealSidecarRetainsAbsentAxesAfterHydrationAndUnrelatedSave(string attributes)
    {
        var path = Path.Combine(Path.GetTempPath(), $"maple-imported-wb-{Guid.NewGuid():N}.xmp");
        try
        {
            File.WriteAllText(path, Xml(attributes));
            var doc = XmpParser.Parse(File.ReadAllText(path))!;
            var original = Assert.IsType<ImportedWhiteBalance>(doc.Adjustments.ImportedWhiteBalance);
            var source = doc.Adjustments.WbSource;
            var algorithm = doc.Adjustments.WbAlgorithmVersion;
            doc.Adjustments.ImportedWhiteBalance = original with { Resolved = new(5520, -43.79) };
            ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", doc.Adjustments);
            Assert.Equal(attributes.Length == 0 ? WbSource.Auto : source, doc.Adjustments.WbSource);
            Assert.Equal(attributes.Length == 0 ? WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion : algorithm,
                doc.Adjustments.WbAlgorithmVersion);
            doc.Adjustments.Exposure = 1.25;
            File.WriteAllText(path, XmpWriter.Serialize(doc));
            var saved = File.ReadAllText(path);
            Assert.Contains("crs:WhiteBalance=\"Auto\"", saved);
            if (original.Temperature == null) Assert.DoesNotContain("crs:Temperature=", saved);
            if (original.Tint == null) Assert.DoesNotContain("crs:Tint=", saved);
            if (attributes.Length > 0) Assert.Contains(attributes, saved);
            Assert.Equal(original, XmpParser.Parse(saved)!.Adjustments.ImportedWhiteBalance);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void ExplicitDefaultPairNeverBecomesAnUnresolvedAutoRequest()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"6500\" crs:Tint=\"0\""))!;
        Assert.Null(doc.Adjustments.ImportedWhiteBalance);
        var saved = XmpWriter.Serialize(doc);
        Assert.Contains("crs:Temperature=\"6500\"", saved);
        Assert.Contains("crs:Tint=\"0\"", saved);
        Assert.Null(XmpParser.Parse(saved)!.Adjustments.ImportedWhiteBalance);
    }

    [Fact]
    public void OnlyUnresolvedNameOnlyAutoIsDeferredPastTheFirstFrame()
    {
        var nameOnly = XmpParser.Parse(Xml(""))!.Adjustments;
        Assert.True(ImportedWhiteBalanceResolver.IsUnresolvedAuto(nameOnly));
        nameOnly.ImportedWhiteBalance = nameOnly.ImportedWhiteBalance! with { Resolved = new(4012.5, 16.25) };
        Assert.False(ImportedWhiteBalanceResolver.IsUnresolvedAuto(nameOnly));
        Assert.False(ImportedWhiteBalanceResolver.IsUnresolvedAuto(
            XmpParser.Parse(Xml("crs:Temperature=\"5700\""))!.Adjustments));
        Assert.False(ImportedWhiteBalanceResolver.IsUnresolvedAuto(new AdjustmentState()));
    }

    [Fact]
    public void EditingResolvedLegacyPartialPairWritesCurrentScaleAndUndoPreservesImportScale()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"5700\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"2\""))!;
        doc.Adjustments.ImportedWhiteBalance = doc.Adjustments.ImportedWhiteBalance! with { Resolved = new(5690, 12) };
        ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", doc.Adjustments);
        var undo = doc.Adjustments.Clone();
        WhiteBalanceProvenance.SetManualTint(doc.Adjustments, 19);
        Assert.Contains("papp:WbScaleVersion=\"5\"", XmpWriter.Serialize(doc));
        doc.Adjustments = undo;
        var restored = XmpWriter.Serialize(doc);
        Assert.Contains("papp:WbScaleVersion=\"2\"", restored);
        Assert.Contains("crs:Temperature=\"5700\"", restored);
        Assert.DoesNotContain("crs:Tint=", restored);
    }

    [Fact]
    public void CustomPreservesTheCurrentCoordinateScaleAndNewEstimatesReplaceIt()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"5700\" crs:Tint=\"12\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"1\""))!;
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(doc.Adjustments, "Custom"));
        Assert.Contains("papp:WbScaleVersion=\"1\"", XmpWriter.Serialize(doc));
        Assert.Equal((5700, 12), (doc.Adjustments.Temperature, doc.Adjustments.Tint));
        WhiteBalanceProvenance.SetManualTint(doc.Adjustments, 19);
        Assert.Contains("papp:WbScaleVersion=\"1\"", XmpWriter.Serialize(doc));
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(doc.Adjustments, "Daylight"));
        Assert.Contains("papp:WbScaleVersion=\"5\"", XmpWriter.Serialize(doc));
        doc.WbScaleVersion = 1;
        WhiteBalanceProvenance.MarkAuto(doc.Adjustments);
        Assert.Equal(5, doc.WbScaleVersion);
        doc.WbScaleVersion = 1;
        WhiteBalanceProvenance.ApplyAsShot(doc.Adjustments, 5200, 15);
        Assert.Equal(5, doc.WbScaleVersion);
    }

    [Fact]
    public void PublicationHydratesMatchingUndoSnapshotsAndPreservesInterveningEdits()
    {
        var original = XmpParser.Parse(Xml(""))!.Adjustments;
        var resolved = original.Clone();
        resolved.ImportedWhiteBalance = resolved.ImportedWhiteBalance! with { Resolved = new(5300, 17) };
        var undo = original.Clone();
        Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(undo, resolved));
        Assert.Equal((5300, 17), (undo.Temperature, undo.Tint));
        Assert.NotNull(undo.ImportedWhiteBalance);
        Assert.Equal(WbSource.Auto, undo.WbSource);
        Assert.Equal(WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion, undo.WbAlgorithmVersion);
        // Publishing again changes nothing, so it must not invalidate a Before view twice.
        Assert.False(ImportedWhiteBalanceResolver.ApplyResolved(undo, resolved));
        WhiteBalanceProvenance.SetManualTemperature(original, 4500);
        Assert.False(ImportedWhiteBalanceResolver.ApplyResolved(original, resolved));
        Assert.Equal(4500, original.Temperature);
        Assert.Null(original.ImportedWhiteBalance);
        var stripped = RenderEngine.StripChainStages(undo);
        Assert.Null(stripped.ImportedWhiteBalance);
        Assert.Equal("Custom", stripped.WhiteBalancePreset);
        Assert.Equal((6500, 0), (stripped.Temperature, stripped.Tint));
    }

    private static DecodedImage AsShotDecode(float temperature, float tint) => new()
    {
        Pixels = Array.Empty<float>(), Width = 0, Height = 0, NoiseProfile = Array.Empty<float>(),
        Iso = 100, AeGain = 1, WhitesAnchorEv = float.NaN,
        DecodedTemperature = temperature, DecodedTint = tint,
    };

    [Fact]
    public void SidecarDerivativesRenderTheImportedPairNeverTheDecodedAsShot()
    {
        // Thumbnails and persisted previews are final outputs (#4669): their model
        // takes the photo's resolved pair, not the decode's As Shot fallback.
        var nameOnly = XmpParser.Parse(Xml(""))!.Adjustments;
        nameOnly.ImportedWhiteBalance = nameOnly.ImportedWhiteBalance! with { Resolved = new(5300, 17) };
        ImportedWhiteBalanceResolver.PrepareDerivative("/no-analysis-required.dng", nameOnly, AsShotDecode(4800, 6));
        Assert.Equal((5300, 17), (nameOnly.Temperature, nameOnly.Tint));
        // Untouched sidecars keep the decoded As Shot pair; authored ones keep theirs.
        var untouched = new AdjustmentState();
        ImportedWhiteBalanceResolver.PrepareDerivative("/no-analysis-required.dng", untouched, AsShotDecode(4800, 6));
        Assert.Equal((4800, 6), (untouched.Temperature, untouched.Tint));
        var authored = XmpParser.Parse(Xml("crs:Temperature=\"7100\" crs:Tint=\"-4\""))!.Adjustments;
        ImportedWhiteBalanceResolver.PrepareDerivative("/no-analysis-required.dng", authored, AsShotDecode(4800, 6));
        Assert.Equal((7100, -4), (authored.Temperature, authored.Tint));
    }

    [ImportedWhiteBalanceNativeFact]
    public void ANameOnlySidecarDerivativeResolvesOnItsRawThroughTheSharedEstimator()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var raw = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var expected = XmpParser.Parse(Xml(""))!.Adjustments;
        ImportedWhiteBalanceResolver.ResolveInPlace(raw, expected);
        var model = XmpParser.Parse(Xml(""))!.Adjustments;
        var image = RenderEngine.Decode(raw, model, 256, RefineDecodeQuality.Preview, IntPtr.Zero);
        ImportedWhiteBalanceResolver.PrepareDerivative(raw, model, image);
        Assert.Equal((expected.Temperature, expected.Tint), (model.Temperature, model.Tint));
        Assert.NotEqual(image.DecodedTemperature, (float)model.Temperature);
    }

    [Fact]
    public void PastingANameOnlyAutoSourceCopiesTheRequestNeverAFabricatedOrStalePair()
    {
        // #4669: a name-only source has no numbers. Every target resolves its own Auto,
        // so neither the parse default (6500/0) nor a target's own import is authored.
        var source = XmpParser.Parse(Xml(""))!;
        var clipboard = new AdjustmentTransferSource(source.Adjustments, source.WbScaleVersion, null);
        var patch = AdjustmentTransfer.Build(clipboard, new[] { "white_balance" });
        foreach (var target in new[] { "crs:Temperature=\"4200\" crs:Tint=\"8\"", "crs:Temperature=\"5700\"" })
        {
            var document = XmpParser.Parse(Xml(target).Replace("crs:WhiteBalance=\"Auto\"", "crs:WhiteBalance=\"Custom\""))!;
            AdjustmentTransfer.Apply(document, patch);
            var saved = XmpWriter.Serialize(document);
            Assert.Contains("crs:WhiteBalance=\"Auto\"", saved);
            Assert.DoesNotContain("crs:Temperature=", saved);
            Assert.DoesNotContain("crs:Tint=", saved);
            Assert.True(ImportedWhiteBalanceResolver.IsUnresolvedAuto(XmpParser.Parse(saved)!.Adjustments));
        }
        // A numeric source replaces a target's partial import instead of being dropped.
        var numeric = XmpParser.Parse(Xml("crs:Temperature=\"5000\" crs:Tint=\"10\""))!;
        var numericPatch = AdjustmentTransfer.Build(
            new AdjustmentTransferSource(numeric.Adjustments, numeric.WbScaleVersion, null), new[] { "white_balance" });
        var partial = XmpParser.Parse(Xml("crs:Temperature=\"5700\""))!;
        AdjustmentTransfer.Apply(partial, numericPatch);
        var pasted = XmpWriter.Serialize(partial);
        Assert.Contains("crs:Temperature=\"5000\"", pasted);
        Assert.Contains("crs:Tint=\"10\"", pasted);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ResolvedNameOnlyAutoTransfersItsEstimatedDeltaRelativeToEachCamera(bool publishCached)
    {
        var source = XmpParser.Parse(Xml(""))!.Adjustments;
        var resolved = source.Clone();
        resolved.ImportedWhiteBalance = resolved.ImportedWhiteBalance! with { Resolved = new(5300, 17) };
        if (publishCached)
            Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(source, resolved));
        else
        {
            source = resolved;
            ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", source);
        }
        Assert.Equal(WbSource.Auto, source.WbSource);
        Assert.Equal(WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion, source.WbAlgorithmVersion);
        var clipboard = new AdjustmentTransferSource(source, 5, new(4800, 6));
        Assert.Equal(new WhiteBalanceBaseline(500, 11), AdjustmentTransfer.Correction(clipboard));
        var target = new XmpSidecarDocument();
        AdjustmentTransfer.Apply(target,
            AdjustmentTransfer.Build(clipboard, new[] { "white_balance" }, true, new(6000, -4)));
        Assert.Equal((6500, 7), (target.Adjustments.Temperature, target.Adjustments.Tint));
        Assert.Equal(WbSource.Manual, target.Adjustments.WbSource);
        var saved = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = source });
        Assert.Contains("crs:WhiteBalance=\"Auto\"", saved);
        Assert.DoesNotContain("crs:Temperature=", saved);
        Assert.DoesNotContain("crs:Tint=", saved);
    }

    [Theory]
    [InlineData("crs:Temperature=\"5700\"")]
    [InlineData("crs:Tint=\"12\"")]
    public void CachedSingleAxisHydrationPreservesExistingProvenance(string attributes)
    {
        var source = XmpParser.Parse(Xml(attributes))!.Adjustments;
        source.WbSource = WbSource.Manual;
        source.WbAlgorithmVersion = 2;
        var resolved = source.Clone();
        resolved.ImportedWhiteBalance = resolved.ImportedWhiteBalance! with { Resolved = new(5300, 17) };
        Assert.True(ImportedWhiteBalanceResolver.ApplyResolved(source, resolved));
        Assert.Equal(WbSource.Manual, source.WbSource);
        Assert.Equal(2, source.WbAlgorithmVersion);
        ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", source);
        Assert.Equal(WbSource.Manual, source.WbSource);
        Assert.Equal(2, source.WbAlgorithmVersion);
    }
}

public sealed class ImportedWhiteBalanceNativeFactAttribute : FactAttribute
{
    public ImportedWhiteBalanceNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
            Skip = "Requires the built Rust library through MAPLE_RAW_FFI_DLL.";
    }
}
