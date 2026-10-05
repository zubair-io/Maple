import MapleAgentWire

extension MCPToolCatalog {
  static let exportTools: [JSONValue] = [
    [
      "name": "maple_export_photo",
      "title": "Export photo",
      "description":
        "Export the active photo with its edits using Maple's defaults: full-resolution JPEG sRGB, 92% quality. Saves a new file in Maple's Documents/Exports folder and returns its absolute path on this Mac. Originals and existing exports are never replaced. Call maple_get_active_photo first and pass its revision. No format or destination options are needed.",
      "inputSchema": [
        "type": "object", "properties": ["expected_revision": revisionProperty],
        "required": ["expected_revision"], "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "photo_id": ["type": "string"], "revision": ["type": "string"],
          "path": ["type": "string"], "file_name": ["type": "string"],
          "format": ["type": "string", "enum": ["jpeg_srgb"]],
          "byte_count": ["type": "integer", "minimum": 1],
        ],
        "required": ["photo_id", "revision", "path", "file_name", "format", "byte_count"],
      ],
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false,
        "openWorldHint": false,
      ],
    ]
  ]
}
