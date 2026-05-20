#include "database_binding.h"
#include <jni.h>

// Invoked by the Android runtime when System.loadLibrary("nscsqlite") is called
// from JavaScript.  At that point V8 is already running on the current thread,
// so v8::Isolate::GetCurrent() returns the live isolate and we can initialize
// our bindings directly — no __non_webpack_require__ file-path needed.
// This also works correctly when android:extractNativeLibs="false" because
// System.loadLibrary() loads from the APK directly and never needs an
// extracted file path.
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    if (isolate != nullptr) {
        v8::Locker locker(isolate);
        v8::Isolate::Scope isolate_scope(isolate);
        v8::HandleScope handle_scope(isolate);
        NSCSQLite::DatabaseBinding::Init(isolate);
    }
    return JNI_VERSION_1_6;
}

extern "C" void NSMain(const v8::FunctionCallbackInfo<v8::Value>& args) {
    auto isolate = args.GetIsolate();
    v8::Locker locker(isolate);
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handle_scope(isolate);

    if (args.Length() != 5) {
        auto errMsg = v8::String::NewFromUtf8(isolate, "Wrong number of arguments (expected 5)");
        if (!errMsg.IsEmpty()) {
            auto err = v8::Exception::Error(errMsg.ToLocalChecked());
            isolate->ThrowException(err);
        }
        return;
    }

    NSCSQLite::DatabaseBinding::Init(isolate);
}
