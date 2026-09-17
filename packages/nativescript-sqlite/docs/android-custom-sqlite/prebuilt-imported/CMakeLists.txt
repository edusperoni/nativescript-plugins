# App-provided SQLite for @edusperoni/nativescript-sqlite (Android):
# a prebuilt .so that something else — a Gradle AAR dependency, or files the app
# packages itself — already puts in the APK.
#
# Nothing is compiled here. The plugin ends up with a DT_NEEDED entry for the
# prebuilt library's SONAME, and the dynamic linker resolves it at load time
# from lib/<abi>/ inside the APK.
#
# Layout this file expects:
#   App_Resources/Android/nscsqlite/
#     CMakeLists.txt                       <- this file
#     include/sqlite3.h                    <- headers matching the .so
#     prebuilt/arm64-v8a/libsqlcipher.so
#     prebuilt/armeabi-v7a/libsqlcipher.so
#     prebuilt/x86_64/libsqlcipher.so
#     prebuilt/x86/libsqlcipher.so

cmake_minimum_required(VERSION 3.15.0)

set(NSCSQLITE_PREBUILT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/prebuilt"
    CACHE PATH "Directory holding one <abi>/ subdirectory per ABI")

set(_lib "${NSCSQLITE_PREBUILT_DIR}/${ANDROID_ABI}/libsqlcipher.so")

# Caught here rather than as a linker error two minutes later, and it names the
# ABI that is missing.
if(NOT EXISTS "${_lib}")
    message(FATAL_ERROR "No prebuilt SQLite for ${ANDROID_ABI} at ${_lib}")
endif()

# GLOBAL: the target is created in this subdirectory but consumed by the
# plugin's, and an IMPORTED target is directory-scoped without it.
add_library(nscsqlite_sqlite SHARED IMPORTED GLOBAL)

set_target_properties(nscsqlite_sqlite PROPERTIES
    IMPORTED_LOCATION "${_lib}"
    INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/include")

# An IMPORTED target has no sources, so anything the header needs in order to
# declare the right API has to be stated here. SQLCipher's sqlite3.h hides
# sqlite3_key() behind SQLITE_HAS_CODEC.
set_property(TARGET nscsqlite_sqlite APPEND PROPERTY
    INTERFACE_COMPILE_DEFINITIONS SQLITE_HAS_CODEC)
