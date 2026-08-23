using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.8 Configuration gallery specimens, part 1
    /// (Settings Section, Pipeline Monitor, Setup Wizard, User
    /// Management) — wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsConfigurationSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Settings Section", "Heading, Banner, Settings Rows separated by Dividers.", TemplateFrame(
                new MuiSettingsSection
                {
                    Title = "Sync",
                    BannerMessage = "Restart Maple to apply changes.",
                    Rows = new[]
                    {
                        new MuiSettingsSectionRow("auto", "Sync automatically", "history", "Runs every 15 minutes"),
                        new MuiSettingsSectionRow("wifi", "Wi-Fi only", "share-up-square"),
                    },
                }, 320, 220));

            AddSpecimen(panel, "Pipeline Monitor", "Live exif/thumb/describe/geocode stage status.", TemplateFrame(
                new MuiPipelineMonitor
                {
                    Stages = new[]
                    {
                        new MuiPipelineStage("exif", "EXIF extraction", 980, 1000),
                        new MuiPipelineStage("thumb", "Thumbnails", 700, 1000),
                        new MuiPipelineStage("describe", "AI description", 120, 1000, Paused: true),
                        new MuiPipelineStage("geocode", "Geocoding", 1000, 1000),
                    },
                }, 320, 260));

            AddSpecimen(panel, "Setup Wizard", "Validity-gated Progress Step list, per-step body.", TemplateFrame(BuildSetupWizardDemo(), 340, 320));

            AddSpecimen(panel, "User Management", "Invite reveals a QR Code, per-user revoke Dialog.", TemplateFrame(
                new MuiUserManagement
                {
                    Users = new[] { new MuiManagedUser("u1", "Ada Lovelace", "Admin"), new MuiManagedUser("u2", "Grace Hopper", "Member") },
                }, 320, 300));
        }

        private static UIElement BuildSetupWizardDemo()
        {
            var serverField = new MuiInput { Placeholder = "maple.example.com" };
            var accountField = new MuiInput { Placeholder = "Username" };
            var confirmText = new MuiText { Text = "Ready to connect.", Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };

            return new MuiSetupWizard
            {
                CurrentIndex = 1,
                StepValidity = new[] { true, false, false },
                Steps = new[]
                {
                    new MuiWizardStepContent("server", "Server", serverField),
                    new MuiWizardStepContent("account", "Account", accountField),
                    new MuiWizardStepContent("confirm", "Confirm", confirmText),
                },
            };
        }
    }
}
