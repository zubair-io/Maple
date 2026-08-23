using System;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Plain, WinUI-free logic behind the Maple.UI Avatar atom
    /// (docs/unified-component-catalog.md §1.4 "Avatar" row: "Fallback color
    /// derivation" + initials fallback). Split out the same way
    /// MuiTimestampFormatter.cs is, so it links into Maple.WinUI.Tests
    /// (net8.0, no WinUI) and is the one part of this atom CI can actually
    /// exercise without a live Window.
    ///
    /// Deliberately NOT <c>string.GetHashCode()</c> for the palette pick:
    /// .NET randomizes that hash per process (a security hardening measure),
    /// so the same name would land on a different swatch every app launch —
    /// wrong for an identity cue a user learns to recognize at a glance.
    /// FNV-1a is used instead: same input, same output, forever, on every
    /// platform.
    /// </summary>
    public static class MuiAvatarPalette
    {
        /// <summary>32-bit FNV-1a — small, dependency-free, stable across
        /// processes and platforms (unlike <c>string.GetHashCode()</c>).
        /// Also reused by MuiQrPlaceholderPattern for the same
        /// "deterministic forever" reason.</summary>
        public static uint StableHash(string value)
        {
            const uint offsetBasis = 2166136261;
            const uint prime = 16777619;
            var hash = offsetBasis;
            foreach (var ch in value)
            {
                hash ^= ch;
                hash *= prime;
            }
            return hash;
        }

        /// <summary>Deterministically picks one of <paramref name="paletteSize"/>
        /// swatch slots for <paramref name="name"/>. Empty/whitespace names
        /// always land on slot 0 rather than hashing an empty string (still
        /// deterministic, just not name-derived).</summary>
        public static int PaletteIndex(string name, int paletteSize)
        {
            if (paletteSize <= 0)
                throw new ArgumentOutOfRangeException(nameof(paletteSize));
            if (string.IsNullOrWhiteSpace(name))
                return 0;
            return (int)(StableHash(name) % (uint)paletteSize);
        }

        /// <summary>Up to two initials from the first and last whitespace-
        /// separated words ("Ada Lovelace" -> "AL"; "Cher" -> "C"; "" ->
        /// "").</summary>
        public static string Initials(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
                return string.Empty;

            var parts = name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
                return string.Empty;

            var first = char.ToUpperInvariant(parts[0][0]);
            if (parts.Length == 1)
                return first.ToString();

            var last = char.ToUpperInvariant(parts[^1][0]);
            return $"{first}{last}";
        }
    }
}
