// MuiSetupWizardLogicTests — the validity-gated step logic behind the
// Maple.UI Setup Wizard organism (Maple.WinUI/MapleUI/Organisms/MuiSetupWizardLogic.cs,
// wave N6, #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSetupWizardLogicTests
    {
        private static readonly IReadOnlyList<MuiWizardStepState> ThreeSteps = new[]
        {
            new MuiWizardStepState("a", "Server", true),
            new MuiWizardStepState("b", "Account", false),
            new MuiWizardStepState("c", "Confirm", true),
        };

        [Fact]
        public void CanAdvance_ValidCurrentStep_ReturnsTrue()
        {
            Assert.True(MuiSetupWizardLogic.CanAdvance(ThreeSteps, 0));
        }

        [Fact]
        public void CanAdvance_InvalidCurrentStep_ReturnsFalse()
        {
            Assert.False(MuiSetupWizardLogic.CanAdvance(ThreeSteps, 1));
        }

        [Fact]
        public void CanAdvance_OutOfRangeIndex_ReturnsFalse()
        {
            Assert.False(MuiSetupWizardLogic.CanAdvance(ThreeSteps, 5));
        }

        [Fact]
        public void NextIndex_FromValidStep_Advances()
        {
            Assert.Equal(1, MuiSetupWizardLogic.NextIndex(ThreeSteps, 0));
        }

        [Fact]
        public void NextIndex_FromInvalidStep_StaysPut()
        {
            Assert.Equal(1, MuiSetupWizardLogic.NextIndex(ThreeSteps, 1));
        }

        [Fact]
        public void NextIndex_FromLastStep_ClampsAtLastIndex()
        {
            Assert.Equal(2, MuiSetupWizardLogic.NextIndex(ThreeSteps, 2));
        }

        [Fact]
        public void PreviousIndex_ClampsAtZero()
        {
            Assert.Equal(0, MuiSetupWizardLogic.PreviousIndex(0));
        }

        [Fact]
        public void PreviousIndex_DecrementsNormally()
        {
            Assert.Equal(1, MuiSetupWizardLogic.PreviousIndex(2));
        }

        [Fact]
        public void IsReachable_FirstStep_AlwaysReachable()
        {
            Assert.True(MuiSetupWizardLogic.IsReachable(ThreeSteps, 0));
        }

        [Fact]
        public void IsReachable_StepAfterValidStep_IsReachable()
        {
            Assert.True(MuiSetupWizardLogic.IsReachable(ThreeSteps, 1));
        }

        [Fact]
        public void IsReachable_StepAfterInvalidStep_IsNotReachable()
        {
            Assert.False(MuiSetupWizardLogic.IsReachable(ThreeSteps, 2));
        }

        [Fact]
        public void IsReachable_OutOfRange_ReturnsFalse()
        {
            Assert.False(MuiSetupWizardLogic.IsReachable(ThreeSteps, 99));
            Assert.False(MuiSetupWizardLogic.IsReachable(ThreeSteps, -1));
        }

        [Fact]
        public void IsComplete_AllValid_ReturnsTrue()
        {
            var steps = new[] { new MuiWizardStepState("a", "A", true), new MuiWizardStepState("b", "B", true) };
            Assert.True(MuiSetupWizardLogic.IsComplete(steps));
        }

        [Fact]
        public void IsComplete_OneInvalid_ReturnsFalse()
        {
            Assert.False(MuiSetupWizardLogic.IsComplete(ThreeSteps));
        }

        [Fact]
        public void IsComplete_EmptySteps_ReturnsFalse()
        {
            Assert.False(MuiSetupWizardLogic.IsComplete(System.Array.Empty<MuiWizardStepState>()));
        }
    }
}
