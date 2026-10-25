using System;
using System.IO;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

/// <summary>Cold derivatives use an immutable sidecar snapshot through the
/// shared Rust recipe renderer. A present but invalid sidecar never falls
/// through to the camera preview, which would discard the photographer's edits.</summary>
public static class ThumbnailRenderer
{
    /// <summary>An absent sidecar, or a readable one without render adjustments
    /// (empty, or rating/flag/label/keywords only), permits an unedited RAW
    /// recovery. Access errors and authored or invalid sidecars never do.</summary>
    public static bool CanDevelopUneditedFallback(string rawPath)
    {
        try { return !HasRenderAdjustments(File.ReadAllText(SidecarStore.SidecarPathFor(rawPath))); }
        catch (FileNotFoundException) { return true; }
        catch (DirectoryNotFoundException) { return true; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
    }

    public static bool IsFresh(string cachedPath, string rawPath)
    {
        if (!File.Exists(cachedPath)) return false;
        var cachedAt = File.GetLastWriteTimeUtc(cachedPath);
        var sidecarPath = SidecarStore.SidecarPathFor(rawPath);
        return cachedAt >= File.GetLastWriteTimeUtc(rawPath)
            && (!File.Exists(sidecarPath) || cachedAt >= File.GetLastWriteTimeUtc(sidecarPath));
    }

    /// <summary>A native library that cannot answer (an older build without the
    /// export, or none loaded) counts as having edits and stays fail-closed.</summary>
    public static bool HasRenderAdjustments(string sidecarXml)
    {
        if (sidecarXml.Length == 0) return false;
        try { return RawFfi.maple_xmp_has_render_adjustments(sidecarXml) != 0; }
        catch (Exception error) when (error is EntryPointNotFoundException or DllNotFoundException or BadImageFormatException) { return true; }
    }

    private static int RenderUnedited(string rawPath, string outputPath, int maxPx, bool avif) => avif
        ? RawFfi.maple_render_thumbnail_avif_to_file(rawPath, outputPath, (uint)maxPx, 0)
        : RawFfi.maple_render_thumbnail_preview_jpeg_to_file(rawPath, outputPath, (uint)maxPx, 0);

    public static int Render(string rawPath, string outputPath, int maxPx, bool avif)
    {
        var stagingPath = Path.Combine(Path.GetTempPath(), "maple-thumb.tmp.develop." + Guid.NewGuid().ToString("N"));
        var publicationPath = outputPath + ".tmp.develop." + Guid.NewGuid().ToString("N");
        try
        {
            string xml;
            try { xml = File.ReadAllText(SidecarStore.SidecarPathFor(rawPath)); }
            catch (FileNotFoundException) { return RenderUnedited(rawPath, outputPath, maxPx, avif); }
            if (!HasRenderAdjustments(xml)) return RenderUnedited(rawPath, outputPath, maxPx, avif);
            _ = XDocument.Parse(xml);
            LensProfileStore.RestoreForSidecar(rawPath, xml);
            var recipe = new ExportRecipe
            {
                SchemaVersion = ExportRecipe.CurrentSchemaVersion, Name = "Cached derivative", Format = avif ? "avif" : "jpeg",
                Quality = avif ? 55u : 85u, BitDepth = 8, MaxLongEdge = (uint)maxPx,
                OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
                NamingTemplate = "{original}.{ext}", Destination = "download", Directory = null,
                Watermark = null, OverwritePolicy = "browser",
            };
            var rc = RawFfi.maple_export_recipe_to_file(rawPath, xml, JsonSerializer.Serialize(recipe),
                Path.Combine(AppContext.BaseDirectory, "film-luts"), stagingPath);
            if (rc != 0)
            {
                DiagLog.Write($"[Thumbs] authored edits for {rawPath} could not be developed (rc {rc}); no camera preview substituted");
                return rc;
            }
            // The develop temp may be on another volume. Publish from a temp
            // beside the destination so the final move is an atomic rename.
            File.Copy(stagingPath, publicationPath);
            File.Move(publicationPath, outputPath, overwrite: true);
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or XmlException or LensProfileException)
        {
            DiagLog.Write($"[Thumbs] derivative failed for {rawPath}: {error.Message}");
            return error is IOException or UnauthorizedAccessException ? 12 : 1;
        }
        finally
        {
            try { File.Delete(stagingPath); File.Delete(publicationPath); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { DiagLog.Write($"[Thumbs] staging cleanup failed: {error.Message}"); }
        }
    }
}
