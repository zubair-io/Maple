/**
 * FFI symbol descriptors for libraw_ffi
 */

export function getFfiSymbols(FFIType: Record<string, string | number>) {
  return {
    maple_export_developed_to_file: {
      args: [
        FFIType.cstring, // raw_path
        FFIType.cstring, // xmp_path (nullable)
        FFIType.cstring, // format
        FFIType.u8, // quality
        FFIType.cstring, // color_space
        FFIType.u32, // max_long_edge
        FFIType.cstring, // out_path
      ],
      returns: FFIType.i32,
    },
    maple_export_recipe_to_file: {
      args: [
        FFIType.cstring, // raw_path
        FFIType.cstring, // xmp_xml
        FFIType.cstring, // recipe_json
        FFIType.cstring, // film_path (nullable)
        FFIType.cstring, // out_path
      ],
      returns: FFIType.i32,
    },
    maple_render_thumbnail_avif_to_file: {
      args: [
        FFIType.cstring, // raw_path
        FFIType.cstring, // out_path
        FFIType.u32, // max_px
        FFIType.u8, // quality
      ],
      returns: FFIType.i32,
    },
    maple_render_thumbnail_preview_jpeg_to_file: {
      args: [
        FFIType.cstring, // raw_path
        FFIType.cstring, // out_path
        FFIType.u32, // max_px
        FFIType.u8, // quality
      ],
      returns: FFIType.i32,
    },
    maple_render_develop_jpeg_to_file: {
      args: [
        FFIType.cstring, // raw_path
        FFIType.cstring, // xmp_path (nullable)
        FFIType.u32, // max_px
        FFIType.u8, // quality
        FFIType.cstring, // out_path
      ],
      returns: FFIType.i32,
    },
    maple_render_filename_template_buf: {
      args: [
        FFIType.cstring, // template
        FFIType.cstring, // original_stem
        FFIType.cstring, // ext
        FFIType.cstring, // captured_at (nullable)
        FFIType.u64, // sequence_start
        FFIType.u64, // sequence_index
        FFIType.u64, // sequence_pad_width
        FFIType.ptr, // out_buf
        FFIType.u64, // out_cap
        FFIType.ptr, // out_len
      ],
      returns: FFIType.i32,
    },
    maple_validate_filename: {
      args: [FFIType.cstring],
      returns: FFIType.i32,
    },
    maple_raster_resize_to_file: {
      args: [
        FFIType.cstring, // input_path
        FFIType.cstring, // out_path
        FFIType.u32, // width
        FFIType.u32, // height
        FFIType.u32, // fit
        FFIType.cstring, // format (nullable)
        FFIType.u8, // quality
      ],
      returns: FFIType.i32,
    },
    maple_raster_probe_metadata: {
      args: [
        FFIType.cstring, // input_path
        FFIType.ptr, // out_width (u32*)
        FFIType.ptr, // out_height (u32*)
        FFIType.ptr, // out_channels (u32*)
        FFIType.ptr, // out_orientation (u32*)
      ],
      returns: FFIType.i32,
    },
    maple_raster_resize_to_buf: {
      args: [
        FFIType.ptr, // input_bytes
        FFIType.u64, // input_len
        FFIType.u32, // width
        FFIType.u32, // height
        FFIType.u32, // fit
        FFIType.cstring, // format (nullable)
        FFIType.u8, // quality
        FFIType.ptr, // out_buf
        FFIType.u64, // out_cap
        FFIType.ptr, // out_len (u64*)
      ],
      returns: FFIType.i32,
    },
    maple_raster_probe_metadata_buf: {
      args: [
        FFIType.ptr, // input_bytes
        FFIType.u64, // input_len
        FFIType.ptr, // out_width (u32*)
        FFIType.ptr, // out_height (u32*)
        FFIType.ptr, // out_channels (u32*)
        FFIType.ptr, // out_orientation (u32*)
        FFIType.ptr, // out_format (char*)
        FFIType.u64, // out_format_cap
      ],
      returns: FFIType.i32,
    },
    maple_raster_extract_tensor_buf: {
      args: [
        FFIType.ptr, // input_bytes
        FFIType.u64, // input_len
        FFIType.u32, // target_size
        FFIType.u32, // layout
        FFIType.u32, // normalize
        FFIType.ptr, // out_buf (f32*)
        FFIType.u64, // out_cap
        FFIType.ptr, // out_len (u64*)
      ],
      returns: FFIType.i32,
    },
    maple_last_error: {
      args: [],
      returns: FFIType.cstring,
    },
  };
}
