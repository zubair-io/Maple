using System;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.8 Configuration gallery specimens, part 2
    /// (Device List, Backup Monitor, Diagnostics) — wave N6 second push
    /// (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsConfigurationBSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Device List", "Paired devices, relative Timestamp, confirm-gated Unpair.", Row(
                TemplateFrame(new MuiDeviceList
                {
                    Devices = new[] { new MuiPairedDevice("d1", "iPhone 17 Pro", DateTimeOffset.Now.AddMinutes(-4)), new MuiPairedDevice("d2", "iPad Pro", DateTimeOffset.Now.AddDays(-2)) },
                }, 260, 160),
                TemplateFrame(new MuiDeviceList { Devices = Array.Empty<MuiPairedDevice>() }, 220, 160)));

            AddSpecimen(panel, "Backup Monitor", "Destination Form Field, live Progress, outcome Banner.", TemplateFrame(
                new MuiBackupMonitor { Destination = "smb://backup-nas/maple", IsRunning = true, ProgressPercent = 62, StatusMessage = "Last backup completed 2 hours ago.", StatusVariant = MuiBannerVariant.Success },
                320, 220));

            AddSpecimen(panel, "Diagnostics", "Run-all Button, per-check status Badge, raw Code Block output.", TemplateFrame(
                new MuiDiagnostics
                {
                    Checks = new[]
                    {
                        new MuiDiagnosticCheck("db", "Database connection", MuiDiagnosticStatus.Passed),
                        new MuiDiagnosticCheck("gpu", "GPU pipeline", MuiDiagnosticStatus.Failed),
                        new MuiDiagnosticCheck("storage", "Storage write test", MuiDiagnosticStatus.NotRun),
                    },
                    RawOutput = "db: OK (12ms)\ngpu: FAIL — no adapter found\nstorage: not run",
                }, 340, 260));
        }
    }
}
