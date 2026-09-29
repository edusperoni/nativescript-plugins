# The default SQLite for @nativescript/sqlite: the upstream amalgamation.
#
# This is an in-repo instance of the same contract an app-provided directory
# satisfies: define a target named `nscsqlite_sqlite` carrying its own PUBLIC
# include directory, compile definitions and link dependencies.
cmake_minimum_required(VERSION 3.15.0)

include("${CMAKE_CURRENT_LIST_DIR}/../preset_definitions.cmake")

nscsqlite_require_source_file(bundled sqlite3.c)

add_library(nscsqlite_sqlite STATIC "${NSCSQLITE_SQLITE_SOURCE_DIR}/sqlite3.c")

target_include_directories(nscsqlite_sqlite PUBLIC "${NSCSQLITE_SQLITE_SOURCE_DIR}")

# Upstream SQLite has no codec, so `PRAGMA key` would return SQLITE_OK and write
# the database in plaintext.  The binding refuses a key instead.
nscsqlite_preset_definitions(_definitions
    DEFAULTS
        SQLITE_ENABLE_FTS5
    REQUIRED
        SQLITE_THREADSAFE=2
        NSCSQLITE_ENGINE_HAS_NO_CODEC
)
target_compile_definitions(nscsqlite_sqlite PUBLIC ${_definitions})

target_compile_options(nscsqlite_sqlite PRIVATE -ffunction-sections -fvisibility=hidden)

set_target_properties(nscsqlite_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)
