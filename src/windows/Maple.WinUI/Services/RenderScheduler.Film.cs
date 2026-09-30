using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    private readonly FilmLutCache _filmCache = new();
    // Only the serial render worker changes this reference. A dispatched GPU
    // present completes before that worker can process another snapshot.
    private FilmLut? _activeFilm;

    private bool PrepareFilm(AdjustmentState state)
    {
        try
        {
            if (!double.IsFinite(state.FilmStrength) || state.FilmStrength < 0 || state.FilmStrength > 100)
                throw new InvalidOperationException("Film strength must be between 0 and 100.");
            if (string.IsNullOrEmpty(state.FilmLook)) _activeFilm = null;
            else if (_activeFilm?.Id != state.FilmLook)
                // First use loads on the worker, before any frame is presented.
                // Strength ticks retain the same native handle and GPU lattice.
                _activeFilm = _filmCache.LoadAsync(state.FilmLook, _cts.Token).GetAwaiter().GetResult();
            return true;
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested) { return false; }
        catch (Exception error)
        {
            RenderFailed?.Invoke($"Cannot preview film look '{state.FilmLook}': {error.Message}");
            return false;
        }
    }
}
