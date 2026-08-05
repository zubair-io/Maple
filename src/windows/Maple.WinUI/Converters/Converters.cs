using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;

namespace Maple.WinUI.Converters
{
    /// <summary>"pick" flag → Visible; anything else collapsed.</summary>
    public sealed class PickFlagVisibleConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language) =>
            value is string s && s == "pick" ? Visibility.Visible : Visibility.Collapsed;

        public object ConvertBack(object value, Type targetType, object parameter, string language) =>
            throw new NotSupportedException();
    }

    public sealed class BoolVisibleConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, string language) =>
            value is true ? Visibility.Visible : Visibility.Collapsed;

        public object ConvertBack(object value, Type targetType, object parameter, string language) =>
            throw new NotSupportedException();
    }
}
