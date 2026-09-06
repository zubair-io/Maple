using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class ExportLensProfileNativeTests(ITestOutputHelper output)
{
    private const string ChildEnvironment = "MAPLE_LCP_EXPORT_CHILD_STATE";
    private sealed record ColdJob(string Ledger, string JobId, string Source, string Reference, string Evidence);

    private bool NativeAvailable()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL not set; native optical export was not exercised.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    private static string CachePath(string reference) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "LensProfiles", LensProfileStore.Digest(reference) + ".lcp");

    [Fact]
    public async Task Queued_missing_enabled_profile_fails_but_disabled_or_zero_strengths_export()
    {
        if (!NativeAvailable()) return;
        using var fixture = new ExportLensProfileFixture();
        var reference = "lcp1:" + Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        Assert.False(File.Exists(CachePath(reference)));
        var originalHash = ExportPaths.Hash(fixture.RawPath);
        var models = new[]
        {
            new AdjustmentState { LensProfile = reference },
            new AdjustmentState { LensProfile = reference, LensProfileEnable = ToggleMode.Off },
            new AdjustmentState { LensProfile = reference, LensCorrectionDistortion = 0, LensCorrectionCa = 0, LensCorrectionVignetting = 0 },
        };
        for (var i = 0; i < models.Length; i++)
        {
            var queued = fixture.Queue("case-" + i, models[i]);
            var result = await fixture.Runner.RunAsync(queued.Id, false, CancellationToken.None);
            var item = Assert.Single(result.Entries);
            Assert.Equal(i == 0 ? "failed" : "applied", item.Status);
            if (i == 0)
            {
                Assert.Contains("selected lens profile is missing", item.Reason);
                Assert.False(File.Exists(item.OutputPath));
            }
            else AssertPng(item.OutputPath);
            Assert.False(File.Exists(item.TempPath));
            Assert.Equal(item.Status, fixture.Store.Load(queued.Id).Entries[0].Status);
        }
        Assert.Equal(originalHash, ExportPaths.Hash(fixture.RawPath));
        Assert.False(File.Exists(CachePath(reference)));
        output.WriteLine("Actual native queue: enabled missing LCP failed; disabled and all-zero corrections published PNGs; original unchanged.");
    }

    [Fact]
    public async Task Cold_process_restores_cached_profile_from_frozen_queue_after_sidecar_changes()
    {
        if (!NativeAvailable()) return;
        using var fixture = new ExportLensProfileFixture();
        var profile = ExportLensProfileFixture.Profile();
        var profilePath = Path.Combine(fixture.Root, "unique.lcp");
        File.WriteAllBytes(profilePath, profile);
        var reference = Register(profile);
        var cache = CachePath(reference);
        Assert.False(File.Exists(cache), "Never replace an existing user cache entry.");
        try
        {
            var imported = LensProfileStore.Import(profilePath, fixture.RawPath);
            Assert.Equal(reference, imported.Reference);
            Assert.Equal(profile, File.ReadAllBytes(cache));
            var enabled = new AdjustmentState { LensProfile = reference };
            SidecarStore.Save(fixture.RawPath, new XmpSidecarDocument { Adjustments = enabled });
            var frozen = ExportSnapshot.Serialize(File.ReadAllText(SidecarStore.SidecarPathFor(fixture.RawPath)));
            var queued = fixture.Runner.Create(fixture.Recipe,
                new[] { new ExportInput(fixture.RawPath, frozen, "corrected", null) }, new[] { fixture.RawPath });
            var originalHash = ExportPaths.Hash(fixture.RawPath);

            // A later sidecar edit disables the correction. It must not alter
            // the already persisted queue's exact enabled profile reference.
            var disabled = new AdjustmentState { LensProfile = reference, LensProfileEnable = ToggleMode.Off };
            SidecarStore.Save(fixture.RawPath, new XmpSidecarDocument { Adjustments = disabled });
            var baseline = fixture.Queue("disabled", disabled);
            Assert.Equal("applied", (await fixture.Runner.RunAsync(baseline.Id, false, CancellationToken.None)).Entries[0].Status);

            var evidence = Path.Combine(fixture.Root, "child-evidence.json");
            await RunColdProcess(new ColdJob(fixture.Ledger, queued.Id, fixture.RawPath, reference, evidence), fixture.Root);
            using var child = JsonDocument.Parse(File.ReadAllText(evidence));
            Assert.NotEqual(Environment.ProcessId, child.RootElement.GetProperty("processId").GetInt32());
            Assert.True(child.RootElement.GetProperty("coldBefore").GetBoolean());
            Assert.True(child.RootElement.GetProperty("restoredAfter").GetBoolean());
            var published = fixture.Store.Load(queued.Id).Entries[0];
            Assert.Equal("applied", published.Status);
            Assert.Equal(frozen, published.Input.Xmp);
            AssertPng(published.OutputPath);
            Assert.NotEqual(ExportPaths.Hash(baseline.Entries[0].OutputPath), ExportPaths.Hash(published.OutputPath));
            Assert.False(File.Exists(published.TempPath));
            Assert.Equal(originalHash, ExportPaths.Hash(fixture.RawPath));
            Assert.Equal(profile, File.ReadAllBytes(cache));
            output.WriteLine("Actual fresh-process queue restored the exact cached LCP, kept frozen enabled XMP despite disabled sidecar, and published an encoded PNG differing from disabled baseline.");
        }
        finally
        {
            // Only this GUID-authored, previously absent digest is ours. If
            // anyone changed its bytes, preserve it and fail rather than delete.
            if (File.Exists(cache))
            {
                Assert.Equal(profile, File.ReadAllBytes(cache));
                File.Delete(cache);
            }
        }
    }

    [Fact]
    public async Task Cold_process_executes_the_queued_optical_snapshot()
    {
        var state = Environment.GetEnvironmentVariable(ChildEnvironment);
        if (string.IsNullOrEmpty(state))
        {
            output.WriteLine("Child-only fact; exercised by the fresh-process parent regression.");
            return;
        }
        Assert.True(NativeAvailable());
        var child = JsonSerializer.Deserialize<ColdJob>(File.ReadAllText(state))!;
        Assert.Null(LensProfileStore.AssessForFile(child.Source, child.Reference));
        Assert.Equal(ToggleMode.Off, SidecarStore.Load(child.Source)!.Adjustments.LensProfileEnable);
        var store = new ExportQueueStore(child.Ledger);
        var queuedModel = XmpParser.Parse(store.Load(child.JobId).Entries[0].Input.Xmp)!.Adjustments;
        Assert.Equal(child.Reference, queuedModel.LensProfile);
        Assert.Equal(ToggleMode.On, queuedModel.LensProfileEnable);
        var runner = new ExportQueueRunner(store, new NativeExportRecipeExecutor());
        var item = Assert.Single((await runner.RunAsync(child.JobId, false, CancellationToken.None)).Entries);
        Assert.True(item.Status == "applied", item.Reason);
        var facts = LensProfileStore.AssessForFile(child.Source, child.Reference);
        Assert.NotNull(facts);
        Assert.True(facts.Vignetting);
        File.WriteAllText(child.Evidence, JsonSerializer.Serialize(new { processId = Environment.ProcessId, coldBefore = true, restoredAfter = true }));
    }

    private static string Register(byte[] bytes)
    {
        var code = LensProfileNative.maple_lens_profile_register(bytes, (nuint)bytes.Length, out var json);
        try
        {
            Assert.Equal(0, code);
            using var document = JsonDocument.Parse(Marshal.PtrToStringUTF8(json)!);
            return document.RootElement.GetProperty("reference").GetString()!;
        }
        finally { LensProfileNative.maple_free_lens_profile_json(json); }
    }

    private async Task RunColdProcess(ColdJob child, string directory)
    {
        var state = Path.Combine(directory, "child-state.json");
        File.WriteAllText(state, JsonSerializer.Serialize(child));
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("vstest");
        start.ArgumentList.Add(typeof(ExportLensProfileNativeTests).Assembly.Location);
        start.ArgumentList.Add("/TestCaseFilter:FullyQualifiedName=Maple.WinUI.Tests.ExportLensProfileNativeTests.Cold_process_executes_the_queued_optical_snapshot");
        start.Environment[ChildEnvironment] = state;
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw; }
        var log = await stdout + await stderr;
        output.WriteLine(log);
        Assert.True(process.ExitCode == 0, log);
        Assert.True(File.Exists(child.Evidence), "The selected child fact must actually execute.");
    }

    private static void AssertPng(string path)
    {
        var bytes = File.ReadAllBytes(path);
        Assert.Equal(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, bytes[..8]);
        Assert.Contains("iCCP", Encoding.Latin1.GetString(bytes));
    }
}
