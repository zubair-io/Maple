// MuiStructuredDataEditorLogicTests — the flat-JSON <-> form-field
// conversion behind the Maple.UI Structured Data Editor organism
// (Maple.WinUI/MapleUI/Organisms/MuiStructuredDataEditorLogic.cs, wave N6,
// #3012). No WinUI/live Window involved.

using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiStructuredDataEditorLogicTests
    {
        [Fact]
        public void ParseFlatJson_ValidObject_ReturnsFieldPerProperty()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("""{"camera":"DJI Mavic 3 Pro","iso":100}""", out var error);
            Assert.Null(error);
            Assert.Equal(2, fields.Count);
            Assert.Equal("DJI Mavic 3 Pro", fields.Single(f => f.Key == "camera").Value);
            Assert.Equal("100", fields.Single(f => f.Key == "iso").Value);
        }

        [Fact]
        public void ParseFlatJson_Empty_ReturnsError()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("", out var error);
            Assert.NotNull(error);
            Assert.Empty(fields);
        }

        [Fact]
        public void ParseFlatJson_InvalidSyntax_ReturnsError()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("{not json", out var error);
            Assert.NotNull(error);
            Assert.Empty(fields);
        }

        [Fact]
        public void ParseFlatJson_ArrayRoot_ReturnsError()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("[1,2,3]", out var error);
            Assert.NotNull(error);
            Assert.Empty(fields);
        }

        [Fact]
        public void ParseFlatJson_NestedObject_ReturnsError()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("""{"a":{"b":1}}""", out var error);
            Assert.NotNull(error);
            Assert.Contains("not flat", error);
            Assert.Empty(fields);
        }

        [Fact]
        public void ParseFlatJson_NullValue_BecomesEmptyString()
        {
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson("""{"note":null}""", out var error);
            Assert.Null(error);
            Assert.Equal(string.Empty, fields.Single().Value);
        }

        [Fact]
        public void ToJson_ProducesParsableObject()
        {
            var fields = new[] { new MuiStructuredField("camera", "DJI Mavic 3 Pro"), new MuiStructuredField("iso", "100") };
            var json = MuiStructuredDataEditorLogic.ToJson(fields);
            var roundTripped = MuiStructuredDataEditorLogic.ParseFlatJson(json, out var error);
            Assert.Null(error);
            Assert.Equal(2, roundTripped.Count);
            Assert.Equal("DJI Mavic 3 Pro", roundTripped.Single(f => f.Key == "camera").Value);
        }

        [Fact]
        public void RoundTrip_PreservesKeyValueContentThroughFullCycle()
        {
            const string original = """{"a":"1","b":"two"}""";
            var fields = MuiStructuredDataEditorLogic.ParseFlatJson(original, out _);
            var reserialized = MuiStructuredDataEditorLogic.ToJson(fields);
            var reparsed = MuiStructuredDataEditorLogic.ParseFlatJson(reserialized, out var error);
            Assert.Null(error);
            Assert.Equal(fields.OrderBy(f => f.Key), reparsed.OrderBy(f => f.Key));
        }
    }
}
