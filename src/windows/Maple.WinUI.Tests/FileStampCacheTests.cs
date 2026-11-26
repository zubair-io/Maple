using System.Reflection;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class FileStampCacheTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "maple-stamp-" + Guid.NewGuid().ToString("N"));
    private int _reads;

    public FileStampCacheTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }

    private sealed class Box
    {
        public List<string> Items { get; set; } = new();
        public Box Copy() => new() { Items = new List<string>(Items) };
    }

    private FileStampCache<Box> NewCache() => new(box => box.Copy());

    private Box? Read(string path)
    {
        Interlocked.Increment(ref _reads);
        var lines = File.ReadAllLines(path);
        return lines.Length == 0 ? null : new Box { Items = lines.ToList() };
    }

    private string Write(string content)
    {
        var path = Path.Combine(_dir, "settings.txt");
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public void Repeated_gets_read_the_file_once()
    {
        var path = Write("a\nb\n");
        var cache = NewCache();
        for (var i = 0; i < 10; i++)
            Assert.Equal(new[] { "a", "b" }, cache.Get(path, Read)!.Items);
        Assert.Equal(1, _reads);
    }

    [Fact]
    public void A_longer_file_is_read_again()
    {
        var path = Write("a\n");
        var cache = NewCache();
        cache.Get(path, Read);
        Write("a\nb\n");
        Assert.Equal(new[] { "a", "b" }, cache.Get(path, Read)!.Items);
        Assert.Equal(2, _reads);
    }

    [Fact]
    public void A_same_length_rewrite_with_a_new_write_time_is_read_again()
    {
        var path = Write("one\n");
        File.SetLastWriteTimeUtc(path, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var cache = NewCache();
        cache.Get(path, Read);
        Write("two\n");
        File.SetLastWriteTimeUtc(path, new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc));
        Assert.Equal(new[] { "two" }, cache.Get(path, Read)!.Items);
    }

    [Fact]
    public void Invalidate_forces_a_read_even_when_length_and_write_time_are_unchanged()
    {
        var path = Write("one\n");
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, stamp);
        var cache = NewCache();
        cache.Get(path, Read);
        Write("two\n");
        File.SetLastWriteTimeUtc(path, stamp);
        cache.Invalidate();
        Assert.Equal(new[] { "two" }, cache.Get(path, Read)!.Items);
    }

    [Fact]
    public void Every_caller_gets_its_own_copy()
    {
        var path = Write("a\n");
        var cache = NewCache();
        var first = cache.Get(path, Read)!;
        first.Items.Add("mutated");
        var second = cache.Get(path, Read)!;
        second.Items.Add("also mutated");
        Assert.Equal(new[] { "a" }, cache.Get(path, Read)!.Items);
    }

    [Fact]
    public void A_missing_file_gives_null_without_reading()
    {
        Assert.Null(NewCache().Get(Path.Combine(_dir, "absent.txt"), Read));
        Assert.Equal(0, _reads);
    }

    [Fact]
    public void A_file_that_does_not_parse_is_not_cached()
    {
        var path = Write("");
        var cache = NewCache();
        Assert.Null(cache.Get(path, Read));
        Assert.Null(cache.Get(path, Read));
        Assert.Equal(2, _reads);
    }

    [Fact]
    public void A_different_path_is_not_served_from_the_entry()
    {
        var first = Write("a\n");
        var second = Path.Combine(_dir, "other.txt");
        File.WriteAllText(second, "z\n");
        var cache = NewCache();
        cache.Get(first, Read);
        Assert.Equal(new[] { "z" }, cache.Get(second, Read)!.Items);
    }

    [Fact]
    public void Concurrent_gets_all_see_the_content()
    {
        var path = Write("a\nb\n");
        var cache = NewCache();
        Parallel.For(0, 200, _ => Assert.Equal(new[] { "a", "b" }, cache.Get(path, Read)!.Items));
    }

    [Fact]
    public void A_save_that_lands_between_the_read_and_the_store_is_not_overwritten_by_the_old_content()
    {
        var path = Write("old\n");
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, stamp);
        var cache = NewCache();

        var seenByTheReader = cache.Get(path, p =>
        {
            var old = Read(p);
            Write("new\n");
            File.SetLastWriteTimeUtc(path, stamp);
            cache.Invalidate();
            return old;
        });

        Assert.Equal(new[] { "old" }, seenByTheReader!.Items);
        Assert.Equal(new[] { "new" }, cache.Get(path, Read)!.Items);
    }
}
