// MuiBatchRenameLogicTests — the {name}/{ext}/{date}/{seq} template
// substitution behind the Maple.UI Batch Rename modal organism
// (Maple.WinUI/MapleUI/Organisms/MuiBatchRenameLogic.cs, wave N6, #3012).
// No WinUI/live Window involved.

using System;
using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiBatchRenameLogicTests
    {
        private static readonly DateOnly Date = new(2026, 8, 23);

        [Fact]
        public void Apply_SubstitutesDateAndSeq()
        {
            var result = MuiBatchRenameLogic.Apply("{date}_{seq}", "DSC_0192", "dng", Date, 1, 3);
            Assert.Equal("2026-08-23_001", result);
        }

        [Fact]
        public void Apply_SubstitutesNameAndExt()
        {
            var result = MuiBatchRenameLogic.Apply("{name}.{ext}", "DSC_0192", "dng", Date, 1, 3);
            Assert.Equal("DSC_0192.dng", result);
        }

        [Fact]
        public void Apply_PadsSequenceToRequestedWidth()
        {
            Assert.Equal("007", MuiBatchRenameLogic.Apply("{seq}", "x", "dng", Date, 7, 3));
        }

        [Fact]
        public void Apply_SequenceWiderThanPaddingIsNotTruncated()
        {
            Assert.Equal("1234", MuiBatchRenameLogic.Apply("{seq}", "x", "dng", Date, 1234, 2));
        }

        [Fact]
        public void Apply_MinimumPaddingIsOneDigit()
        {
            Assert.Equal("5", MuiBatchRenameLogic.Apply("{seq}", "x", "dng", Date, 5, 0));
        }

        [Fact]
        public void Apply_TemplateWithNoTokens_ReturnsLiteralText()
        {
            Assert.Equal("export", MuiBatchRenameLogic.Apply("export", "x", "dng", Date, 1, 3));
        }

        [Fact]
        public void PreviewBatch_IncrementsSequencePerItem()
        {
            var originals = new List<(string Name, string Ext)> { ("a", "dng"), ("b", "dng"), ("c", "dng") };
            var result = MuiBatchRenameLogic.PreviewBatch("{date}_{seq}", originals, Date, 1, 2);
            Assert.Equal(new[] { "2026-08-23_01", "2026-08-23_02", "2026-08-23_03" }, result);
        }

        [Fact]
        public void PreviewBatch_HonorsCustomSeqStart()
        {
            var originals = new List<(string Name, string Ext)> { ("a", "dng"), ("b", "dng") };
            var result = MuiBatchRenameLogic.PreviewBatch("{seq}", originals, Date, 10, 2);
            Assert.Equal(new[] { "10", "11" }, result);
        }
    }
}
