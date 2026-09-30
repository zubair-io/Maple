using System.Text.Json;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PresetStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-presets-" + Guid.NewGuid().ToString("N"));
    public PresetStoreTests() => Directory.CreateDirectory(_root);
    public void Dispose() => Directory.Delete(_root, true);
    private static Dictionary<string, JsonElement> Fields => new() { ["contrast"] = JsonSerializer.SerializeToElement(12) };

    [Fact]
    public async Task UnusableStorageDoesNotMasqueradeAsAnEmptyLibrary()
    {
        var path = Path.Combine(_root, "not-a-folder");
        await File.WriteAllTextAsync(path, "keep");
        await Assert.ThrowsAsync<IOException>(() => new PresetStore(path).LoadAsync());
        Assert.Equal("keep", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task BuiltinsAndUserCrudUsePortableAtomicFiles()
    {
        var store = new PresetStore(Path.Combine(_root, "library"));
        var builtins = await store.LoadAsync();
        Assert.Equal(5, builtins.Presets.Count);
        Assert.All(builtins.Presets, p => Assert.True(p.BuiltIn));
        await Assert.ThrowsAsync<InvalidDataException>(() => store.CreateAsync(" Flat ", Fields));
        await Assert.ThrowsAsync<InvalidDataException>(() => store.DeleteAsync("builtin-flat"));
        var created = await store.CreateAsync("My look", Fields);
        await Assert.ThrowsAsync<InvalidDataException>(() => store.CreateAsync("my LOOK", Fields));
        await store.RenameAsync(created.Id, "Renamed");
        var reloaded = await new PresetStore(Path.Combine(_root, "library")).LoadAsync();
        Assert.Equal("Renamed", reloaded.Presets.Single(p => !p.BuiltIn).Name);
        var export = Path.Combine(_root, "export.json");
        await PresetStore.ExportAsync(reloaded.Presets.Single(p => !p.BuiltIn), export);
        Assert.Equal(12, PresetDocument.Parse(await File.ReadAllTextAsync(export)).Fields["contrast"].GetInt32());
        await store.DeleteAsync(created.Id);
        Assert.All((await store.LoadAsync()).Presets, p => Assert.True(p.BuiltIn));
        Assert.Empty(Directory.GetFiles(Path.Combine(_root, "library"), "*.tmp"));
    }

    [Fact]
    public async Task ImportRenameExportPreservesUnknownDataAndReportsDamagedFiles()
    {
        var path = Path.Combine(_root, "future.json");
        await File.WriteAllTextAsync(path, """
            {"id":"outside-store","schemaVersion":5,"name":"Future","fields":{"contrast":15,"future_stage":true},"vendor":{"version":9}}
            """);
        var directory = Path.Combine(_root, "library");
        var store = new PresetStore(directory);
        var imported = await store.ImportAsync(path);
        Assert.NotEqual("outside-store", imported.Id);
        var renamed = await store.RenameAsync(imported.Id, "My future");
        await PresetStore.ExportAsync(renamed, Path.Combine(_root, "export.json"));
        var exported = PresetDocument.Parse(await File.ReadAllTextAsync(Path.Combine(_root, "export.json")));
        Assert.Equal(5, exported.SchemaVersion);
        Assert.True(exported.Fields["future_stage"].GetBoolean());
        Assert.Equal(9, exported.Extra["vendor"].GetProperty("version").GetInt32());
        await File.WriteAllTextAsync(Path.Combine(directory, "broken.json"), "{unfinished");
        var loaded = await store.LoadAsync();
        Assert.Single(loaded.Errors);
        Assert.Contains(loaded.Presets, p => p.Id == imported.Id);
        Assert.True(File.Exists(Path.Combine(directory, "broken.json")));
    }

    [Fact]
    public async Task CancellationAndInvalidIdentityDoNotAlterPersistedPresets()
    {
        var directory = Path.Combine(_root, "library");
        var store = new PresetStore(directory);
        var preset = await store.CreateAsync("Original", Fields);
        var before = await File.ReadAllBytesAsync(Path.Combine(directory, preset.Id + ".json"));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.RenameAsync(preset.Id, "Changed", cancellation.Token));
        await Assert.ThrowsAsync<InvalidDataException>(() => store.RenameAsync("../outside", "Changed"));
        Assert.Equal(before, await File.ReadAllBytesAsync(Path.Combine(directory, preset.Id + ".json")));
    }
}
