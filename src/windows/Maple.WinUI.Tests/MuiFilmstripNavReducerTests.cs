// MuiFilmstripNavReducerTests — the wrap-around "move by N" logic shared
// by the Maple.UI Preview and TV Viewer pages (Windows Pages wave,
// #3012). No WinUI/live Window involved.

using System;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiFilmstripNavReducerTests
    {
        private static readonly string[] Ids = { "a", "b", "c" };

        [Fact]
        public void Move_Forward_StepsToNextId()
        {
            Assert.Equal("b", MuiFilmstripNavReducer.Move(Ids, "a", 1));
        }

        [Fact]
        public void Move_Forward_WrapsPastTheLastId()
        {
            Assert.Equal("a", MuiFilmstripNavReducer.Move(Ids, "c", 1));
        }

        [Fact]
        public void Move_Backward_WrapsBeforeTheFirstId()
        {
            Assert.Equal("c", MuiFilmstripNavReducer.Move(Ids, "a", -1));
        }

        [Fact]
        public void Move_UnknownActiveId_TreatsItAsIndexZero()
        {
            Assert.Equal("b", MuiFilmstripNavReducer.Move(Ids, "does-not-exist", 1));
        }

        [Fact]
        public void Move_EmptyList_ReturnsNull()
        {
            Assert.Null(MuiFilmstripNavReducer.Move(Array.Empty<string>(), "a", 1));
        }
    }
}
