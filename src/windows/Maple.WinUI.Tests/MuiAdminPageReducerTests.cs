// MuiAdminPageReducerTests — the Setup Wizard finish-gate and Pipeline
// Monitor pause-gate logic behind the Maple.UI Admin page (Windows Pages
// wave, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiAdminPageReducerTests
    {
        [Fact]
        public void CanFinish_AllStepsValid_ReturnsTrue()
        {
            Assert.True(MuiAdminPageReducer.CanFinish(new[] { true, true, true }));
        }

        [Fact]
        public void CanFinish_AnyStepInvalid_ReturnsFalse()
        {
            Assert.False(MuiAdminPageReducer.CanFinish(new[] { true, false, true }));
        }

        [Fact]
        public void CanFinish_NoSteps_ReturnsFalse()
        {
            Assert.False(MuiAdminPageReducer.CanFinish(System.Array.Empty<bool>()));
        }

        [Fact]
        public void TogglePause_StageNotFinished_FlipsCurrentState()
        {
            Assert.True(MuiAdminPageReducer.TogglePause(false, 5, 10));
            Assert.False(MuiAdminPageReducer.TogglePause(true, 5, 10));
        }

        [Fact]
        public void TogglePause_StageAlreadyFinished_AlwaysReturnsNotPaused()
        {
            Assert.False(MuiAdminPageReducer.TogglePause(false, 10, 10));
            Assert.False(MuiAdminPageReducer.TogglePause(true, 10, 10));
        }
    }
}
