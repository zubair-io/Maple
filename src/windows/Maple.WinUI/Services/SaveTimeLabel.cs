using System;

namespace Maple.WinUI.Services;

public static class SaveTimeLabel
{
    public static string Format(DateTimeOffset? saved, DateTimeOffset now)
    {
        if (saved == null) return string.Empty;
        var age = now - saved.Value;
        if (age < TimeSpan.Zero) return $" · Saved {saved.Value.ToLocalTime():g}";
        if (age.TotalMinutes < 1) return " · Saved just now";
        if (age.TotalHours < 1) return $" · Saved {(int)age.TotalMinutes}m ago";
        if (age.TotalDays < 1) return $" · Saved {(int)age.TotalHours}h ago";
        return $" · Saved {(int)age.TotalDays}d ago";
    }
}
