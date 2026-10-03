import MapleAgentWire

extension MCPToolCatalog {
  public static let browseTools: [JSONValue] = [
    [
      "name": "maple_list_photos",
      "title": "List photos",
      "description":
        "Page through photos in the active folder or collection, returning asset IDs, file names, capture timestamps, current star ratings (0-5), flags (none/pick/reject), and color labels.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "offset": [
            "type": "integer", "description": "0-based offset into the photo collection.",
            "minimum": 0,
          ],
          "limit": [
            "type": "integer",
            "description": "Maximum number of photos to return (1-100, default 50).", "minimum": 1,
            "maximum": 100,
          ],
        ],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "photos": [
            "type": "array",
            "items": [
              "type": "object",
              "properties": [
                "id": ["type": "string"],
                "name": ["type": "string"],
                "path": ["type": "string"],
                "rating": ["type": "integer"],
                "flag": ["type": "string"],
                "color_label": ["type": "string"],
                "is_active": ["type": "boolean"],
                "capture_time": ["type": "string"],
              ],
              "required": ["id", "name", "rating", "flag"],
            ],
          ],
          "total_count": ["type": "integer"],
          "offset": ["type": "integer"],
          "limit": ["type": "integer"],
          "collection_name": ["type": "string"],
          "folder_path": ["type": "string"],
        ],
        "required": ["photos", "total_count", "offset", "limit"],
      ],
      "annotations": ["readOnlyHint": true, "idempotentHint": true, "openWorldHint": false],
    ],
    [
      "name": "maple_get_thumbnails",
      "title": "Get thumbnails",
      "description":
        "Batch retrieve thumbnail/preview JPEGs from Maple for visual inspection, culling, and rating photos without heavy RAW decodes. Returns images directly in content.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "asset_ids": [
            "type": "array", "items": ["type": "string"],
            "description": "List of photo UUIDs to retrieve thumbnails for (1 to 20).",
            "minItems": 1, "maxItems": 20,
          ],
          "max_edge": [
            "type": "integer",
            "description": "Maximum edge dimension in pixels (256..1024, default 512).",
            "minimum": 256, "maximum": 1024,
          ],
        ],
        "required": ["asset_ids"],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "thumbnails": [
            "type": "array",
            "items": [
              "type": "object",
              "properties": [
                "asset_id": ["type": "string"],
                "name": ["type": "string"],
                "width": ["type": "integer"],
                "height": ["type": "integer"],
              ],
              "required": ["asset_id", "name", "width", "height"],
            ],
          ],
          "count": ["type": "integer"],
        ],
        "required": ["thumbnails", "count"],
      ],
      "annotations": ["readOnlyHint": true, "idempotentHint": true, "openWorldHint": false],
    ],
    [
      "name": "maple_set_rating",
      "title": "Set rating",
      "description":
        "Assign star rating (0-5 stars) to a photo in the active collection. Persists to the XMP sidecar.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "asset_id": ["type": "string", "description": "UUID of the photo to rate."],
          "rating": [
            "type": "integer", "description": "Star rating from 0 (unrated) to 5 stars.",
            "minimum": 0, "maximum": 5,
          ],
        ],
        "required": ["asset_id", "rating"],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "asset_id": ["type": "string"],
          "name": ["type": "string"],
          "rating": ["type": "integer"],
          "flag": ["type": "string"],
          "color_label": ["type": "string"],
        ],
        "required": ["asset_id", "rating", "flag"],
      ],
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true,
        "openWorldHint": false,
      ],
    ],
    [
      "name": "maple_set_flag",
      "title": "Set flag",
      "description":
        "Assign culling flag ('pick', 'reject', or 'none') to a photo in the active collection. Persists to the XMP sidecar.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "asset_id": ["type": "string", "description": "UUID of the photo to flag."],
          "flag": [
            "type": "string", "enum": ["none", "pick", "reject"],
            "description": "Cull flag state.",
          ],
        ],
        "required": ["asset_id", "flag"],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "asset_id": ["type": "string"],
          "name": ["type": "string"],
          "rating": ["type": "integer"],
          "flag": ["type": "string"],
          "color_label": ["type": "string"],
        ],
        "required": ["asset_id", "rating", "flag"],
      ],
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true,
        "openWorldHint": false,
      ],
    ],
    [
      "name": "maple_open_photo",
      "title": "Open photo",
      "description":
        "Open a photo from the active collection directly into the editor for deep inspection and develop adjustments. Switches the editor canvas to this photo and returns its full state and revision.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "asset_id": ["type": "string", "description": "UUID of the photo to open."]
        ],
        "required": ["asset_id"],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "photo_id": ["type": "string"],
          "file_name": ["type": "string"],
          "revision": ["type": "string"],
          "can_undo": ["type": "boolean"],
          "image_size": [
            "type": "object",
            "properties": ["width": ["type": "integer"], "height": ["type": "integer"]],
          ],
          "adjustments": ["type": "object"],
        ],
        "required": ["photo_id", "revision", "adjustments"],
      ],
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false,
        "openWorldHint": false,
      ],
    ],
  ]
}
