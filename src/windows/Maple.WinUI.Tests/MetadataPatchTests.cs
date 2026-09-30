using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class MetadataPatchTests
{
    [Fact]
    public void UnchangedAndClearHaveDifferentWireSemantics()
    {
        var current = new MetadataValues(4, "pick", "red", new[] { "old" });
        Assert.Empty(new MetadataPatch().CloudFields(current));
        var clear = new MetadataPatch(0, "none", true, null, KeywordOperation.Replace, Array.Empty<string>());
        var fields = clear.CloudFields(current);
        Assert.Equal(0, fields["rating"]);
        Assert.Equal("unflagged", fields["flag"]);
        Assert.Null(fields["colorLabel"]);
        Assert.Empty(Assert.IsType<string[]>(fields["keywords"]));
    }

    [Theory]
    [InlineData(KeywordOperation.Keep, "one,two")]
    [InlineData(KeywordOperation.Add, "one,two,three")]
    [InlineData(KeywordOperation.Remove, "one")]
    [InlineData(KeywordOperation.Replace, "two,three")]
    public void KeywordModesAreExplicitAndIdempotent(KeywordOperation operation, string expected)
    {
        var patch = new MetadataPatch(KeywordOperation: operation, Keywords: new[] { "two", "three", " two " });
        var result = patch.UpdatedKeywords(new[] { "one", "two" });
        Assert.Equal(expected.Split(','), result);
        Assert.Equal(result, patch.UpdatedKeywords(result));
    }

    [Fact]
    public void KeywordsPersistThroughCanonicalWriterAndLaterAdjustmentEdit()
    {
        var document = new XmpSidecarDocument();
        new MetadataPatch(KeywordOperation: KeywordOperation.Add, Keywords: new[] { "東京", "A & B" }).Apply(document);
        var reopened = XmpParser.Parse(XmpWriter.Serialize(document))!;
        reopened.Adjustments.Exposure = 1;
        reopened = XmpParser.Parse(XmpWriter.Serialize(reopened))!;
        Assert.Equal(new[] { "東京", "A & B" }, MetadataValues.Read(reopened).Keywords);
        new MetadataPatch(KeywordOperation: KeywordOperation.Remove, Keywords: new[] { "東京" }).Apply(reopened);
        Assert.Equal(new[] { "A & B" }, MetadataValues.Read(XmpParser.Parse(XmpWriter.Serialize(reopened))!).Keywords);
    }

    [Fact]
    public void UnsupportedLabelCannotBeWritten()
    {
        Assert.Throws<ArgumentException>(() => new MetadataPatch(SetLabel: true, Label: "magenta").Apply(new()));
    }
}
