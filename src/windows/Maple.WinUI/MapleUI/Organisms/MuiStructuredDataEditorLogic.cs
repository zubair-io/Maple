using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Maple.UI
{
    /// <summary>One key/value row of a flat JSON object, as the form view
    /// of <see cref="MuiStructuredDataEditor"/> edits it.</summary>
    public sealed record MuiStructuredField(string Key, string Value);

    /// <summary>
    /// The code&lt;-&gt;form conversion behind <see cref="MuiStructuredDataEditor"/>
    /// (unified-component-catalog.md §4.5, "Structured Data Editor" row:
    /// "JSON as code or as a form" — this wave's brief scopes it to flat
    /// JSON, i.e. a single object whose values are strings/numbers/bools/
    /// null, no nested objects or arrays). Pure over
    /// <see cref="System.Text.Json"/> — unit tested without a live
    /// Window; the control itself only swaps a <c>MuiCodeBlock</c>-style
    /// text view and a generated stack of <c>MuiFormField</c>s bound to
    /// the same field list.
    /// </summary>
    public static class MuiStructuredDataEditorLogic
    {
        public static IReadOnlyList<MuiStructuredField> ParseFlatJson(string json, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(json))
            {
                error = "Empty document.";
                return Array.Empty<MuiStructuredField>();
            }

            try
            {
                using var document = JsonDocument.Parse(json);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    error = "Root value must be a JSON object.";
                    return Array.Empty<MuiStructuredField>();
                }

                var fields = new List<MuiStructuredField>();
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                    {
                        error = $"Field \"{property.Name}\" is not flat — nested objects/arrays aren't supported.";
                        return Array.Empty<MuiStructuredField>();
                    }
                    fields.Add(new MuiStructuredField(property.Name, RawValue(property.Value)));
                }
                return fields;
            }
            catch (JsonException ex)
            {
                error = ex.Message;
                return Array.Empty<MuiStructuredField>();
            }
        }

        public static string ToJson(IReadOnlyList<MuiStructuredField> fields)
        {
            var ordered = new Dictionary<string, string>();
            foreach (var field in fields) ordered[field.Key] = field.Value;
            return JsonSerializer.Serialize(ordered, new JsonSerializerOptions { WriteIndented = true });
        }

        private static string RawValue(JsonElement element) => element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? string.Empty,
            JsonValueKind.Null => string.Empty,
            _ => element.GetRawText(),
        };
    }
}
