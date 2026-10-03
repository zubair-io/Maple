import MapleAgentWire

/// The MCP tool surface. Each tool forwards verbatim to the app under the
/// same name; the app validates arguments against Maple's generated schema
/// and is the only source of truth for ranges and state.
public enum MCPToolCatalog {
  static let revisionProperty: JSONValue = [
    "type": "string",
    "description":
      "The `revision` from your most recent Maple result. Maple rejects the call with `stale_revision` if the photo changed since (another photo opened, the user edited, or an undo).",
  ]

  static let stateOutput: JSONValue = [
    "type": "object",
    "properties": [
      "photo_id": ["type": "string"],
      "revision": ["type": "string"],
      "can_undo": ["type": "boolean"],
    ],
    "required": ["photo_id", "revision"],
  ]

  public static let tools: [JSONValue] = [
    [
      "name": "maple_get_active_photo",
      "title": "Get active photo",
      "description":
        "Describe the photo open in Maple's editor: identity, size, a revision token, and every adjustable slider with its current value and allowed [min, max]. Call this first; pass its `revision` to the next edit.",
      "inputSchema": ["type": "object", "properties": [:], "additionalProperties": false],
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
          "adjustments": [
            "type": "object",
            "description": "Slider name → {value, min, max}.",
            "additionalProperties": [
              "type": "object",
              "properties": [
                "value": ["type": "number"], "min": ["type": "number"], "max": ["type": "number"],
              ],
            ],
          ],
        ],
        "required": ["photo_id", "revision", "adjustments"],
      ],
      "annotations": ["readOnlyHint": true, "idempotentHint": true, "openWorldHint": false],
    ],
    [
      "name": "maple_set_adjustments",
      "title": "Set adjustments",
      "description":
        "Set one or more global sliders to absolute values in a single undoable step. Omitted sliders are unchanged. Names and ranges come from maple_get_active_photo (e.g. exposure in EV −4…4, temperature in Kelvin, most others −100…100). Out-of-range or unknown names are rejected, never clamped. The photographer sees the sliders move live.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "expected_revision": revisionProperty,
          "adjustments": [
            "type": "object",
            "description":
              "Slider name → absolute numeric value, e.g. {\"exposure\": 0.4, \"highlights\": -35}.",
            "additionalProperties": ["type": "number"],
            "minProperties": 1,
          ],
          "description": [
            "type": "string",
            "description": "Short label for the undo history, e.g. \"Recover sky\".",
          ],
        ],
        "required": ["expected_revision", "adjustments"],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "photo_id": ["type": "string"],
          "revision": ["type": "string"],
          "can_undo": ["type": "boolean"],
          "applied": [
            "type": "object", "description": "Each changed slider → its new value.",
            "additionalProperties": ["type": "number"],
          ],
        ],
        "required": ["photo_id", "revision", "applied"],
      ],
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true,
        "openWorldHint": false,
      ],
    ],
    [
      "name": "maple_render_and_inspect",
      "title": "Render and inspect",
      "description":
        "Return what the photographer currently sees as a JPEG plus display-referred measurements of that same render (luma percentiles, near-white/near-black occupancy, channel means). Near-white occupancy measures pixels at the top of the display range; it does not prove sensor clipping, and darkening the image lowers it. Use `region` to inspect a detail at higher magnification.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "max_edge": [
            "type": "integer", "minimum": 256, "maximum": 2048, "default": 1024,
            "description": "Longest edge of the returned JPEG in pixels.",
          ],
          "region": [
            "type": "object",
            "description":
              "Normalized crop of the displayed (post-crop, upright) image; origin top-left, all values 0…1.",
            "properties": [
              "x": ["type": "number"], "y": ["type": "number"],
              "width": ["type": "number"], "height": ["type": "number"],
            ],
            "required": ["x", "y", "width", "height"],
            "additionalProperties": false,
          ],
        ],
        "additionalProperties": false,
      ],
      "outputSchema": [
        "type": "object",
        "properties": [
          "photo_id": ["type": "string"],
          "revision": ["type": "string"],
          "width": ["type": "integer"],
          "height": ["type": "integer"],
          "metrics": ["type": "object"],
        ],
        "required": ["photo_id", "revision", "metrics"],
      ],
      "annotations": ["readOnlyHint": true, "idempotentHint": true, "openWorldHint": false],
    ],
    [
      "name": "maple_undo",
      "title": "Undo",
      "description": "Undo Maple's most recent edit step (yours or the photographer's).",
      "inputSchema": [
        "type": "object", "properties": ["expected_revision": revisionProperty],
        "required": ["expected_revision"], "additionalProperties": false,
      ],
      "outputSchema": stateOutput,
      "annotations": ["readOnlyHint": false, "destructiveHint": false, "openWorldHint": false],
    ],
    [
      "name": "maple_reset",
      "title": "Reset to original",
      "description":
        "Reset every adjustment on the photo to its original state as one undoable step. Discards all edits, not just yours.",
      "inputSchema": [
        "type": "object", "properties": ["expected_revision": revisionProperty],
        "required": ["expected_revision"], "additionalProperties": false,
      ],
      "outputSchema": stateOutput,
      "annotations": [
        "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true,
        "openWorldHint": false,
      ],
    ],
  ]

  public static var toolNames: Set<String> {
    Set(tools.compactMap { $0["name"]?.stringValue })
  }
}
