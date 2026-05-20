cmake_minimum_required(VERSION 3.15.0)

# ---------------------------------------------------------------------------
# SQLCipher amalgamation build target.
#
# Before using this target you must generate sqlite3.c and sqlite3.h from the
# SQLCipher source tree and copy them here.  See the README.md in this
# directory for step-by-step instructions.
#
# This target exposes the same alias as the bundled SQLite target
# (SQLite::SQLite3) so the rest of the build graph needs no changes.
# ---------------------------------------------------------------------------

add_library(sqlcipher_bundled STATIC
    sqlite3.c
)

target_include_directories(sqlcipher_bundled PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(sqlcipher_bundled PUBLIC
    SQLITE_HAS_CODEC
    SQLCIPHER_CRYPTO_OPENSSL
    SQLITE_ENABLE_FTS5
    SQLITE_THREADSAFE=2
    SQLITE_TEMP_STORE=2
    SQLITE_EXTRA_INIT=sqlcipher_extra_init
    SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown
)

if(UNIX AND (CMAKE_COMPILER_IS_GNUCXX OR ${CMAKE_CXX_COMPILER_ID} STREQUAL "Clang"))
    set_target_properties(sqlcipher_bundled PROPERTIES COMPILE_FLAGS "-fPIC")
    target_compile_options(sqlcipher_bundled PRIVATE "-ffunction-sections")
endif()

# OpenSSL is provided by the Android NDK prefab:
#   com.android.ndk.thirdparty:openssl (declared in include.gradle)
# find_package resolves it via the prefab-generated CMake config.
find_package(openssl REQUIRED CONFIG)
target_link_libraries(sqlcipher_bundled PUBLIC openssl::crypto)

add_library(SQLite::SQLite3 ALIAS sqlcipher_bundled)
