using System;
using System.IO;

namespace Maple.WinUI.Services;

// #4148: capture before decode, then validate again before retaining a fit.
internal readonly record struct ProfileSourceGeneration(string Path, long Modified, long Length)
{
    internal static ProfileSourceGeneration Read(string path)
    {
        var file = new FileInfo(System.IO.Path.GetFullPath(path));
        if (!file.Exists) throw new FileNotFoundException("Auto Profile source is unavailable.", path);
        return new(file.FullName, file.LastWriteTimeUtc.Ticks, file.Length);
    }

    internal bool Matches(ProfileSourceGeneration other) =>
        string.Equals(Path, other.Path, StringComparison.OrdinalIgnoreCase)
        && Modified == other.Modified && Length == other.Length;

    internal bool StillCurrent(string path)
    {
        // A successfully decoded image remains usable after a source disappears,
        // but its fitted profile must not be donated to a later decode.
        try { return Matches(Read(path)); }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
}

public static unsafe partial class RenderEngine
{
    private static bool CanReuseAutoProfile(DecodedImage? donor, ProfileSourceGeneration source, ProfileFitContext fit) =>
        donor?.ProfileSource is { } previous && previous.Matches(source) && donor.ProfileFit == fit;
}

// Render-origin calibration identity, independent of a reduced presentation
// buffer's dimensions. Native detail and half-size frames retain this identity.
internal readonly record struct ProfileFitContext(uint LongEdge, int Quality);
