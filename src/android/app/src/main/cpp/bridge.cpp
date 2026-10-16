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
bool maple_android_cache_valid(const char *, uint32_t, const char *);
int maple_android_cache_png(const char *, const char *);
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
extern "C" JNIEXPORT jboolean JNICALL Java_app_justmaple_aperture_data_NativeBridge_cacheValid(JNIEnv *env, jobject, jstring path, jint edge, jstring format) {
    Utf8 p(env, path), f(env, format);
    if (env->ExceptionCheck()) return JNI_FALSE;
    return maple_android_cache_valid(p.get(), edge, f.get()) ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_cachePng(JNIEnv *env, jobject, jstring path, jstring destination) {
    Utf8 p(env, path), d(env, destination);
    if (env->ExceptionCheck()) return;
    check(env, maple_android_cache_png(p.get(), d.get()));
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
