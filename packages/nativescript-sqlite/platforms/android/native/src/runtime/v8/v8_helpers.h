#pragma once

// ---------------------------------------------------------------------------
// V8Helpers — Runtime thread only V8 utility functions.
// Mirrors the helpers from sqlite-metal but scoped to the sqlite package.
// ---------------------------------------------------------------------------

#include "v8.h"
#include <android/log.h>
#include <string>
#include <vector>
#include <cstring>

namespace NSCSQLite {
namespace V8Helpers {

static constexpr const char* LOG_TAG = "NSCSQLite";

// ── String conversion ────────────────────────────────────────────────────────

inline v8::Local<v8::String> ToV8String(v8::Isolate* isolate, const std::string& str) {
    return v8::String::NewFromUtf8(isolate, str.c_str(),
                                   v8::NewStringType::kNormal,
                                   static_cast<int>(str.size()))
        .ToLocalChecked();
}

inline v8::Local<v8::String> ToV8String(v8::Isolate* isolate, const char* str) {
    return v8::String::NewFromUtf8(isolate, str ? str : "",
                                   v8::NewStringType::kNormal)
        .ToLocalChecked();
}

inline std::string FromV8String(v8::Isolate* isolate,
                                 const v8::Local<v8::Value>& value) {
    if (value.IsEmpty() || !value->IsString()) return {};
    v8::String::Utf8Value utf8(isolate, value);
    return *utf8 ? *utf8 : "";
}

// ── ArrayBuffer ──────────────────────────────────────────────────────────────

inline v8::Local<v8::ArrayBuffer> ToV8ArrayBuffer(v8::Isolate* isolate,
                                                   const uint8_t* data,
                                                   size_t size) {
    auto buf = v8::ArrayBuffer::New(isolate, size);
    auto backing = buf->GetBackingStore();
    if (data && size) memcpy(backing->Data(), data, size);
    return buf;
}

inline std::vector<uint8_t> FromV8ArrayBuffer(v8::Isolate* /*isolate*/,
                                               v8::Local<v8::ArrayBuffer> buf) {
    auto backing = buf->GetBackingStore();
    const uint8_t* data = static_cast<const uint8_t*>(backing->Data());
    return std::vector<uint8_t>(data, data + buf->ByteLength());
}

// ── Logging ──────────────────────────────────────────────────────────────────

inline void LogToConsole(const std::string& msg) {
    __android_log_write(ANDROID_LOG_INFO, LOG_TAG, msg.c_str());
}

inline void LogError(const std::string& msg) {
    __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, msg.c_str());
}

// ── Property helpers ─────────────────────────────────────────────────────────

inline void SetProp(v8::Isolate* isolate,
                    v8::Local<v8::Context>& ctx,
                    v8::Local<v8::Object>& obj,
                    const char* key,
                    v8::Local<v8::Value> val) {
    obj->Set(ctx, ToV8String(isolate, key), val).Check();
}

// ── Promise helpers ──────────────────────────────────────────────────────────

inline v8::Local<v8::Promise::Resolver> NewResolver(v8::Isolate* isolate) {
    auto ctx = isolate->GetEnteredOrMicrotaskContext();
    return v8::Promise::Resolver::New(ctx).ToLocalChecked();
}

} // namespace V8Helpers
} // namespace NSCSQLite

