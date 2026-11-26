using System.Reflection;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

[Collection("AppSettingsFile")]
public sealed class AppSettingsCacheTests : IDisposable
{
    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "settings.json");

    private readonly bool _existedBefore = File.Exists(SettingsPath);
    private readonly string? _originalContent = File.Exists(SettingsPath) ? File.ReadAllText(SettingsPath) : null;

    public void Dispose()
    {
        if (_existedBefore)
            File.WriteAllText(SettingsPath, _originalContent!);
        else if (File.Exists(SettingsPath))
            File.Delete(SettingsPath);
        AppSettings.Load();
    }

    [Fact]
    public void A_caller_that_changes_what_it_loaded_does_not_change_what_the_next_caller_loads()
    {
        new AppSettings { LibraryFolders = { @"C:\Photos" }, BrowseSort = "Name" }.Save();
        AppSettings.Load();

        var first = AppSettings.Load();
        first.LibraryFolders.Add(@"D:\Never saved");
        first.BrowseSort = "Rating";
        var second = AppSettings.Load();
        second.LibraryFolders.Clear();
        var third = AppSettings.Load();

        Assert.Equal(new[] { @"C:\Photos" }, third.LibraryFolders);
        Assert.Equal("Name", third.BrowseSort);
        Assert.NotSame(first, second);
        Assert.NotSame(second, third);
    }

    [Fact]
    public void A_save_is_visible_to_the_next_load_even_when_length_and_write_time_match_the_cached_file()
    {
        new AppSettings { BrowseSort = "Name" }.Save();
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(SettingsPath, stamp);
        Assert.Equal("Name", AppSettings.Load().BrowseSort);

        new AppSettings { BrowseSort = "Date" }.Save();
        File.SetLastWriteTimeUtc(SettingsPath, stamp);

        Assert.Equal("Date", AppSettings.Load().BrowseSort);
    }

    [Fact]
    public void An_edit_made_outside_this_process_is_picked_up()
    {
        new AppSettings { ThumbnailSize = 128 }.Save();
        Assert.Equal(128, AppSettings.Load().ThumbnailSize);

        File.WriteAllText(SettingsPath, "{\"ThumbnailSize\": 240, \"LibraryFolders\": [\"E:\\\\Edited\"]}");

        var loaded = AppSettings.Load();
        Assert.Equal(240, loaded.ThumbnailSize);
        Assert.Equal(new[] { @"E:\Edited" }, loaded.LibraryFolders);
    }

    [Fact]
    public void Update_still_changes_only_its_own_field_on_top_of_the_current_file()
    {
        new AppSettings { LibraryFolders = { @"C:\Photos" } }.Save();
        AppSettings.Load();

        AppSettings.Update(s => s.LeftPanelHidden = true);

        var loaded = AppSettings.Load();
        Assert.True(loaded.LeftPanelHidden);
        Assert.Equal(new[] { @"C:\Photos" }, loaded.LibraryFolders);
    }

    [Fact]
    public void A_missing_or_corrupt_file_loads_the_defaults()
    {
        File.Delete(SettingsPath);
        Assert.Empty(AppSettings.Load().LibraryFolders);

        File.WriteAllText(SettingsPath, "{ not json");
        var corrupt = AppSettings.Load();
        Assert.Empty(corrupt.LibraryFolders);
        Assert.Equal(180, corrupt.ThumbnailSize);
    }

    [Fact]
    public void Every_settings_property_is_either_immutable_or_covered_by_the_copy()
    {
        var mutableReferenceProperties = typeof(AppSettings)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanWrite && !p.PropertyType.IsValueType && p.PropertyType != typeof(string))
            .Select(p => p.Name)
            .ToArray();

        Assert.Equal(new[] { nameof(AppSettings.LibraryFolders) }, mutableReferenceProperties);
    }
}
