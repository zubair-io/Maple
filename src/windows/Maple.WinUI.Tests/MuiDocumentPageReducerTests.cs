// MuiDocumentPageReducerTests — the snapshot/restore decision logic
// behind the Maple.UI Document page (Windows Pages wave, #3012). No
// WinUI/live Window involved.

using System;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiDocumentPageReducerTests
    {
        [Fact]
        public void ShouldSnapshot_UnchangedContent_ReturnsFalse()
        {
            Assert.False(MuiDocumentPageReducer.ShouldSnapshot("same text", "same text"));
        }

        [Fact]
        public void ShouldSnapshot_ChangedContent_ReturnsTrue()
        {
            Assert.True(MuiDocumentPageReducer.ShouldSnapshot("old text", "new text"));
        }

        [Fact]
        public void ShouldSnapshot_BlankDraft_ReturnsFalse()
        {
            Assert.False(MuiDocumentPageReducer.ShouldSnapshot("old text", "   "));
        }

        [Fact]
        public void Snapshot_DemotesEveryExistingVersion()
        {
            var versions = new[] { new MuiMockDocVersion("v1", "Version 1", "old", DateTimeOffset.Now, true) };
            var result = MuiDocumentPageReducer.Snapshot(versions, "new", DateTimeOffset.Now);
            Assert.False(result.First(v => v.Id == "v1").IsCurrent);
        }

        [Fact]
        public void Snapshot_AppendsANewCurrentVersion()
        {
            var versions = new[] { new MuiMockDocVersion("v1", "Version 1", "old", DateTimeOffset.Now, true) };
            var at = DateTimeOffset.Now;
            var result = MuiDocumentPageReducer.Snapshot(versions, "new", at);
            var latest = result.Last();
            Assert.Equal("v2", latest.Id);
            Assert.Equal("new", latest.Content);
            Assert.True(latest.IsCurrent);
        }

        [Fact]
        public void Restore_KnownVersion_MarksItCurrentAndReturnsItsContent()
        {
            var versions = new[]
            {
                new MuiMockDocVersion("v1", "Version 1", "first", DateTimeOffset.Now, false),
                new MuiMockDocVersion("v2", "Version 2", "second", DateTimeOffset.Now, true),
            };
            var (updated, content) = MuiDocumentPageReducer.Restore(versions, "v1");
            Assert.Equal("first", content);
            Assert.True(updated.First(v => v.Id == "v1").IsCurrent);
            Assert.False(updated.First(v => v.Id == "v2").IsCurrent);
        }

        [Fact]
        public void Restore_UnknownVersion_ReturnsCurrentContentUnchanged()
        {
            var versions = new[] { new MuiMockDocVersion("v1", "Version 1", "first", DateTimeOffset.Now, true) };
            var (updated, content) = MuiDocumentPageReducer.Restore(versions, "missing");
            Assert.Equal("first", content);
            Assert.Same(versions, updated);
        }
    }
}
