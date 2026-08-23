// MuiSignInPageReducerTests — the email/password field validation and
// submit gate behind the Maple.UI Sign In page (Windows Pages wave,
// #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSignInPageReducerTests
    {
        [Fact]
        public void EmailError_Blank_ReturnsRequiredMessage()
        {
            Assert.Equal("Email is required.", MuiSignInPageReducer.EmailError(""));
        }

        [Fact]
        public void EmailError_Malformed_ReturnsFormatMessage()
        {
            Assert.Equal("Enter a valid email address.", MuiSignInPageReducer.EmailError("not-an-email"));
        }

        [Fact]
        public void EmailError_WellFormed_ReturnsNull()
        {
            Assert.Null(MuiSignInPageReducer.EmailError("zubair@justmaple.app"));
        }

        [Fact]
        public void PasswordError_Blank_ReturnsRequiredMessage()
        {
            Assert.Equal("Password is required.", MuiSignInPageReducer.PasswordError(""));
        }

        [Fact]
        public void PasswordError_TooShort_ReturnsLengthMessage()
        {
            Assert.Equal("Must be at least 8 characters.", MuiSignInPageReducer.PasswordError("short"));
        }

        [Fact]
        public void PasswordError_LongEnough_ReturnsNull()
        {
            Assert.Null(MuiSignInPageReducer.PasswordError("longenough"));
        }

        [Fact]
        public void CanSubmit_BothFieldsValid_ReturnsTrue()
        {
            Assert.True(MuiSignInPageReducer.CanSubmit("zubair@justmaple.app", "longenough"));
        }

        [Fact]
        public void CanSubmit_OneFieldInvalid_ReturnsFalse()
        {
            Assert.False(MuiSignInPageReducer.CanSubmit("zubair@justmaple.app", "short"));
        }
    }
}
