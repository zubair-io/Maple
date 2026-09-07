// ViewerFilmstripLogicTests — the WinUI-free half of the viewer's filmstrip
// rail (#3402, Maple.WinUI/MainWindow.Filmstrip.cs): the rail is viewer
// chrome shown in Preview and Edit alike, and activating one of its cells
// selects that photo on whatever surface is showing — never a ShellMode
// change. No WinUI/live Window involved; photos are plain strings here,
// the same stand-in SelectionLogicTests uses.

using Maple.WinUI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ViewerFilmstripLogicTests
    {
        private static readonly string[] Photos = { "a", "b", "c" };

        [Theory]
        [InlineData(ShellMode.Preview)]
        [InlineData(ShellMode.Edit)]
        public void IsRailVisible_InBothViewerModes(ShellMode mode)
        {
            Assert.True(ViewerFilmstripLogic.IsRailVisible(mode));
        }

        [Fact]
        public void IsRailVisible_NotInBrowse()
        {
            Assert.False(ViewerFilmstripLogic.IsRailVisible(ShellMode.Browse));
        }

        [Theory]
        [InlineData(ShellMode.Preview)]
        [InlineData(ShellMode.Edit)]
        public void Activate_SelectsTheCell_AndKeepsTheCurrentMode(ShellMode mode)
        {
            var activation = ViewerFilmstripLogic.Activate(mode, Photos, "2", current: "a");

            Assert.Equal("c", activation.Photo);
            Assert.Equal(mode, activation.Mode);
        }

        [Theory]
        [InlineData(ShellMode.Preview)]
        [InlineData(ShellMode.Edit)]
        public void Activate_AlreadyCurrentCell_SelectsNothing_AndKeepsTheMode(ShellMode mode)
        {
            var activation = ViewerFilmstripLogic.Activate(mode, Photos, "0", current: "a");

            Assert.Null(activation.Photo);
            Assert.Equal(mode, activation.Mode);
        }

        [Theory]
        [InlineData("9")]
        [InlineData("-1")]
        [InlineData("nope")]
        [InlineData("")]
        public void Activate_UnknownId_SelectsNothing(string id)
        {
            var activation = ViewerFilmstripLogic.Activate(ShellMode.Preview, Photos, id, current: "a");

            Assert.Null(activation.Photo);
            Assert.Equal(ShellMode.Preview, activation.Mode);
        }

        [Fact]
        public void ActiveIdFor_SelectedPhoto_IsItsOrdinalInTheStrip()
        {
            Assert.Equal("1", ViewerFilmstripLogic.ActiveIdFor(Photos, "b"));
        }

        [Fact]
        public void ActiveIdFor_NoSelection_IsNull()
        {
            Assert.Null(ViewerFilmstripLogic.ActiveIdFor(Photos, null));
        }

        [Fact]
        public void ActiveIdFor_PhotoNotInTheStrip_IsNull()
        {
            Assert.Null(ViewerFilmstripLogic.ActiveIdFor(Photos, "zzz"));
        }

        [Fact]
        public void IdAt_RoundTripsThroughActivate()
        {
            var id = ViewerFilmstripLogic.IdAt(2);

            var activation = ViewerFilmstripLogic.Activate(ShellMode.Edit, Photos, id, current: null);

            Assert.Equal("c", activation.Photo);
        }
    }
}
