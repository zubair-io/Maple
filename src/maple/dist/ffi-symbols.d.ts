/**
 * FFI symbol descriptors for libraw_ffi
 */
export declare function getFfiSymbols(FFIType: Record<string, string | number>): {
    maple_export_developed_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_export_recipe_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_render_thumbnail_avif_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_render_thumbnail_preview_jpeg_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_render_develop_jpeg_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_render_filename_template_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_validate_filename: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_resize_to_file: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_probe_metadata: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_resize_to_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_probe_metadata_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_extract_tensor_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_render_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_from_raw_render_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_raster_decode_rgb8_buf: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_last_error: {
        args: never[];
        returns: string | number;
    };
};
