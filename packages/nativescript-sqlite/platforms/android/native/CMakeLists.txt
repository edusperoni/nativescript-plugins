cmake_minimum_required(VERSION 3.15.0)
set(CMAKE_VERBOSE_MAKEFILE ON)

project(nscsqlite)

set(CMAKE_CXX_STANDARD 17)
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

set(COMMON_CMAKE_ARGUMENTS "-std=c++17 -pthread -Werror -v -Wno-unused-result -mstackrealign -fexceptions -fno-builtin-stpcpy -DV8_31BIT_SMIS_ON_64BIT_ARCH")

if ("${ANDROID_ABI}" MATCHES "arm64-v8a$" OR "${ANDROID_ABI}" MATCHES "x86_64$")
    set(COMMON_CMAKE_ARGUMENTS "${COMMON_CMAKE_ARGUMENTS} -DV8_COMPRESS_POINTERS")
endif ()

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${COMMON_CMAKE_ARGUMENTS}")

# SQLite Implementation Selection
if(NOT DEFINED MYLIB_SQLITE_IMPL)
    set(MYLIB_SQLITE_IMPL "bundled")
endif()

message(STATUS "Using SQLite implementation: ${MYLIB_SQLITE_IMPL}")

if(MYLIB_SQLITE_IMPL STREQUAL "bundled")
    add_subdirectory(third_party/sqlite)
    set(SQLITE_TARGET SQLite::SQLite3)
    
elseif(MYLIB_SQLITE_IMPL STREQUAL "sqlcipher")
    add_subdirectory(third_party/sqlcipher)
    set(SQLITE_TARGET SQLite::SQLite3)

elseif(MYLIB_SQLITE_IMPL STREQUAL "custom")
    set(_abi_lib_dir "${MYLIB_SQLITE_LIB_DIR}/${ANDROID_ABI}")
    
    find_library(SQLITE_CUSTOM_LIB
        NAMES ${MYLIB_SQLITE_LIB_NAME}
        PATHS ${_abi_lib_dir}
        NO_DEFAULT_PATH
        REQUIRED
    )
    
    add_library(sqlite_custom SHARED IMPORTED)
    set_target_properties(sqlite_custom PROPERTIES
        IMPORTED_LOCATION ${SQLITE_CUSTOM_LIB}
        INTERFACE_INCLUDE_DIRECTORIES ${MYLIB_SQLITE_INCLUDE_DIR}
    )
    
    set(SQLITE_TARGET sqlite_custom)
    
else()
    message(FATAL_ERROR "Unknown SQLite implementation: ${MYLIB_SQLITE_IMPL}")
endif()

# Include directories
include_directories(
    ${PROJECT_SOURCE_DIR}/src/include
    ${PROJECT_SOURCE_DIR}/src/include/libc++
)

# Source files
file(GLOB_RECURSE SOURCES
    "src/common/*.cpp"
    "src/async/*.cpp"
    "src/runtime/v8/*.cpp"
    "src/bindings/*.cpp"
)

# Main library target
add_library(
    nscsqlite
    SHARED
    ${SOURCES}
)

set_target_properties(
    nscsqlite PROPERTIES
    CXX_STANDARD 17
    CXX_EXTENSIONS OFF
    POSITION_INDEPENDENT_CODE ON
    LINK_FLAGS -Wl,--allow-multiple-definition
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
    ${SQLITE_TARGET}
    android
)
