// MuiInlineEditLogicTests — the shared inline-edit commit rule behind
// MuiInlineRenameField (L1) and the L2 Description Field/Place Row
// molecules (Maple.WinUI/MapleUI/Molecules/MuiInlineEditLogic.cs, wave N4
// of the Windows Maple.UI molecules L2, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiInlineEditLogicTests
    {
        [Fact]
        public void ResolveCommit_UnchangedFromCurrent_ReturnsNull()
        {
            Assert.Null(MuiInlineEditLogic.ResolveCommit("harbor.dng", "harbor.dng", allowEmpty: false));
        }

        [Fact]
        public void ResolveCommit_UnchangedAfterTrim_ReturnsNull()
        {
            Assert.Null(MuiInlineEditLogic.ResolveCommit("  harbor.dng  ", "harbor.dng", allowEmpty: false));
        }

        [Fact]
        public void ResolveCommit_ChangedValue_ReturnsTrimmedValue()
        {
            Assert.Equal("sunset.dng", MuiInlineEditLogic.ResolveCommit("  sunset.dng  ", "harbor.dng", allowEmpty: false));
        }

        [Fact]
        public void ResolveCommit_EmptyDraft_AllowEmptyFalse_ReturnsNull()
        {
            // A rename or a place override never commits blank.
            Assert.Null(MuiInlineEditLogic.ResolveCommit("   ", "harbor.dng", allowEmpty: false));
        }

        [Fact]
        public void ResolveCommit_EmptyDraft_AllowEmptyTrue_ReturnsEmptyString()
        {
            // A description is allowed to be committed empty (clearing it).
            Assert.Equal(string.Empty, MuiInlineEditLogic.ResolveCommit("   ", "A quiet harbor.", allowEmpty: true));
        }

        [Fact]
        public void ResolveCommit_EmptyDraft_AlreadyEmptyCurrent_ReturnsNull()
        {
            // Even with allowEmpty true, an empty->empty "commit" is still a
            // no-op (unchanged-from-current wins first).
            Assert.Null(MuiInlineEditLogic.ResolveCommit("", "", allowEmpty: true));
        }
    }
}
