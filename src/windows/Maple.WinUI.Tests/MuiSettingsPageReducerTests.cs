// MuiSettingsPageReducerTests — the invite-email gate behind the Maple.UI
// Settings page's Team section (Windows Pages wave, #3012). No WinUI/
// live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSettingsPageReducerTests
    {
        [Theory]
        [InlineData("priya@justmaple.app")]
        [InlineData("a@b.co")]
        public void IsValidInvite_WellFormedEmail_ReturnsTrue(string email)
        {
            Assert.True(MuiSettingsPageReducer.IsValidInvite(email));
        }

        [Theory]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("not-an-email")]
        [InlineData("@justmaple.app")]
        [InlineData("priya@")]
        [InlineData("priya@nodot")]
        [InlineData("priya@.app")]
        public void IsValidInvite_MalformedEmail_ReturnsFalse(string email)
        {
            Assert.False(MuiSettingsPageReducer.IsValidInvite(email));
        }
    }
}
