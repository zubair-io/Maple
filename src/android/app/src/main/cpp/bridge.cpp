#include <jni.h>
#include <android/native_window_jni.h>
#include <android/bitmap.h>
#include <android/data_space.h>
#include <memory>
#include <string>
#include <cstdint>

extern "C" {
const char *maple_android_error();
void *maple_android_create_renderer();
void maple_android_close_renderer(void *);
void *maple_android_open(void *, const char *, const char *, uint32_t);
void maple_android_close(void *);
char *maple_android_values(void *);
struct DetailPatch { uint32_t width, height, target; const uint8_t *pixels; };
void *maple_android_detail_open(const char *);
void *maple_android_detail_from_session(const void *);
void maple_android_detail_free(void *);
DetailPatch *maple_android_detail_render(const void *, const char *, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, const void *);
void maple_android_detail_patch_free(DetailPatch *);
uint8_t maple_android_platform_detail_fits(uint32_t, uint32_t, uint64_t);
uint64_t maple_android_native_dimensions(const char *, const char *);
uint64_t maple_android_presentation_dimensions(uint32_t, uint32_t, float, float, float, float, float);
char *maple_android_parametric_curve(const char *);
char *maple_android_scope(const uint32_t *, size_t, uint32_t, uint32_t);
void *maple_android_auto_wb_new(void *, const char *);
char *maple_android_auto_wb_run(const void *);
void maple_android_auto_wb_free(void *);
void maple_android_free_string(char *);
int maple_android_set(void *, size_t, float);
int maple_android_model(void *, const char *);
bool maple_android_raster_compatible(const char *);
int maple_android_surface(void *, void *, uint32_t, uint32_t, bool);
uint32_t maple_android_output_primaries(void *);
int maple_android_render(void *, const void *);
int maple_android_preparation_new(void *, void **);
int maple_android_preparation_run(void *, const void *);
int maple_android_preparation_apply(void *, void *, const void *);
void maple_android_preparation_free(void *);
void *maple_android_cancel_new();
void maple_android_cancel_set(const void *, bool);
void maple_android_cancel_free(void *);
int maple_android_thumbnail(const char *, const char *, const char *, uint32_t);
int maple_android_shared_derivative(const char *, const char *, const char *, bool);
bool maple_android_cache_valid(int, uint32_t, const char *);
int maple_android_cache_png(int, const char *);
int maple_android_export_configured(const char *, const char *, const char *, const char *, uint32_t, uint32_t, bool);
int maple_android_export(const char *, const char *, const char *);
int maple_android_stage_bitmap(const uint8_t *, uint32_t, uint32_t, size_t, uint32_t, const float *, const char *);
}

namespace {
class Utf8 {
    std::string value;
    bool valid = false;
public:
    // JNI's GetStringUTFChars uses modified UTF-8, which Rust correctly rejects
    // for supplementary characters. Convert Java UTF-16 to standard UTF-8.
    Utf8(JNIEnv *env, jstring input) {
        if (!input || env->ExceptionCheck()) return;
        const jchar *chars = env->GetStringChars(input, nullptr);
        if (!chars) return;
        const jsize length = env->GetStringLength(input);
        for (jsize i = 0; i < length; ++i) {
            uint32_t point = chars[i];
            if (point >= 0xd800 && point <= 0xdbff && i + 1 < length && chars[i + 1] >= 0xdc00 && chars[i + 1] <= 0xdfff) {
                point = 0x10000 + ((point - 0xd800) << 10) + (chars[++i] - 0xdc00);
            } else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
            if (point < 0x80) value.push_back(static_cast<char>(point));
            else if (point < 0x800) {
                value.push_back(static_cast<char>(0xc0 | (point >> 6)));
                value.push_back(static_cast<char>(0x80 | (point & 0x3f)));
            } else if (point < 0x10000) {
                value.push_back(static_cast<char>(0xe0 | (point >> 12)));
                value.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3f)));
                value.push_back(static_cast<char>(0x80 | (point & 0x3f)));
            } else {
                value.push_back(static_cast<char>(0xf0 | (point >> 18)));
                value.push_back(static_cast<char>(0x80 | ((point >> 12) & 0x3f)));
                value.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3f)));
                value.push_back(static_cast<char>(0x80 | (point & 0x3f)));
            }
        }
        env->ReleaseStringChars(input, chars);
        valid = true;
    }
    const char *get() const { return valid ? value.c_str() : nullptr; }
};
struct Editor {
    void *core;
    ANativeWindow *window = nullptr;
    explicit Editor(void *p) : core(p) {}
    ~Editor() {
        maple_android_close(core);
        if (window) ANativeWindow_release(window);
    }
};
void check(JNIEnv *env, int result) {
    if (result != 0 && !env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), maple_android_error());
}
Editor *editor(jlong handle) { return reinterpret_cast<Editor *>(handle); }
}

extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_createRenderer(JNIEnv *env, jobject) {
    void *context = maple_android_create_renderer();
    if (!context) check(env, -1);
    return reinterpret_cast<jlong>(context);
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_closeRenderer(JNIEnv *, jobject, jlong context) {
    maple_android_close_renderer(reinterpret_cast<void *>(context));
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_open(JNIEnv *env, jobject, jstring path, jstring xml, jint edge, jlong context) {
    Utf8 p(env, path), x(env, xml);
    if (env->ExceptionCheck()) return 0;
    void *core = maple_android_open(reinterpret_cast<void *>(context), p.get(), x.get(), edge);
    if (!core) { check(env, -1); return 0; }
    return reinterpret_cast<jlong>(new Editor(core));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_close(JNIEnv *, jobject, jlong handle) { delete editor(handle); }
extern "C" JNIEXPORT jstring JNICALL Java_app_justmaple_aperture_data_NativeBridge_values(JNIEnv *env, jobject, jlong handle) {
    char *value = maple_android_values(editor(handle)->core);
    if (!value) { check(env, -1); return nullptr; }
    jstring result = env->NewStringUTF(value);
    maple_android_free_string(value);
    return result;
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_openNativeDetail(JNIEnv *env, jobject, jstring path) {
    Utf8 p(env, path);
    if (env->ExceptionCheck()) return 0;
    void *source = maple_android_detail_open(p.get());
    if (!source) { check(env, -1); return 0; }
    return reinterpret_cast<jlong>(source);
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_copyNativeDetail(JNIEnv *env, jobject, jlong handle) {
    void *source = maple_android_detail_from_session(editor(handle)->core);
    if (!source) { check(env, -1); return 0; }
    return reinterpret_cast<jlong>(source);
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_closeNativeDetail(JNIEnv *, jobject, jlong source) {
    maple_android_detail_free(reinterpret_cast<void *>(source));
}
extern "C" JNIEXPORT jint JNICALL Java_app_justmaple_aperture_data_NativeBridge_outputPrimaries(JNIEnv *, jobject, jlong handle) {
    return maple_android_output_primaries(editor(handle)->core);
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_platformNativeDetailFits(JNIEnv *, jobject, jint width, jint height, jlong sourceBytes) {
    return width > 0 && height > 0 && sourceBytes >= 0 && maple_android_platform_detail_fits(width, height, sourceBytes) != 0;
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_nativeDimensions(JNIEnv *env, jobject, jstring path, jstring extension) {
    Utf8 p(env, path), e(env, extension);
    if (env->ExceptionCheck()) return 0;
    uint64_t dimensions = maple_android_native_dimensions(p.get(), e.get());
    if (!dimensions) check(env, -1);
    return static_cast<jlong>(dimensions);
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_presentationDimensions(JNIEnv *, jobject, jint width, jint height, jfloat top, jfloat left, jfloat bottom, jfloat right, jfloat angle) {
    if (width <= 0 || height <= 0) return 0;
    return static_cast<jlong>(maple_android_presentation_dimensions(width, height, top, left, bottom, right, angle));
}
extern "C" JNIEXPORT jobject JNICALL Java_app_justmaple_aperture_data_NativeBridge_renderNativeDetail(JNIEnv *env, jobject, jlong source, jstring xml, jint x, jint y, jint width, jint height, jint target, jlong flag) {
    Utf8 document(env, xml);
    if (env->ExceptionCheck()) return nullptr;
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
        env->ThrowNew(env->FindClass("java/lang/IllegalArgumentException"), "Invalid native-detail region");
        return nullptr;
    }
    std::unique_ptr<DetailPatch, decltype(&maple_android_detail_patch_free)> patch(
        maple_android_detail_render(reinterpret_cast<void *>(source), document.get(), x, y, width, height, target, reinterpret_cast<void *>(flag)),
        maple_android_detail_patch_free);
    if (!patch) { check(env, -1); return nullptr; }
    jclass configClass = env->FindClass("android/graphics/Bitmap$Config");
    jclass colorClass = env->FindClass("android/graphics/ColorSpace");
    jclass namedClass = env->FindClass("android/graphics/ColorSpace$Named");
    jclass bitmapClass = env->FindClass("android/graphics/Bitmap");
    if (env->ExceptionCheck()) return nullptr;
    jobject config = env->GetStaticObjectField(configClass, env->GetStaticFieldID(configClass, "ARGB_8888", "Landroid/graphics/Bitmap$Config;"));
    jobject named = env->GetStaticObjectField(namedClass, env->GetStaticFieldID(namedClass, patch->target == 1 ? "DISPLAY_P3" : "SRGB", "Landroid/graphics/ColorSpace$Named;"));
    jobject color = env->CallStaticObjectMethod(colorClass, env->GetStaticMethodID(colorClass, "get", "(Landroid/graphics/ColorSpace$Named;)Landroid/graphics/ColorSpace;"), named);
    if (env->ExceptionCheck()) return nullptr;
    jobject bitmap = env->CallStaticObjectMethod(bitmapClass,
        env->GetStaticMethodID(bitmapClass, "createBitmap", "(IILandroid/graphics/Bitmap$Config;ZLandroid/graphics/ColorSpace;)Landroid/graphics/Bitmap;"),
        static_cast<jint>(patch->width), static_cast<jint>(patch->height), config, false, color);
    if (!bitmap || env->ExceptionCheck()) return nullptr;
    AndroidBitmapInfo info{};
    void *storage = nullptr;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
        AndroidBitmap_lockPixels(env, bitmap, &storage) != ANDROID_BITMAP_RESULT_SUCCESS) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Native-detail bitmap storage is unavailable");
        return nullptr;
    }
    // Write encoded samples directly. Bitmap.setPixels would reinterpret P3
    // samples as sRGB integers and convert them a second time.
    for (uint32_t row = 0; row < patch->height; ++row) {
        auto *out = static_cast<uint8_t *>(storage) + row * info.stride;
        const auto *in = patch->pixels + row * patch->width * 3;
        for (uint32_t column = 0; column < patch->width; ++column) {
            out[column * 4] = in[column * 3];
            out[column * 4 + 1] = in[column * 3 + 1];
            out[column * 4 + 2] = in[column * 3 + 2];
            out[column * 4 + 3] = 255;
        }
    }
    AndroidBitmap_unlockPixels(env, bitmap);
    return bitmap;
}
extern "C" JNIEXPORT jstring JNICALL Java_app_justmaple_aperture_data_NativeBridge_scopePixels(JNIEnv *env, jobject, jintArray pixels, jint width, jint height) {
    if (!pixels || width < 0 || height < 0 || env->ExceptionCheck()) return nullptr;
    const jsize count = env->GetArrayLength(pixels);
    jint *data = env->GetIntArrayElements(pixels, nullptr);
    if (!data) return nullptr;
    char *value = maple_android_scope(reinterpret_cast<const uint32_t *>(data), count, width, height);
    env->ReleaseIntArrayElements(pixels, data, JNI_ABORT);
    if (!value) { check(env, -1); return nullptr; }
    jstring result = env->NewStringUTF(value);
    maple_android_free_string(value);
    return result;
}
extern "C" JNIEXPORT jstring JNICALL Java_app_justmaple_aperture_data_NativeBridge_parametricCurve(JNIEnv *env, jobject, jstring xml) {
    Utf8 x(env, xml);
    if (env->ExceptionCheck()) return nullptr;
    char *value = maple_android_parametric_curve(x.get());
    if (!value) { check(env, -1); return nullptr; }
    jstring result = env->NewStringUTF(value);
    maple_android_free_string(value);
    return result;
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_createAutoWhiteBalance(JNIEnv *env, jobject, jlong handle, jstring xml) {
    Utf8 x(env, xml);
    if (env->ExceptionCheck()) return 0;
    void *work = maple_android_auto_wb_new(editor(handle)->core, x.get());
    if (!work) { check(env, -1); return 0; }
    return reinterpret_cast<jlong>(work);
}
extern "C" JNIEXPORT jstring JNICALL Java_app_justmaple_aperture_data_NativeBridge_runAutoWhiteBalance(JNIEnv *env, jobject, jlong work) {
    char *value = maple_android_auto_wb_run(reinterpret_cast<void *>(work));
    if (!value) { check(env, -1); return nullptr; }
    jstring result = env->NewStringUTF(value);
    maple_android_free_string(value);
    return result;
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_closeAutoWhiteBalance(JNIEnv *, jobject, jlong work) {
    maple_android_auto_wb_free(reinterpret_cast<void *>(work));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_setField(JNIEnv *env, jobject, jlong handle, jint index, jfloat value) { check(env, maple_android_set(editor(handle)->core, index, value)); }
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_setModel(JNIEnv *env, jobject, jlong handle, jstring xml) {
    Utf8 x(env, xml);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_model(editor(handle)->core, x.get()));
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_rasterCompatible(JNIEnv *env, jobject, jstring xml) {
    Utf8 x(env, xml);
    if (env->ExceptionCheck()) return JNI_FALSE;
    return maple_android_raster_compatible(x.get()) ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_attach(JNIEnv *env, jobject, jlong handle, jobject surface, jint width, jint height, jboolean wideColor) {
    Editor *e = editor(handle);
    check(env, maple_android_surface(e->core, nullptr, 0, 0, false));
    if (e->window) { ANativeWindow_release(e->window); e->window = nullptr; }
    if (!surface || env->ExceptionCheck()) return;
    e->window = ANativeWindow_fromSurface(env, surface);
    if (!e->window) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Android surface is unavailable"); return; }
    check(env, maple_android_surface(e->core, e->window, width, height, wideColor == JNI_TRUE));
    if (env->ExceptionCheck()) return;
    const int32_t space = maple_android_output_primaries(e->core) == 1 ? ADATASPACE_SCRGB_LINEAR : ADATASPACE_SRGB;
    if (ANativeWindow_setBuffersDataSpace(e->window, space) != 0)
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Android rejected the canvas color space");
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_createCancellation(JNIEnv *, jobject) { return reinterpret_cast<jlong>(maple_android_cancel_new()); }
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_setCancellation(JNIEnv *, jobject, jlong flag, jboolean value) { maple_android_cancel_set(reinterpret_cast<void *>(flag), value == JNI_TRUE); }
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_closeCancellation(JNIEnv *, jobject, jlong flag) { maple_android_cancel_free(reinterpret_cast<void *>(flag)); }
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_render(JNIEnv *env, jobject, jlong handle, jlong flag) {
    const int result = maple_android_render(editor(handle)->core, reinterpret_cast<void *>(flag));
    if (result < 0) check(env, result);
    return result == 0 ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_createPreparation(JNIEnv *env, jobject, jlong handle) {
    void *work = nullptr;
    check(env, maple_android_preparation_new(editor(handle)->core, &work));
    return reinterpret_cast<jlong>(work);
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_runPreparation(JNIEnv *env, jobject, jlong work, jlong flag) {
    const int result = maple_android_preparation_run(reinterpret_cast<void *>(work), reinterpret_cast<void *>(flag));
    if (result < 0) check(env, result);
    return result == 0 ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_applyPreparation(JNIEnv *env, jobject, jlong handle, jlong work, jlong flag) {
    const int result = maple_android_preparation_apply(editor(handle)->core, reinterpret_cast<void *>(work), reinterpret_cast<void *>(flag));
    if (result < 0) check(env, result);
    return result == 0 ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_closePreparation(JNIEnv *, jobject, jlong work) { maple_android_preparation_free(reinterpret_cast<void *>(work)); }
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_thumbnail(JNIEnv *env, jobject, jstring path, jstring destination, jstring xml, jint edge) {
    Utf8 p(env, path), d(env, destination), x(env, xml);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_thumbnail(p.get(), d.get(), x.get(), edge));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_exportConfigured(JNIEnv *env, jobject, jstring path, jstring xml, jstring destination, jstring format, jint quality, jint edge, jboolean p3) {
    Utf8 p(env, path), x(env, xml), d(env, destination), f(env, format);
    if (env->ExceptionCheck()) return;
    if (quality < 1 || quality > 100 || edge < 0) {
        env->ThrowNew(env->FindClass("java/lang/IllegalArgumentException"), "Invalid export quality or size");
        return;
    }
    check(env, maple_android_export_configured(p.get(), x.get(), d.get(), f.get(), quality, edge, p3));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_export(JNIEnv *env, jobject, jstring path, jstring xml, jstring destination) {
    Utf8 p(env, path), x(env, xml), d(env, destination);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_export(p.get(), x.get(), d.get()));
}

extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_sharedDerivative(JNIEnv *env, jobject, jstring path, jstring destination, jstring xml, jboolean preview) {
    Utf8 p(env, path), d(env, destination), x(env, xml);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_shared_derivative(p.get(), d.get(), x.get(), preview));
}
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_cacheValid(JNIEnv *env, jobject, jint fd, jint edge, jstring format) {
    Utf8 f(env, format);
    if (env->ExceptionCheck()) return JNI_FALSE;
    return maple_android_cache_valid(fd, edge, f.get()) ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_cachePng(JNIEnv *env, jobject, jint fd, jstring destination) {
    Utf8 d(env, destination);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_cache_png(fd, d.get()));
}

extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_stageBitmap(JNIEnv *env, jobject, jobject bitmap, jstring destination, jfloatArray profile) {
    Utf8 path(env, destination);
    if (env->ExceptionCheck()) return;
    if (!profile || env->GetArrayLength(profile) != 16) {
        env->ThrowNew(env->FindClass("java/lang/IllegalArgumentException"), "Missing RGB color profile");
        return;
    }
    float color[16];
    env->GetFloatArrayRegion(profile, 0, 16, color);
    if (env->ExceptionCheck()) return;
    AndroidBitmapInfo info{};
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) {
        if (!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Cannot inspect the decoded bitmap");
        return;
    }
    void *pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        if (!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Cannot read the decoded bitmap");
        return;
    }
    const int result = maple_android_stage_bitmap(static_cast<const uint8_t *>(pixels), info.width, info.height, info.stride, info.format, color, path.get());
    AndroidBitmap_unlockPixels(env, bitmap);
    check(env, result);
}
