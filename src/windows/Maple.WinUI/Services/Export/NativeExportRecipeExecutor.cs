using System;
using System.IO;
using System.Text;
using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Export;

public sealed class NativeExportRecipeExecutor : IExportRecipeExecutor
{
    private readonly string? _filmDirectory;
    public NativeExportRecipeExecutor(string? filmDirectory = null) =>
        _filmDirectory = filmDirectory ?? Path.Combine(AppContext.BaseDirectory, "film-luts");

    public void Validate(ExportRecipe recipe)
    {
        if (RawFfi.maple_validate_export_recipe(JsonSerializer.Serialize(recipe)) != 0)
            throw new InvalidDataException(RawFfi.LastError() ?? "Recipe validation failed.");
    }

    public unsafe string Filename(ExportRecipe recipe, ExportInput input, ulong index)
    {
        Span<byte> output = stackalloc byte[1024];
        nuint length = 0;
        fixed (byte* pointer = output)
        {
            if (RawFfi.maple_export_recipe_filename_buf(JsonSerializer.Serialize(recipe),
                input.OriginalStem, input.CapturedAt, index, pointer, (nuint)output.Length, &length) != 0)
                throw new InvalidDataException(RawFfi.LastError() ?? "Export filename failed.");
        }
        return Encoding.UTF8.GetString(output[..checked((int)length)]);
    }

    public void Render(ExportRecipe recipe, ExportQueueItem item)
    {
        // Resume/retry uses the queued optical intent, including its exact LCP
        // digest. The live editor and source sidecar may have changed since enqueue.
        var document = XmpParser.Parse(item.Input.Xmp)
            ?? throw new InvalidDataException("Queued export has invalid XMP.");
        LensProfileStore.RestoreForFile(item.Input.SourcePath, document.Adjustments);
        if (RawFfi.maple_export_recipe_to_file(item.Input.SourcePath, item.Input.Xmp,
            JsonSerializer.Serialize(recipe), _filmDirectory, item.TempPath) != 0)
            throw new IOException(RawFfi.LastError() ?? "The image encoder failed.");
    }
}
