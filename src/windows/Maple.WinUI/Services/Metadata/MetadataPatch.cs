using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Metadata;

public enum KeywordOperation { Keep, Add, Remove, Replace }

/// <summary>Null culling values mean unchanged; zero/none explicitly clear.
/// SetLabel distinguishes keeping the label from clearing it.</summary>
public sealed record MetadataPatch(
    int? Rating = null, string? Flag = null, bool SetLabel = false, string? Label = null,
    KeywordOperation KeywordOperation = KeywordOperation.Keep, string[]? Keywords = null)
{
    public bool HasChanges => Rating != null || Flag != null || SetLabel || KeywordOperation != KeywordOperation.Keep;

    public void Validate()
    {
        if (Rating is < 0 or > 5) throw new ArgumentException("Rating must be between 0 and 5.");
        if (Flag != null && Flag is not ("none" or "pick" or "reject")) throw new ArgumentException("Unknown flag.");
        if (SetLabel && Label != null && !ColorLabelVocabulary.Values.Contains(Label))
            throw new ArgumentException("Unknown color label.");
        if (!Enum.IsDefined(KeywordOperation)) throw new ArgumentException("Unknown keyword operation.");
        if ((Keywords?.Length ?? 0) > 1000 || Keywords?.Any(k => k == null || k.Length > 1024) == true)
            throw new ArgumentException("Use at most 1,000 keywords, each at most 1,024 characters.");
    }

    public string[] UpdatedKeywords(IEnumerable<string> existing)
    {
        var before = Normalize(existing);
        var requested = Normalize(Keywords ?? Array.Empty<string>());
        return KeywordOperation switch
        {
            KeywordOperation.Add => before.Union(requested, StringComparer.Ordinal).ToArray(),
            KeywordOperation.Remove => before.Except(requested, StringComparer.Ordinal).ToArray(),
            KeywordOperation.Replace => requested,
            _ => before,
        };
    }

    public void Apply(XmpSidecarDocument document)
    {
        Validate();
        if (Rating != null) document.Rating = Rating == 0 ? null : Rating;
        if (Flag != null) document.Flag = Flag == "none" ? null : Flag;
        if (SetLabel) document.ColorLabel = Label;
        if (KeywordOperation != KeywordOperation.Keep)
            MetadataValues.SetKeywords(document, UpdatedKeywords(MetadataValues.Read(document).Keywords));
    }

    public IReadOnlyDictionary<string, object?> CloudFields(MetadataValues current)
    {
        Validate();
        var fields = new Dictionary<string, object?>();
        if (Rating != null) fields["rating"] = Rating;
        if (Flag != null) fields["flag"] = Flag == "none" ? "unflagged" : Flag;
        if (SetLabel) fields["colorLabel"] = Label;
        if (KeywordOperation != KeywordOperation.Keep) fields["keywords"] = UpdatedKeywords(current.Keywords);
        return fields;
    }

    internal static string[] Normalize(IEnumerable<string> values) => values
        .Select(k => k.Trim()).Where(k => k.Length != 0).Distinct(StringComparer.Ordinal).ToArray();
}

public sealed record MetadataValues(int Rating, string Flag, string? Label, string[] Keywords)
{
    private static readonly XNamespace Dc = "http://purl.org/dc/elements/1.1/";
    private static readonly XNamespace Rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

    public static string KeywordSummary(IEnumerable<MetadataValues> items)
    {
        var sets = items.Select(v => v.Keywords.OrderBy(k => k, StringComparer.Ordinal).ToArray()).ToArray();
        if (sets.Length == 0 || sets.Skip(1).Any(set => !sets[0].SequenceEqual(set, StringComparer.Ordinal)))
            return "Mixed";
        return sets[0].Length == 0 ? "none" : string.Join(", ", sets[0]);
    }

    public static MetadataValues Read(XmpSidecarDocument document)
    {
        var subject = document.PassthroughNodes.Select(XElement.Parse).FirstOrDefault(e => e.Name == Dc + "subject");
        var keywords = subject?.Elements(Rdf + "Bag").Elements(Rdf + "li").Select(e => e.Value)
            ?? Enumerable.Empty<string>();
        return new(document.Rating ?? 0, document.Flag ?? "none", document.ColorLabel, MetadataPatch.Normalize(keywords));
    }

    internal static void SetKeywords(XmpSidecarDocument document, string[] keywords)
    {
        // Replace the owned Bag in place so passthrough child-order indices and
        // unrelated attributes/nodes remain valid after an edit and autosave.
        var index = document.PassthroughNodes.FindIndex(node => XElement.Parse(node).Name == Dc + "subject");
        var subject = index >= 0 ? XElement.Parse(document.PassthroughNodes[index]) :
            new XElement(Dc + "subject", new XAttribute(XNamespace.Xmlns + "dc", Dc), new XAttribute(XNamespace.Xmlns + "rdf", Rdf));
        var bags = subject.Elements(Rdf + "Bag").ToArray();
        var bag = bags.FirstOrDefault() ?? new XElement(Rdf + "Bag");
        var oldItems = bag.Elements(Rdf + "li").ToArray();
        foreach (var item in oldItems) item.Remove();
        foreach (var keyword in keywords)
            bag.Add(oldItems.FirstOrDefault(e => e.Value == keyword) ?? new XElement(Rdf + "li", keyword));
        if (bags.Length == 0) subject.Add(bag);
        foreach (var duplicate in bags.Skip(1)) duplicate.Remove();
        var xml = subject.ToString(SaveOptions.DisableFormatting);
        if (index >= 0) document.PassthroughNodes[index] = xml;
        else document.PassthroughNodes.Add(xml);
    }
}
