#pragma once

// ---------------------------------------------------------------------------
// NapiHelpers — Runtime thread only Node-API utility functions.
//
// RULE: every function here must be called on the thread that owns the env.
// ---------------------------------------------------------------------------

#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace NSCSQLite {
namespace NapiHelpers {

// Strings up to this size are read with a single napi call; the length query
// is only paid for the ones that do not fit.
static constexpr size_t kInlineStringBytes = 256;

inline napi_value String(napi_env env, const char* str, size_t len) {
    napi_value value = nullptr;
    if (napi_create_string_utf8(env, str, len, &value) != napi_ok) return nullptr;
    return value;
}

inline napi_value String(napi_env env, const std::string& str) {
    return String(env, str.data(), str.size());
}

inline bool ToStdString(napi_env env, napi_value value, std::string& out) {
    char inlineBuf[kInlineStringBytes];
    size_t written = 0;
    if (napi_get_value_string_utf8(env, value, inlineBuf, sizeof(inlineBuf), &written) != napi_ok) {
        return false;
    }
    if (written < sizeof(inlineBuf) - 1) {
        out.assign(inlineBuf, written);
        return true;
    }

    size_t needed = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &needed) != napi_ok) return false;
    out.resize(needed + 1);
    if (napi_get_value_string_utf8(env, value, &out[0], needed + 1, &written) != napi_ok) {
        out.clear();
        return false;
    }
    out.resize(written);
    return true;
}

inline napi_value ArrayBufferFrom(napi_env env, const uint8_t* data, size_t size) {
    void* dst = nullptr;
    napi_value buffer = nullptr;
    if (napi_create_arraybuffer(env, size, &dst, &buffer) != napi_ok) return nullptr;
    if (data && size) memcpy(dst, data, size);
    return buffer;
}

inline bool TypedArrayByteLength(napi_env env, napi_value value, napi_typedarray_type type,
                                 size_t length, size_t* out) {
    switch (type) {
        case napi_int8_array:
        case napi_uint8_array:
        case napi_uint8_clamped_array:
            *out = length;
            return true;
        case napi_int16_array:
        case napi_uint16_array:
            *out = length * 2;
            return true;
        case napi_int32_array:
        case napi_uint32_array:
        case napi_float32_array:
            *out = length * 4;
            return true;
        case napi_float64_array:
        case napi_bigint64_array:
        case napi_biguint64_array:
            *out = length * 8;
            return true;
        default: {
            // Element types newer than the headers this is built against.
            napi_value prop = nullptr;
            double bytes = 0;
            if (napi_get_named_property(env, value, "byteLength", &prop) != napi_ok ||
                napi_get_value_double(env, prop, &bytes) != napi_ok || bytes < 0)
                return false;
            *out = static_cast<size_t>(bytes);
            return true;
        }
    }
}

// Copies the bytes of an ArrayBuffer, SharedArrayBuffer, TypedArray or DataView;
// a view contributes only its own byteOffset..byteOffset+byteLength range.
// Returns false for any other value.
inline bool BinaryTo(napi_env env, napi_value value, std::vector<uint8_t>& out) {
    void* data = nullptr;
    size_t size = 0;
    bool matches = false;
    if (napi_is_typedarray(env, value, &matches) == napi_ok && matches) {
        napi_typedarray_type type;
        size_t length = 0;
        // data already points at the view's first element.
        if (napi_get_typedarray_info(env, value, &type, &length, &data, nullptr, nullptr) != napi_ok ||
            !TypedArrayByteLength(env, value, type, length, &size))
            return false;
    } else if (napi_is_dataview(env, value, &matches) == napi_ok && matches) {
        // data already points at the view's first byte.
        if (napi_get_dataview_info(env, value, &size, &data, nullptr, nullptr) != napi_ok) return false;
    } else if (napi_get_arraybuffer_info(env, value, &data, &size) != napi_ok) {
        // napi_is_arraybuffer is false for a SharedArrayBuffer, but
        // napi_get_arraybuffer_info accepts both.
        return false;
    }
    if (size == 0 || data == nullptr) {
        out.clear();
        return true;
    }
    const auto* bytes = static_cast<const uint8_t*>(data);
    out.assign(bytes, bytes + size);
    return true;
}

// Node-API has no IsInt32 predicate: a number counts as int32 when it is
// exactly representable as one, which excludes -0 the way V8 does.
inline bool IsInt32Value(double value, int32_t* out) {
    if (!(value >= -2147483648.0 && value <= 2147483647.0)) return false;
    if (value != std::trunc(value)) return false;
    if (value == 0.0 && std::signbit(value)) return false;
    if (out) *out = static_cast<int32_t>(value);
    return true;
}

inline bool IsInt32(napi_env env, napi_value value, int32_t* out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
    double number = 0.0;
    if (napi_get_value_double(env, value, &number) != napi_ok) return false;
    return IsInt32Value(number, out);
}

inline void ClearPendingException(napi_env env) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) != napi_ok || !pending) return;
    napi_value ignored = nullptr;
    napi_get_and_clear_last_exception(env, &ignored);
}

inline napi_value MakeError(napi_env env, const std::string& message) {
    napi_value messageValue = String(env, message);
    if (!messageValue) return nullptr;
    napi_value error = nullptr;
    if (napi_create_error(env, nullptr, messageValue, &error) != napi_ok) return nullptr;
    return error;
}

inline napi_value MakeError(napi_env env, const std::string& message, int code) {
    napi_value error = MakeError(env, message);
    if (!error) return nullptr;
    napi_value codeValue = nullptr;
    if (napi_create_int32(env, code, &codeValue) == napi_ok) {
        napi_set_named_property(env, error, "code", codeValue);
    }
    return error;
}

} // namespace NapiHelpers
} // namespace NSCSQLite
