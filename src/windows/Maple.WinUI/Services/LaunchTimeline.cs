using System;
using System.Collections.Generic;

namespace Maple.WinUI.Services
{
    internal static class LaunchTimeline
    {
        private static readonly List<(string Name, DateTime Utc)> Entries = new();

        internal static void Mark(string name)
        {
            lock (Entries) Entries.Add((name, DateTime.UtcNow));
        }

        internal static (string Name, DateTime Utc)[] Snapshot()
        {
            lock (Entries) return Entries.ToArray();
        }
    }
}
