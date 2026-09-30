using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    public event Action? DetailInvalidated;
    public DecodedImage? DetailSource { get { lock (_gate) return _image; } }
    private void InvalidateDetail() => DetailInvalidated?.Invoke();
    internal Task<FilmLut?> LoadDetailFilmAsync(string look, CancellationToken cancellation) => _filmCache.LoadAsync(look, cancellation);
}
