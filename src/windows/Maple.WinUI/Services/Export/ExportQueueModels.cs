using System;
using System.Collections.Generic;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Services.Export;

public sealed record ExportInput(string SourcePath, string Xmp, string OriginalStem, string? CapturedAt);

public sealed class ExportQueueItem
{
    public required string Id { get; init; }
    public required ExportInput Input { get; init; }
    public required ulong SequenceIndex { get; init; }
    public required string OutputPath { get; init; }
    public required string TempPath { get; init; }
    public string Status { get; set; } = "pending";
    public string? Reason { get; set; }
    public string? SourceHash { get; set; }
    public string? BeforeHash { get; set; }
    public string? AfterHash { get; set; }
}

public sealed class ExportQueueJob
{
    public int SchemaVersion { get; init; } = 1;
    public required string Id { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required ExportRecipe Recipe { get; init; }
    public required string[] ProtectedOriginals { get; init; }
    public required List<ExportQueueItem> Entries { get; init; }
    public bool Cancelled { get; set; }
}

/// <summary>The production adapter uses the shared Rust recipe and filename rules.</summary>
public interface IExportRecipeExecutor
{
    void Validate(ExportRecipe recipe);
    string Filename(ExportRecipe recipe, ExportInput input, ulong index);
    void Render(ExportRecipe recipe, ExportQueueItem item);
}
