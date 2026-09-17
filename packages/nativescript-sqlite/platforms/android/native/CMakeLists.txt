cmake_minimum_required(VERSION 3.15.0)
set(CMAKE_VERBOSE_MAKEFILE ON)

project(nscsqlite)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Runtime binding backend: "v8" binds through the raw V8 C++ API, "napi" through
# Node-API.  The two are mutually exclusive and produce the same library name.
if(NOT DEFINED NSCSQLITE_BACKEND OR NSCSQLITE_BACKEND STREQUAL "")
    set(NSCSQLITE_BACKEND "napi")
endif()

if(NOT NSCSQLITE_BACKEND STREQUAL "v8" AND NOT NSCSQLITE_BACKEND STREQUAL "napi")
    message(FATAL_ERROR "Unknown NSCSQLITE_BACKEND: ${NSCSQLITE_BACKEND} (expected v8 or napi)")
endif()

if(NSCSQLITE_BACKEND STREQUAL "v8" AND (NOT DEFINED V8_INCLUDE_DIR OR NOT EXISTS "${V8_INCLUDE_DIR}/v8.h"))
    message(FATAL_ERROR
        "V8_INCLUDE_DIR must point at the public V8 headers (no v8.h under "
        "'${V8_INCLUDE_DIR}'). include.gradle downloads them from the release "
        "pinned in native/downloads.properties; pass -Pnscsqlite.v8IncludeDir=<dir> "
        "to use a local copy instead.")
endif()

# Optimization options
option(ENABLE_LTO "Enable cross language linking time optimization" ON)
if (ENABLE_LTO)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT supported OUTPUT error)
    if (supported)
        message(STATUS "IPO / LTO enabled")
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
        add_link_options(-fuse-ld=lld)
    else ()
        message(STATUS "IPO / LTO not supported: <${error}>")
    endif ()
endif ()

set(COMMON_CMAKE_ARGUMENTS "-std=c++20 -pthread -Werror -v -Wno-unused-result -mstackrealign -fexceptions -fno-builtin-stpcpy")

if(NSCSQLITE_BACKEND STREQUAL "v8")
    # The pointer-compression defines must match the runtime's own V8 build, or
    # every handle read through the public headers decodes garbage.
    set(COMMON_CMAKE_ARGUMENTS "${COMMON_CMAKE_ARGUMENTS} -DV8_31BIT_SMIS_ON_64BIT_ARCH")
    if ("${ANDROID_ABI}" MATCHES "arm64-v8a$" OR "${ANDROID_ABI}" MATCHES "x86_64$")
        set(COMMON_CMAKE_ARGUMENTS "${COMMON_CMAKE_ARGUMENTS} -DV8_COMPRESS_POINTERS")
    endif ()
else()
    # The runtime creates every env at module API version 8.
    set(COMMON_CMAKE_ARGUMENTS "${COMMON_CMAKE_ARGUMENTS} -DNAPI_VERSION=8")
endif()

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${COMMON_CMAKE_ARGUMENTS}")

# SQLite selection.  The two presets under sqlite/ are in-repo instances of the
# contract an app-provided directory satisfies, so all three cases below are the
# same code path: configure a directory, require the target it must define.
if(NOT DEFINED NSCSQLITE_SQLITE OR NSCSQLITE_SQLITE STREQUAL "")
    set(NSCSQLITE_SQLITE "bundled")
endif()

if(NSCSQLITE_SQLITE STREQUAL "project")
    if(NOT DEFINED NSCSQLITE_SQLITE_PROJECT_DIR OR NSCSQLITE_SQLITE_PROJECT_DIR STREQUAL "")
        message(FATAL_ERROR "NSCSQLITE_SQLITE=project requires NSCSQLITE_SQLITE_PROJECT_DIR")
    endif()
    if(NOT EXISTS "${NSCSQLITE_SQLITE_PROJECT_DIR}/CMakeLists.txt")
        message(FATAL_ERROR
            "No CMakeLists.txt under NSCSQLITE_SQLITE_PROJECT_DIR="
            "'${NSCSQLITE_SQLITE_PROJECT_DIR}'")
    endif()
    set(_sqlite_dir "${NSCSQLITE_SQLITE_PROJECT_DIR}")
    set(_sqlite_label "project (${NSCSQLITE_SQLITE_PROJECT_DIR})")
elseif(NSCSQLITE_SQLITE STREQUAL "bundled" OR NSCSQLITE_SQLITE STREQUAL "sqlite3mc")
    set(_sqlite_dir "${CMAKE_CURRENT_SOURCE_DIR}/sqlite/${NSCSQLITE_SQLITE}")
    set(_sqlite_label "${NSCSQLITE_SQLITE}")
elseif(NSCSQLITE_SQLITE STREQUAL "sqlcipher")
    message(FATAL_ERROR
        "NSCSQLITE_SQLITE=sqlcipher has been removed. Use sqlite3mc, which reads and "
        "writes SQLCipher 4 databases and needs no OpenSSL (README: 'Choosing the SQLite "
        "build'), or build SQLCipher itself through NSCSQLITE_SQLITE_PROJECT_DIR (README: "
        "'Bringing your own SQLite').")
