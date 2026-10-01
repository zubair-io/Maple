using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    internal static async Task VerifyLocalPreviewAsync(string fixture)
    {
        var sidecar = SidecarStore.SidecarPathFor(fixture);
        var baseline = new AdjustmentState { Profile = ProfileMode.Neutral, Exposure = 2 };
        File.WriteAllText(sidecar, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = baseline }));
        using var session = new EditSessionViewModel(restoreSources: false);
        var photo = new PhotoItem { FilePath = fixture, FileName = Path.GetFileName(fixture) };
        session.SelectedPhoto = photo;
        await Wait(() => photo.PreviewPath != null, "Cold edited selection did not publish a preview");
        var cold = photo.PreviewPath;
        if (session._decodedPhoto != null || !cold!.Contains("edited-"))
            throw new InvalidOperationException("Cold Browse preview depends on opening Editor");
        session.Adjustments.Exposure = 1;
        session.ScheduleSidecarWrite();
        session.FlushSidecarNow();
        await Wait(() => photo.PreviewPath != cold, "Saved adjustment did not refresh Browse");
        File.WriteAllText(sidecar, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = baseline }));
        session.OnSidecarChangedOnDisk(null, sidecar);
        await Wait(() => photo.PreviewPath == cold, "External sidecar reset did not restore cached preview");

        // Requests are issued on the UI thread in one turn. Their dispatcher
        // completions cannot publish until after the selection is replaced.
        var abandoned = new PhotoItem { FilePath = fixture, FileName = photo.FileName };
        session.SelectedPhoto = abandoned;
        session.SelectedPhoto = photo;
        await Wait(() => session._previewRequest == null, "Latest preview request did not settle");
        if (abandoned.PreviewPath != null || photo.PreviewPath != cold)
            throw new InvalidOperationException("Stale selection published an edited preview");

        static async Task Wait(Func<bool> ready, string error)
        {
            var timer = Stopwatch.StartNew();
            while (!ready() && timer.Elapsed < TimeSpan.FromSeconds(60)) await Task.Delay(20);
            if (!ready()) throw new InvalidOperationException(error);
        }
    }
}
