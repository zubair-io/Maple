// RecycleBinServiceTests — SHFileOperationW permanently deletes what it
// cannot recycle unless FOF_WANTNUKEWARNING is set (#4760); the shell then
// asks, and a declined or aborted operation must read as "not recycled" so
// the caller falls back to .maple/trash. The shell32 call itself needs a
// Windows runtime; the flag set and result interpretation are pinned here.

using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RecycleBinServiceTests
    {
        private const ushort FofAllowUndo = 0x0040;
        private const ushort FofWantNukeWarning = 0x4000;
        private const ushort FofNoErrorUi = 0x0400;
        private const ushort FofSilent = 0x0004;

        [Fact]
        public void Flags_RequestUndoAndWarnBeforePermanentDelete()
        {
            var flags = RecycleBinService.OperationFlags;

            Assert.Equal(FofAllowUndo, flags & FofAllowUndo);
            Assert.Equal(FofWantNukeWarning, flags & FofWantNukeWarning);
            Assert.Equal(FofNoErrorUi, flags & FofNoErrorUi);
            Assert.Equal(FofSilent, flags & FofSilent);
        }

        [Theory]
        [InlineData(0, false, true)]
        [InlineData(0, true, false)]
        [InlineData(0x78, false, false)]
        [InlineData(0x402, false, false)]
        public void Recycled_RequiresZeroResultAndNoAbort(int result, bool aborted, bool expected) =>
            Assert.Equal(expected, RecycleBinService.Recycled(result, aborted));
    }
}
