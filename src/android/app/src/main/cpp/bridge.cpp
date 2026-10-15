#include <jni.h>
#include <android/native_window_jni.h>
#include <android/data_space.h>
#include <memory>
#include <string>
#include <cstdint>

extern "C" {
const char *maple_android_error();
void *maple_android_open(const char *, const char *, uint32_t);
void maple_android_close(void *);
char *maple_android_values(void *);
void maple_android_free_string(char *);
int maple_android_set(void *, size_t, float);
int maple_android_model(void *, const char *);
int maple_android_surface(void *, void *, uint32_t, uint32_t);
int maple_android_render(void *);
int maple_android_thumbnail(const char *, const char *, const char *, uint32_t);
int maple_android_export(const char *, const char *, const char *);
}

namespace {
class Utf8 {
    std::string value;
    bool valid = false;
public:
    // JNI's GetStringUTFChars uses modified UTF-8, which Rust correctly rejects
    // for supplementary characters. Convert Java UTF-16 to standard UTF-8.
    Utf8(JNIEnv *env, jstring input) {
        if (!input) return;
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

extern "C" JNIEXPORT jlong JNICALL Java_app_justmaple_aperture_data_NativeBridge_open(JNIEnv *env, jobject, jstring path, jstring xml, jint edge) {
    Utf8 p(env, path), x(env, xml);
    void *core = maple_android_open(p.get(), x.get(), edge);
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
    Utf8 x(env, xml); check(env, maple_android_model(editor(handle)->core, x.get()));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_attach(JNIEnv *env, jobject, jlong handle, jobject surface, jint width, jint height) {
    Editor *e = editor(handle);
    check(env, maple_android_surface(e->core, nullptr, 0, 0));
    if (e->window) { ANativeWindow_release(e->window); e->window = nullptr; }
    if (!surface || env->ExceptionCheck()) return;
    e->window = ANativeWindow_fromSurface(env, surface);
    if (!e->window) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Android surface is unavailable"); return; }
    // raw-core's target_primaries=0 emits display-encoded sRGB bytes.
    ANativeWindow_setBuffersDataSpace(e->window, ADATASPACE_SRGB);
    check(env, maple_android_surface(e->core, e->window, width, height));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_render(JNIEnv *env, jobject, jlong handle) { check(env, maple_android_render(editor(handle)->core)); }
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_thumbnail(JNIEnv *env, jobject, jstring path, jstring destination, jstring xml, jint edge) {
    Utf8 p(env, path), d(env, destination), x(env, xml); check(env, maple_android_thumbnail(p.get(), d.get(), x.get(), edge));
}
extern "C" JNIEXPORT void JNICALL Java_app_justmaple_aperture_data_NativeBridge_export(JNIEnv *env, jobject, jstring path, jstring xml, jstring destination) {
    Utf8 p(env, path), x(env, xml), d(env, destination); check(env, maple_android_export(p.get(), x.get(), d.get()));
}
