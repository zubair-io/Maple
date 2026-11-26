using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class LocalFolderScanTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "maple-scan-" + Guid.NewGuid().ToString("N"));

    public LocalFolderScanTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }

    private string Photo(string name, int bytes = 64)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, new byte[bytes]);
        File.SetLastWriteTimeUtc(path, new DateTime(2026, 3, 1, 12, 0, 0, DateTimeKind.Utc).AddMinutes(bytes));
        return path;
    }

    private static void Sidecar(string photoPath, int? rating, string? flag, string? label) =>
        SidecarStore.Save(photoPath, new XmpSidecarDocument { Rating = rating, Flag = flag, ColorLabel = label });

    private List<string> Populate()
    {
        var paths = new List<string>
        {
            Photo("a-rated.dng", 10),
            Photo("b-plain.cr3", 20),
            Photo("c-corrupt-sidecar.jpg", 30),
            Photo("d-directory-as-sidecar.nef", 40),
            Photo("e-flag-only.arw", 50),
            Photo("F-UPPER.TIF", 60),
        };
        Sidecar(paths[0], 3, "pick", "red");
        File.WriteAllText(Path.ChangeExtension(paths[2], ".xmp"), "<not-xmp");
        Directory.CreateDirectory(Path.ChangeExtension(paths[3], ".xmp"));
        Sidecar(paths[4], null, "reject", null);
        Sidecar(paths[5], 5, null, "blue");
        return paths;
    }

    private static PhotoItem? OldPath(string filePath)
    {
        try
        {
            var info = new FileInfo(filePath);
            var item = new PhotoItem
            {
                FilePath = filePath,
                FileName = info.Name,
                Format = info.Extension.TrimStart('.').ToUpperInvariant(),
                FileSizeBytes = info.Length,
                FileModifiedUtc = info.LastWriteTimeUtc,
            };
            var sidecar = SidecarStore.Load(filePath);
            if (sidecar != null)
            {
                item.Rating = sidecar.Rating ?? 0;
                item.FlagStatus = sidecar.Flag ?? "none";
                item.ColorLabel = sidecar.ColorLabel;
            }
            return item;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string Describe(PhotoItem item) =>
        $"{item.FilePath}|{item.FileName}|{item.Format}|{item.FileSizeBytes}|{item.FileModifiedUtc.Ticks}|{item.Rating}|{item.FlagStatus}|{item.ColorLabel}";

    private static List<string> OldResult(IEnumerable<string> paths) =>
        paths.Select(OldPath).Where(item => item != null).Select(item => Describe(item!)).ToList();

    private static readonly HashSet<string> Supported = new(StringComparer.OrdinalIgnoreCase)
    {
        ".dng", ".arw", ".cr3", ".cr2", ".nef", ".orf", ".rw2", ".pef", ".raf", ".srw", ".tif", ".tiff", ".jpg", ".jpeg",
    };

    private PhotoFolderListing Listing() => PhotoFolderListing.Read(_dir, Supported);

    [Fact]
    public void The_scan_gives_the_same_items_in_the_same_order_as_the_per_photo_path()
    {
        var paths = Populate();

        var scanned = LocalFolderScan.Default.Scan(Listing(), CancellationToken.None);

        Assert.Equal(OldResult(Listing().Images), scanned.Select(Describe).ToList());
        Assert.Equal(paths.Count, scanned.Count);
        Assert.Equal(3, scanned.Single(i => i.FileName == "a-rated.dng").Rating);
        Assert.Equal("pick", scanned.Single(i => i.FileName == "a-rated.dng").FlagStatus);
        Assert.Equal("red", scanned.Single(i => i.FileName == "a-rated.dng").ColorLabel);
        Assert.Equal("none", scanned.Single(i => i.FileName == "b-plain.cr3").FlagStatus);
        Assert.Equal("reject", scanned.Single(i => i.FileName == "e-flag-only.arw").FlagStatus);
    }

    [Fact]
    public void The_listing_gives_the_same_images_pair_inventory_and_case_behaviour_as_the_enumeration_it_replaces()
    {
        Populate();
        File.WriteAllBytes(Path.Combine(_dir, "notes.txt"), new byte[3]);
        File.WriteAllBytes(Path.Combine(_dir, "g-raw-only.RW2"), new byte[3]);
        File.WriteAllBytes(Path.Combine(_dir, "f-UPPER.JPG"), new byte[3]);

        var all = Directory.EnumerateFiles(_dir, "*.*", SearchOption.TopDirectoryOnly).ToList();
        var listing = Listing();

        Assert.Equal(
            all.Where(f => Supported.Contains(Path.GetExtension(f))).OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList(),
            listing.Images);
        Assert.Equal(all.Where(RawJpegPairing.IsPairCandidate).OrderBy(f => f, StringComparer.Ordinal).ToList(),
            listing.PairInventory.OrderBy(f => f, StringComparer.Ordinal).ToList());
        Assert.Equal(LocalFileOperations.FolderFoldsCase(all.Where(RawJpegPairing.IsPairCandidate).ToList()), listing.FoldsCase);
        Assert.True(listing.Complete);
    }

    [Fact]
    public void A_folder_that_cannot_be_listed_gives_the_empty_incomplete_listing_main_gave_and_an_empty_scan()
    {
        var listing = PhotoFolderListing.Read(Path.Combine(_dir, "gone"), Supported);

        Assert.Empty(listing.Images);
        Assert.Empty(listing.PairInventory);
        Assert.Empty(listing.Entries);
        Assert.False(listing.Complete);
        Assert.False(listing.FoldsCase);
        Assert.Empty(LocalFolderScan.Default.Scan(listing, CancellationToken.None));
    }

    [Fact]
    public void A_listed_sidecar_that_disappears_before_it_is_read_reads_as_no_sidecar()
    {
        var paths = Populate();
        var listing = Listing();
        File.Delete(Path.ChangeExtension(paths[0], ".xmp"));

        var scanned = LocalFolderScan.Default.Scan(listing, CancellationToken.None);

        var item = scanned.Single(i => i.FileName == "a-rated.dng");
        Assert.Equal(0, item.Rating);
        Assert.Equal("none", item.FlagStatus);
        Assert.Null(item.ColorLabel);
        Assert.Equal(6, scanned.Count);
    }

    [Fact]
    public void A_sidecar_that_appears_after_the_listing_is_not_seen_by_this_scan()
    {
        var paths = Populate();
        var listing = Listing();
        Sidecar(paths[1], 4, "pick", "green");

        var scanned = LocalFolderScan.Default.Scan(listing, CancellationToken.None);

        Assert.Equal(0, scanned.Single(i => i.FileName == "b-plain.cr3").Rating);
    }

    [Fact]
    public void Sidecars_are_read_only_where_the_listing_names_them()
    {
        Populate();
        var sidecarReads = new List<string>();
        var scan = new LocalFolderScan(path => { sidecarReads.Add(Path.GetFileName(path)); return SidecarStore.LoadWhenPresent(path); });

        scan.Scan(Listing(), CancellationToken.None);

        Assert.Equal(
            new[] { "a-rated.dng", "c-corrupt-sidecar.jpg", "e-flag-only.arw", "F-UPPER.TIF" },
            sidecarReads.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToArray());
    }

    [Fact]
    public void A_cancelled_scan_stops_producing_items()
    {
        Populate();
        using var cts = new CancellationTokenSource();
        var reads = 0;
        var scan = new LocalFolderScan(path => { if (++reads == 2) cts.Cancel(); return SidecarStore.LoadWhenPresent(path); });

        var scanned = scan.Scan(Listing(), cts.Token);

        Assert.True(scanned.Count < 6);
        Assert.Empty(LocalFolderScan.Default.Scan(Listing(), new CancellationToken(canceled: true)));
    }
}
