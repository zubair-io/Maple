using System.Xml.Linq;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class BrowseGridVirtualisationTests
{
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml";

    private static XElement Window()
    {
        var folder = new DirectoryInfo(AppContext.BaseDirectory);
        while (folder != null && !File.Exists(Path.Combine(folder.FullName, "Maple.WinUI", "MainWindow.xaml")))
            folder = folder.Parent;
        Assert.NotNull(folder);
        return XDocument.Load(Path.Combine(folder!.FullName, "Maple.WinUI", "MainWindow.xaml")).Root!;
    }

    private static XElement Named(XElement root, string name) =>
        root.Descendants().Single(element => (string?)element.Attribute(Xaml + "Name") == name);

    private static string? Attached(XElement element, string name) => (string?)element.Attribute(name);

    [Fact]
    public void The_browse_grid_lays_its_tiles_out_in_a_virtualising_wrap_panel()
    {
        var grid = Named(Window(), "PhotoGrid");

        Assert.Equal("GridView", grid.Name.LocalName);
        var panel = grid.Element(grid.Name.Namespace + "GridView.ItemsPanel")!
            .Elements().Single().Elements().Single();
        Assert.Equal("ItemsWrapGrid", panel.Name.LocalName);
    }

    [Fact]
    public void The_browse_grid_is_never_given_unbounded_height_by_an_ancestor()
    {
        var grid = Named(Window(), "PhotoGrid");

        var ancestors = grid.Ancestors().ToList();
        Assert.DoesNotContain(ancestors, ancestor => ancestor.Name.LocalName is "ScrollViewer" or "StackPanel" or "ListView" or "ItemsControl");

        foreach (var parent in ancestors.Where(a => a.Name.LocalName == "Grid"))
        {
            var rows = parent.Element(parent.Name.Namespace + "Grid.RowDefinitions")?.Elements().ToList();
            if (rows is not { Count: > 0 })
                continue;
            var row = int.TryParse(Attached(PathChild(grid, parent), "Grid.Row"), out var index) ? index : 0;
            Assert.NotEqual("Auto", (string?)rows[row].Attribute("Height"));
        }
    }

    private static XElement PathChild(XElement descendant, XElement ancestor) =>
        descendant.AncestorsAndSelf().Single(element => element.Parent == ancestor);

    [Fact]
    public void Nothing_switches_the_browse_grids_own_scrolling_off()
    {
        var grid = Named(Window(), "PhotoGrid");

        Assert.NotEqual("Disabled", Attached(grid, "ScrollViewer.VerticalScrollMode"));
        Assert.NotEqual("Disabled", Attached(grid, "ScrollViewer.VerticalScrollBarVisibility"));
        Assert.Null(grid.Attribute("Height"));
    }

    [Fact]
    public void The_subfolder_tiles_are_a_bounded_virtualising_grid_too()
    {
        var tiles = Named(Window(), "BrowseFolderTiles");

        Assert.Equal("GridView", tiles.Name.LocalName);
        Assert.Null(tiles.Element(tiles.Name.Namespace + "GridView.ItemsPanel"));
        Assert.Equal("160", Attached(tiles, "MaxHeight"));
        Assert.Equal("Enabled", Attached(tiles, "ScrollViewer.VerticalScrollMode"));
    }
}
