cmake_minimum_required(VERSION 3.15.0)
set(CMAKE_VERBOSE_MAKEFILE ON)

project(nscsqlite)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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

# The runtime creates every env at module API version 8.
set(COMMON_CMAKE_ARGUMENTS "${COMMON_CMAKE_ARGUMENTS} -DNAPI_VERSION=8")

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

message(STATUS "nscsqlite: sqlite=${_sqlite_label}")

set(SOURCES
    src/sqlite_abi_check.cpp
    src/common/sqlite_connection.cpp
    src/async/thread_pool.cpp
    src/async/napi_dispatcher.cpp
    src/runtime/napi/napi_runtime_adapter.cpp
    src/bindings/napi/database_binding_napi.cpp
)

# Main library target
add_library(
    nscsqlite
    SHARED
    ${SOURCES}
)

# Node-API headers ship as a header-only Prefab package in the runtime AAR.
# NAPI_INCLUDE_DIR short-circuits it for standalone builds outside an app.
if(DEFINED NAPI_INCLUDE_DIR AND EXISTS "${NAPI_INCLUDE_DIR}/node_api.h")
    target_include_directories(nscsqlite PRIVATE ${NAPI_INCLUDE_DIR})
else()
    find_package(NativeScript REQUIRED CONFIG)
    target_link_libraries(nscsqlite NativeScript::NativeScript)
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

# NativeScript runtime stub — provides the Node-API symbols at link time (the
# Prefab package above is header-only) so the dynamic linker records a
# DT_NEEDED entry for libNativeScript.so.  At run time the real
# libNativeScript.so is already loaded by the NS runtime and its symbols are
# resolved from there.
#
# NS_LIBS_DIR is passed by include.gradle when it can extract stubs from the
# @nativescript/android AAR (i.e. when building inside an app).  Fall back to
# the bundled libs/ directory otherwise.
if(DEFINED NS_LIBS_DIR)
    set(_ns_stub_dir "${NS_LIBS_DIR}/${ANDROID_ABI}")
else()
    set(_ns_stub_dir "${PROJECT_SOURCE_DIR}/libs/${ANDROID_ABI}")
endif()

# Linked by name (-L/-l), not as an IMPORTED target: the Android Gradle plugin
# packages IMPORTED shared libraries into the APK, where this stub would replace
# the runtime's own libNativeScript.so (e.g. dropping the inspector from debug builds).
target_link_directories(nscsqlite PRIVATE ${_ns_stub_dir})

# Post-build strip
add_custom_command(TARGET nscsqlite POST_BUILD COMMAND ${CMAKE_STRIP} --strip-unneeded $<TARGET_FILE:nscsqlite>)

target_link_libraries(nscsqlite
    ${system-log}
    NativeScript
    nscsqlite_sqlite
    android
)