elseif(NSCSQLITE_SQLITE STREQUAL "custom")
    message(FATAL_ERROR
        "NSCSQLITE_SQLITE=custom has been removed. Point NSCSQLITE_SQLITE_PROJECT_DIR at a "
        "directory whose CMakeLists.txt defines a target named 'nscsqlite_sqlite'; an "
        "IMPORTED target wraps a prebuilt library in five lines (README: 'Bringing your own "
        "SQLite').")
else()
    message(FATAL_ERROR
        "Unknown NSCSQLITE_SQLITE: ${NSCSQLITE_SQLITE} (expected bundled, sqlite3mc or project)")
endif()

# An out-of-tree source directory has no place of its own under the build tree,
# so add_subdirectory needs the binary directory spelled out.
add_subdirectory("${_sqlite_dir}" "${CMAKE_CURRENT_BINARY_DIR}/sqlite")

if(NOT TARGET nscsqlite_sqlite)
    message(FATAL_ERROR
        "'${_sqlite_dir}/CMakeLists.txt' did not define a target named 'nscsqlite_sqlite'. "
        "It must define one (STATIC, SHARED or IMPORTED) carrying a PUBLIC include "
        "directory that holds sqlite3.h, its compile definitions, and its link "
        "dependencies as PUBLIC.")
endif()

message(STATUS "nscsqlite: backend=${NSCSQLITE_BACKEND} sqlite=${_sqlite_label}")

# Source files — listed per backend rather than globbed so a napi build never
# pulls a V8 translation unit in, and vice versa.
set(SOURCES
    src/sqlite_abi_check.cpp
    src/common/sqlite_connection.cpp
    src/async/thread_pool.cpp
)

if(NSCSQLITE_BACKEND STREQUAL "v8")
    include_directories(${V8_INCLUDE_DIR})
    list(APPEND SOURCES
        src/async/android_dispatcher.cpp
        src/runtime/v8/v8_runtime_adapter.cpp
        src/runtime/v8/v8_internals_shim.cpp
        src/bindings/bridge.cpp
        src/bindings/database_binding.cpp
    )
else()
    list(APPEND SOURCES
        src/async/napi_dispatcher.cpp
        src/runtime/napi/napi_runtime_adapter.cpp
        src/bindings/napi/database_binding_napi.cpp
    )
endif()

# Main library target
add_library(
    nscsqlite
    SHARED
    ${SOURCES}
)

# Node-API headers ship as a header-only Prefab package in the runtime AAR.
# NAPI_INCLUDE_DIR short-circuits it for standalone builds outside an app.
if(NSCSQLITE_BACKEND STREQUAL "napi")
    if(DEFINED NAPI_INCLUDE_DIR AND EXISTS "${NAPI_INCLUDE_DIR}/node_api.h")
        target_include_directories(nscsqlite PRIVATE ${NAPI_INCLUDE_DIR})
    else()
        find_package(NativeScript REQUIRED CONFIG)
        target_link_libraries(nscsqlite NativeScript::NativeScript)
    endif()
endif()

set_target_properties(
    nscsqlite PROPERTIES
    CXX_STANDARD 20
    CXX_EXTENSIONS OFF
    POSITION_INDEPENDENT_CODE ON
)

# --exclude-libs keeps the engine's symbols out of the dynamic table, so an app
# that also links another SQLite cannot bind to this one, or this one to it.
# NDK 27 still links with max-page-size=4096, which Play rejects for API 35+.
target_link_options(nscsqlite PRIVATE
    "-Wl,--exclude-libs,ALL"
    "-Wl,-z,max-page-size=16384"
)

find_library(system-log log)

# NativeScript runtime stub — provides V8 symbols at link time so the dynamic
# linker records a DT_NEEDED entry for libNativeScript.so.  At run time the
# real libNativeScript.so is already loaded by the NS runtime and its symbols
# are resolved from there.
#
# NS_LIBS_DIR is passed by include.gradle when it can extract stubs from the
# @nativescript/android AAR (i.e. when building inside an app).  Fall back to
# the bundled libs/ directory otherwise.
if(DEFINED NS_LIBS_DIR)
    set(_ns_stub_dir "${NS_LIBS_DIR}/${ANDROID_ABI}")
else()
    set(_ns_stub_dir "${PROJECT_SOURCE_DIR}/libs/${ANDROID_ABI}")
endif()

add_library(NativeScript SHARED IMPORTED)
set_target_properties(NativeScript PROPERTIES
    IMPORTED_LOCATION ${_ns_stub_dir}/libNativeScript.so
)

# Post-build strip
add_custom_command(TARGET nscsqlite POST_BUILD COMMAND ${CMAKE_STRIP} --strip-unneeded $<TARGET_FILE:nscsqlite>)

target_link_libraries(nscsqlite
    ${system-log}
    NativeScript
    nscsqlite_sqlite
    android
)
