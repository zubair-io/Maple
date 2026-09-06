using Maple.WinUI.Generated;
using Maple.WinUI.Services.Export;
using System.Text.Json;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ExportQueueTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-export-tests-" + Guid.NewGuid().ToString("N"));
    private readonly ExportQueueStore _store;
    private readonly FakeExecutor _executor = new();
    private readonly ExportQueueRunner _runner;
    private readonly string _output;

    public ExportQueueTests()
    {
        Directory.CreateDirectory(_root);
        _output = Path.Combine(_root, "deliverables");
        Directory.CreateDirectory(_output);
        _store = new ExportQueueStore(Path.Combine(_root, "ledger"));
        _runner = new ExportQueueRunner(_store, _executor);
    }

    private ExportRecipe Recipe(string policy = "error") => new()
    {
        SchemaVersion = 1, Name = "Sharing", Format = "jpeg", Quality = 92, BitDepth = 8,
        MaxLongEdge = 1600, OutputProfile = "srgb", RenderingIntent = "maple-display",
        MetadataPolicy = "strip", NamingTemplate = "{original}-{n}.{ext}",
        Destination = "directory", Directory = _output, Watermark = null, OverwritePolicy = policy,
    };

    private ExportInput Input(string stem)
    {
        var path = Path.Combine(_root, stem + ".dng");
        File.WriteAllText(path, "immutable original " + stem);
        return new(path, "<snapshot exposure='0.5'/>", stem, "2026:09:06 12:30:00");
    }

    [Fact]
    public void Recipe_roundtrip_retains_unsupported_choices_and_explicit_nulls()
    {
        var recipe = Recipe() with { Format = "heic", MaxLongEdge = null, Watermark = "imported mark", RenderingIntent = "perceptual" };
        _store.SaveRecipe(recipe);
        Assert.Equal(recipe, Assert.Single(_store.Recipes()));
        var json = JsonSerializer.Serialize(recipe, ExportQueueStore.Json);
        Assert.Contains("\"watermark\": \"imported mark\"", json);
        Assert.Contains("\"maxLongEdge\": null", json);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExportRecipe>("{}", ExportQueueStore.Json));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExportRecipe>(
            json.Replace("\"schemaVersion\": 1", "\"extra\": 1, \"schemaVersion\": 1"), ExportQueueStore.Json));
    }

    [Fact]
    public async Task Retry_only_failed_keeps_snapshot_indices_and_completed_outputs()
    {
        var inputs = new[] { Input("first"), Input("second"), Input("third") };
        var originalHashes = inputs.Select(i => ExportPaths.Hash(i.SourcePath)).ToArray();
        var job = _runner.Create(Recipe(), inputs, inputs.Select(i => i.SourcePath));
        _executor.BeforeRender = item => { if (item.SequenceIndex == 1) throw new IOException("Disk full: free destination space."); };
        var first = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal(new[] { "applied", "failed", "applied" }, first.Entries.Select(i => i.Status));
        Assert.Contains("Disk full", first.Entries[1].Reason);
        var completedHash = ExportPaths.Hash(first.Entries[0].OutputPath);
        _executor.BeforeRender = null;
        var retry = await _runner.RunAsync(job.Id, true, CancellationToken.None);
        Assert.All(retry.Entries, item => Assert.Equal("applied", item.Status));
        Assert.Equal(new ulong[] { 0, 1, 2, 1 }, _executor.Calls.Select(i => i.SequenceIndex));
        Assert.All(_executor.Calls, i => Assert.Equal("<snapshot exposure='0.5'/>", i.Input.Xmp));
        Assert.Equal(completedHash, ExportPaths.Hash(retry.Entries[0].OutputPath));
        Assert.Equal(originalHashes, inputs.Select(i => ExportPaths.Hash(i.SourcePath)));
    }

    [Fact]
    public async Task Cancel_finishes_current_render_without_publishing_then_resume_preserves_order()
    {
        var inputs = new[] { Input("one"), Input("two") };
        var job = _runner.Create(Recipe(), inputs, Array.Empty<string>());
        using var cancellation = new CancellationTokenSource();
        _executor.BeforeRender = _ => cancellation.Cancel();
        var cancelled = await _runner.RunAsync(job.Id, false, cancellation.Token);
        Assert.True(cancelled.Cancelled);
        Assert.All(cancelled.Entries, i => Assert.Equal("pending", i.Status));
        Assert.Empty(Directory.EnumerateFiles(_output));
        _executor.BeforeRender = null;
        var resumed = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.All(resumed.Entries, i => Assert.Equal("applied", i.Status));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Restart_reconciles_prepared_output_without_rendering_again(bool alreadyPublished)
    {
        var input = Input("recover");
        var job = _runner.Create(Recipe(), new[] { input }, Array.Empty<string>());
        var item = job.Entries[0];
        File.WriteAllText(item.TempPath, "finished output");
        item.AfterHash = ExportPaths.Hash(item.TempPath);
        item.Status = "prepared";
        _store.Save(job);
        if (alreadyPublished) File.Move(item.TempPath, item.OutputPath);
        var reopened = new ExportQueueRunner(new ExportQueueStore(Path.Combine(_root, "ledger")), _executor);
        var result = await reopened.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal("applied", result.Entries[0].Status);
        Assert.Empty(_executor.Calls);
        Assert.Equal("finished output", File.ReadAllText(item.OutputPath));
    }

    [Theory]
    [InlineData("error", "failed")]
    [InlineData("skip", "skipped")]
    [InlineData("replace", "applied")]
    public async Task Collision_policy_is_explicit(string policy, string status)
    {
        var job = _runner.Create(Recipe(policy), new[] { Input("collision") }, Array.Empty<string>());
        File.WriteAllText(job.Entries[0].OutputPath, "previous deliverable");
        var result = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal(status, result.Entries[0].Status);
        if (policy != "replace") Assert.Equal("previous deliverable", File.ReadAllText(job.Entries[0].OutputPath));
    }

    [Fact]
    public async Task Destination_changes_and_original_changes_fail_without_overwriting()
    {
        var input = Input("changing");
        var job = _runner.Create(Recipe("replace"), new[] { input }, Array.Empty<string>());
        _executor.BeforeRender = item => File.WriteAllText(item.OutputPath, "arrived during render");
        var result = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal("failed", result.Entries[0].Status);
        Assert.Equal("arrived during render", File.ReadAllText(job.Entries[0].OutputPath));
        File.WriteAllText(input.SourcePath, "externally replaced original");
        result = await _runner.RunAsync(job.Id, true, CancellationToken.None);
        Assert.Contains("Original changed", result.Entries[0].Reason);
        Assert.Single(_executor.Calls);
    }

    [Fact]
    public void Original_paths_and_duplicate_targets_are_rejected_before_any_render()
    {
        var input = Input("protected");
        _executor.Name = _ => Path.GetFileName(input.SourcePath);
        Assert.Throws<IOException>(() => _runner.Create(Recipe() with { Directory = _root }, new[] { input }, Array.Empty<string>()));
        _executor.Name = _ => "same.jpg";
        Assert.Throws<IOException>(() => _runner.Create(Recipe("replace"), new[] { input, Input("another") }, Array.Empty<string>()));
        Assert.Empty(_executor.Calls);
    }

    [Fact]
    public async Task Changed_original_during_render_does_not_publish_a_mismatched_snapshot()
    {
        var job = _runner.Create(Recipe(), new[] { Input("change-in-flight") }, Array.Empty<string>());
        _executor.BeforeRender = item => File.WriteAllText(item.Input.SourcePath, "external change");
        var result = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal("failed", result.Entries[0].Status);
        Assert.Contains("Original changed during export", result.Entries[0].Reason);
        Assert.Empty(Directory.EnumerateFiles(_output));
    }

    [Fact]
    public async Task Restored_ledger_cannot_delete_an_original_at_its_expected_staging_path()
    {
        var input = Input("restored");
        var job = _runner.Create(Recipe(), new[] { input }, Array.Empty<string>());
        var old = job.Entries[0];
        File.WriteAllText(old.TempPath, "original restored into staging-named path");
        job.Entries[0] = new ExportQueueItem
        {
            Id = old.Id, Input = old.Input with { SourcePath = old.TempPath },
            SequenceIndex = old.SequenceIndex, OutputPath = old.OutputPath, TempPath = old.TempPath,
            Status = "rendering", SourceHash = ExportPaths.Hash(old.TempPath),
        };
        _store.Save(job);
        var error = await Assert.ThrowsAsync<IOException>(() => _runner.RunAsync(job.Id, false, CancellationToken.None));
        Assert.Contains("staging path is an original", error.Message);
        Assert.Equal("original restored into staging-named path", File.ReadAllText(old.TempPath));
        Assert.Empty(_executor.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Encoder_or_permission_failure_cleans_partial_output_and_keeps_a_retryable_record(bool permission)
    {
        var job = _runner.Create(Recipe(), new[] { Input("failed") }, Array.Empty<string>());
        _executor.BeforeRender = item =>
        {
            File.WriteAllText(item.TempPath, "partial encoder output");
            if (permission) throw new UnauthorizedAccessException("Destination permission denied.");
            throw new IOException("Encoder could not write the destination; disk full.");
        };
        var result = await _runner.RunAsync(job.Id, false, CancellationToken.None);
        Assert.Equal("failed", result.Entries[0].Status);
        Assert.NotEmpty(result.Entries[0].Reason!);
        Assert.Empty(Directory.EnumerateFiles(_output));
        _executor.BeforeRender = null;
        result = await _runner.RunAsync(job.Id, true, CancellationToken.None);
        Assert.Equal("applied", result.Entries[0].Status);
    }

    [Fact]
    public async Task A_second_job_cannot_encode_concurrently_against_the_same_queue()
    {
        var first = _runner.Create(Recipe(), new[] { Input("first-job") }, Array.Empty<string>());
        var second = _runner.Create(Recipe(), new[] { Input("second-job") }, Array.Empty<string>());
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        _executor.BeforeRender = _ => { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException(); };
        var active = _runner.RunAsync(first.Id, false, CancellationToken.None);
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
            await Assert.ThrowsAsync<IOException>(() => _runner.RunAsync(second.Id, false, CancellationToken.None));
        }
        finally { release.Set(); await active; }
        _executor.BeforeRender = null;
        Assert.Equal("applied", (await _runner.RunAsync(second.Id, false, CancellationToken.None)).Entries[0].Status);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private sealed class FakeExecutor : IExportRecipeExecutor
    {
        public List<ExportQueueItem> Calls { get; } = new();
        public Action<ExportQueueItem>? BeforeRender { get; set; }
        public Func<ExportInput, string>? Name { get; set; }
        public void Validate(ExportRecipe recipe) { }
        public string Filename(ExportRecipe recipe, ExportInput input, ulong index) =>
            Name?.Invoke(input) ?? $"{input.OriginalStem}-{index + 1}.jpg";
        public void Render(ExportRecipe recipe, ExportQueueItem item)
        {
            Calls.Add(item);
            BeforeRender?.Invoke(item);
            using var output = new FileStream(item.TempPath, FileMode.CreateNew, FileAccess.Write);
            using var writer = new StreamWriter(output);
            writer.Write("developed " + item.Input.Xmp);
        }
    }
}
