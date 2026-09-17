#pragma once
#include <android/log.h>
#include <string>

namespace NSCSQLite {

static constexpr const char* LOG_TAG = "NSCSQLite";

inline void LogInfo(const std::string& msg) {
    __android_log_write(ANDROID_LOG_INFO, LOG_TAG, msg.c_str());
}

inline void LogWarn(const std::string& msg) {
    __android_log_write(ANDROID_LOG_WARN, LOG_TAG, msg.c_str());
}

inline void LogError(const std::string& msg) {
    __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, msg.c_str());
}

} // namespace NSCSQLite
