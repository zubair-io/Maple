using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    // The background render loop owns this reference. Refine uses the same
    // immutable snapshot, so it does not serialize/validate the model twice.
    private AdjustmentState? _validatedRasterState;

    private bool ValidateRasterState(AdjustmentState snapshot)
    {
        if (ReferenceEquals(snapshot, _validatedRasterState)) return true;
        try
        {
            RenderEngine.ValidateRasterAdjustments(snapshot);
            _validatedRasterState = snapshot;
            return true;
        }
        catch (Exception error)
        {
            RenderFailed?.Invoke(error.Message);
            return false;
        }
    }
}
