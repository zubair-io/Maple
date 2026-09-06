using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public class FolderNavigationTests
{
    [Fact]
    public void TileNavigationExpandsAncestorsAndSelectsLoadedChild()
    {
        var root = new FolderNode { Path = @"C:\Photos" };
        var child = new FolderNode { Path = @"C:\Photos\Trip" };
        var leaf = new FolderNode { Path = @"C:\Photos\Trip\Day 1" };
        root.Children.Add(child);
        child.Children.Add(leaf);
        FolderNavigation.Synchronize([root], [], leaf.Path, null, _ => { }, _ => { });
        Assert.True(root.IsExpanded);
        Assert.True(child.IsExpanded);
        Assert.True(leaf.IsSelected);
        Assert.False(root.IsSelected);
        Assert.False(leaf.IsExpanded);
    }

    [Fact]
    public void LazyCompletionUsesLatestTargetAndDoesNotSelectStaleFolder()
    {
        var root = new FolderNode { Path = @"C:\Photos" };
        var requested = new List<FolderNode>();
        FolderNavigation.Synchronize([root], [], @"C:\Photos\Old", null, requested.Add, _ => { });
        Assert.Contains(root, requested);
        var old = new FolderNode { Path = @"C:\Photos\Old" };
        var current = new FolderNode { Path = @"C:\Photos\New" };
        root.Children.Add(old);
        root.Children.Add(current);
        FolderNavigation.Synchronize([root], [], current.Path, null, _ => { }, _ => { });
        Assert.False(old.IsSelected);
        Assert.True(current.IsSelected);
    }

    [Fact]
    public void LocalPathIsCaseInsensitiveButRequiresDirectoryBoundary()
    {
        var root = new FolderNode { Path = @"C:\Photos" };
        FolderNavigation.Synchronize([root], [], @"c:\photos2\Trip", null,
            _ => throw new Exception("Unrelated root expanded"), _ => { });
        Assert.False(root.IsExpanded);
        FolderNavigation.Synchronize([root], [], @"c:\PHOTOS", null, _ => { }, _ => { });
        Assert.True(root.IsSelected);
    }

    [Fact]
    public void CloudRevealUsesLibraryAndRelativePathAcrossSymlinkRoots()
    {
        var root = new CloudFolderNode { Path = "/mount/link", LibrarySlug = "photos" };
        var child = new CloudFolderNode { Path = "/real/Trip", RelativePath = "Trip", LibrarySlug = "photos" };
        var other = new CloudFolderNode { LibrarySlug = "other", IsSelected = true };
        var local = new FolderNode { Path = @"C:\Photos", IsSelected = true };
        root.Children.Add(child);
        var tile = new CloudFolderNode { Path = child.Path, RelativePath = "Trip", LibrarySlug = "photos" };
        FolderNavigation.Synchronize([local], [root, other], null, tile, _ => { }, _ => { });
        Assert.True(root.IsExpanded);
        Assert.True(child.IsSelected);
        Assert.False(other.IsSelected);
        Assert.False(local.IsSelected);
    }

    [Fact]
    public void TimelineClearsBothFolderSelectionsWithoutCollapsingTrees()
    {
        var local = new FolderNode { IsSelected = true, IsExpanded = true };
        var cloud = new CloudFolderNode { IsSelected = true, IsExpanded = true };
        FolderNavigation.Synchronize([local], [cloud], null, null, _ => { }, _ => { });
        Assert.False(local.IsSelected);
        Assert.False(cloud.IsSelected);
        Assert.True(local.IsExpanded);
        Assert.True(cloud.IsExpanded);
    }
}
