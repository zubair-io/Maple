// MuiTabShellMathTests — the tab-bar-placement math behind the Maple.UI
// Tab Shell template (Maple.WinUI/MapleUI/Templates/MuiTabShellMath.cs,
// wave N5 of the Windows Maple.UI templates, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiTabShellMathTests
    {
        [Fact]
        public void TabBarAtBottom_ExplicitTop_AlwaysFalse()
        {
            Assert.False(MuiTabShellMath.TabBarAtBottom(MuiTabShellPlacement.Top, hostWidth: 320));
        }

        [Fact]
        public void TabBarAtBottom_ExplicitBottom_AlwaysTrue()
        {
            Assert.True(MuiTabShellMath.TabBarAtBottom(MuiTabShellPlacement.Bottom, hostWidth: 1200));
        }

        [Fact]
        public void TabBarAtBottom_AutoNarrowHost_ReturnsTrue()
        {
            Assert.True(MuiTabShellMath.TabBarAtBottom(MuiTabShellPlacement.Auto, hostWidth: 400));
        }

        [Fact]
        public void TabBarAtBottom_AutoWideHost_ReturnsFalse()
        {
            Assert.False(MuiTabShellMath.TabBarAtBottom(MuiTabShellPlacement.Auto, hostWidth: 1024));
        }

        [Fact]
        public void TabBarAtBottom_AutoExactlyAtBreakpoint_ReturnsFalse()
        {
            Assert.False(MuiTabShellMath.TabBarAtBottom(MuiTabShellPlacement.Auto, MuiTabShellMath.PhoneBreakpointPx));
        }
    }
}
