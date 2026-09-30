using System;
using System.Linq;
using Maple.WinUI.Generated;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    public void SelectFilm(string id)
    {
        if (SelectedPhoto == null || (id.Length != 0 && !FilmCatalog.All.Any(look => look.Id == id))) return;
        if (Adjustments.FilmLook == id && (id.Length != 0 || Adjustments.FilmStrength == 100)) return;
        // This helper records one boundary and only re-decodes if decode-owned
        // fields changed. Film remains a live chain stage, so it reuses the base.
        ApplyDecodeFieldEdit(model =>
        {
            model.FilmLook = id;
            if (id.Length == 0) model.FilmStrength = 100;
        });
    }

    public void SetFilmStrength(double strength)
    {
        if (SelectedPhoto == null || !double.IsFinite(strength) || strength < 0 || strength > 100
            || Adjustments.FilmStrength == strength || string.IsNullOrEmpty(Adjustments.FilmLook)) return;
        Adjustments.FilmStrength = strength;
        NotifyAdjustmentEdited();
    }
}
