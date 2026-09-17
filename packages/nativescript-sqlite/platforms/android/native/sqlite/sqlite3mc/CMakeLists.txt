# SQLite3MultipleCiphers for @nativescript/sqlite: SQLite plus seven ciphers,
# bundled crypto, no external dependency.
#
# This is an in-repo instance of the same contract an app-provided directory
# satisfies: define a target named `nscsqlite_sqlite` carrying its own PUBLIC
# include directory, compile definitions and link dependencies.
cmake_minimum_required(VERSION 3.15.0)

include("${CMAKE_CURRENT_LIST_DIR}/../preset_definitions.cmake")

nscsqlite_require_source_file(sqlite3mc sqlite3mc_amalgamation.c)

# sqlite3mc_amalgamation.h is a superset of sqlite3.h and is what the plugin's
# `#include <sqlite3.h>` has to resolve to.  It is copied into a directory of
# its own because the amalgamation ships the plain upstream sqlite3.h beside
# it, which would win if that directory were on the include path.
configure_file(
    "${NSCSQLITE_SQLITE_SOURCE_DIR}/sqlite3mc_amalgamation.h"
    "${CMAKE_CURRENT_BINARY_DIR}/include/sqlite3.h"
    COPYONLY)

add_library(nscsqlite_sqlite STATIC
    "${NSCSQLITE_SQLITE_SOURCE_DIR}/sqlite3mc_amalgamation.c")

target_include_directories(nscsqlite_sqlite PUBLIC "${CMAKE_CURRENT_BINARY_DIR}/include")

# CODEC_TYPE_SQLCIPHER in legacy mode makes a bare `PRAGMA key` read and write
# SQLCipher 4 databases, so an app can share files with what `pod 'SQLCipher'`
# produces on iOS.
nscsqlite_preset_definitions(_definitions
    DEFAULTS
        SQLITE_ENABLE_FTS5
        CODEC_TYPE=CODEC_TYPE_SQLCIPHER
        SQLITE3MC_USE_SQLCIPHER_LEGACY
    REQUIRED
        SQLITE_THREADSAFE=2
        SQLITE_TEMP_STORE=2
)
target_compile_definitions(nscsqlite_sqlite PUBLIC ${_definitions})

target_compile_options(nscsqlite_sqlite PRIVATE -ffunction-sections -fvisibility=hidden)

set_target_properties(nscsqlite_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)
