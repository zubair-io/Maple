using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Metadata;

public sealed record MetadataTarget(string Path, string Name, string? CloudAddress = null);

public sealed class MetadataBatchItem
{
    public MetadataTarget Target { get; }
    public MetadataValues Before { get; }
    public MetadataValues? Saved { get; internal set; }
    public string? Error { get; internal set; }
    public MetadataBatchItem(MetadataTarget target, MetadataValues before) => (Target, Before) = (target, before);
}

/// <summary>Frozen selection and patch. Cancel stops before the next write;
/// retry skips acknowledged successes. Original image bytes are never opened
/// for writing. A failed cloud item is not optimistically marked saved.</summary>
public sealed class MetadataBatch
{
    public IReadOnlyList<MetadataBatchItem> Items { get; }
    public MetadataPatch Patch { get; }
    private readonly CloudClient? _cloud;

    public MetadataBatch(IReadOnlyList<MetadataBatchItem> items, MetadataPatch patch, CloudClient? cloud)
    {
        patch.Validate();
        Items = items.ToArray();
        Patch = patch with { Keywords = patch.Keywords?.ToArray() };
        _cloud = cloud;
    }

    public static async Task<MetadataValues> ReadAsync(MetadataTarget target, CloudClient? cloud, CancellationToken cancellation)
    {
        string? xml;
        if (target.CloudAddress != null)
        {
            if (cloud == null) throw new InvalidOperationException("The server is not connected.");
            xml = await cloud.ReadMetadataXmpAsync(target.Path, cancellation);
        }
        else
        {
            xml = await Task.Run(() =>
            {
                cancellation.ThrowIfCancellationRequested();
                try
                {
                    using var stream = new FileStream(SidecarStore.SidecarPathFor(target.Path), FileMode.Open, FileAccess.Read, FileShare.Read);
                    if (stream.Length > 4 * 1024 * 1024) throw new IOException("Sidecar exceeds the 4 MiB editing limit.");
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    return reader.ReadToEnd();
                }
                catch (FileNotFoundException) { return null; }
            }, cancellation);
        }
        cancellation.ThrowIfCancellationRequested();
        var doc = xml == null ? new XmpSidecarDocument() :
            XmpParser.Parse(xml) ?? throw new IOException("Existing sidecar is invalid; no metadata was changed.");
        return MetadataValues.Read(doc);
    }

    public async Task ApplyAsync(CancellationToken cancellation, IProgress<MetadataBatchItem>? progress = null)
    {
        foreach (var item in Items.Where(item => item.Saved == null))
        {
            if (cancellation.IsCancellationRequested) break;
            item.Error = null;
            try
            {
                if (item.Target.CloudAddress != null)
                {
                    var cloud = _cloud ?? throw new InvalidOperationException("The server is not connected.");
                    item.Saved = await cloud.ApplyMetadataAsync(item.Target.Path,
                        item.Target.CloudAddress, Patch, cancellation);
                }
                else
                {
                    var xml = await Task.Run(() => SidecarStore.Update(item.Target.Path, Patch.Apply));
                    item.Saved = MetadataValues.Read(XmpParser.Parse(xml)!);
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (Exception error) { item.Error = error.Message; }
            progress?.Report(item);
        }
    }

    public MetadataValues Project(MetadataValues value) => new(
        Patch.Rating ?? value.Rating, Patch.Flag ?? value.Flag,
        Patch.SetLabel ? Patch.Label : value.Label, Patch.UpdatedKeywords(value.Keywords));
}
