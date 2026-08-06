// XmpNumberFormatTests — the numeric wire codec against
// `docs/xmp-canonical-format.md` § "Number formatting": integers serialize
// bare, non-integers round to two decimals with trailing zeros stripped.
// Mirrors `XMPSerializer.fmtNum` (Swift) / `numericSerializer` (TypeScript)
// test coverage for the same documented table.

using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpNumberFormatTests
    {
        [Theory]
        [InlineData(0.0, "0")]
        [InlineData(6.0, "6")]
        [InlineData(-6.0, "-6")]
        [InlineData(5200.0, "5200")]
        [InlineData(255.0, "255")]
        [InlineData(0.5, "0.5")]
        [InlineData(0.50, "0.5")]
        [InlineData(0.123, "0.12")]
        [InlineData(-0.1, "-0.1")]
        [InlineData(-14.5, "-14.5")]
        [InlineData(1.4, "1.4")]
        [InlineData(127.5, "127.5")]
        [InlineData(140.25, "140.25")]
        public void FormatsPerCanonicalCodec(double value, string expected)
        {
            Assert.Equal(expected, XmpSchema.FormatNumber(value));
        }

        [Fact]
        public void NonFiniteDoesNotProduceNonFiniteText()
        {
            // The codec is a defensive backstop, not the primary guard —
            // NaN/Infinity are never supposed to reach it (raw-core and the
            // model setters keep sliders in range). What matters for a
            // sidecar's well-formedness is that whatever comes out is a
            // valid XML attribute value, never the literal "NaN"/"Infinity"
            // strings .NET's default ToString would otherwise produce.
            Assert.Equal("0", XmpSchema.FormatNumber(double.NaN));
            Assert.Equal("0", XmpSchema.FormatNumber(double.PositiveInfinity));
            Assert.Equal("0", XmpSchema.FormatNumber(double.NegativeInfinity));
        }
    }
}
