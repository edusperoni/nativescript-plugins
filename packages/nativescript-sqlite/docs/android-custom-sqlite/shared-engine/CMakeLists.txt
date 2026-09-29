# App-provided SQLite for @edusperoni/nativescript-sqlite (Android):
# one SQLite compiled as its own shared library, so the plugin and the app's
# other native code use the same engine instance rather than each holding a
# private static copy.
#
# Layout this file expects:
#   App_Resources/Android/nscsqlite/
#     CMakeLists.txt        <- this file
#     sqlite/sqlite3.c
#     sqlite/sqlite3.h

cmake_minimum_required(VERSION 3.15.0)

add_library(nscsqlite_sqlite SHARED sqlite/sqlite3.c)

set_target_properties(nscsqlite_sqlite PROPERTIES
    # The SONAME other code links against. Deliberately not "sqlite3": a
    # libsqlite3.so in the APK competes with anything else in the process that
    # expects that name.
    OUTPUT_NAME nscsqlite3
    C_VISIBILITY_PRESET hidden
    POSITION_INDEPENDENT_CODE ON)

target_include_directories(nscsqlite_sqlite PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/sqlite")

target_compile_definitions(nscsqlite_sqlite PUBLIC
    SQLITE_THREADSAFE=2
    SQLITE_ENABLE_FTS5
    # The amalgamation leaves SQLITE_API empty on ELF, so with hidden default
    # visibility the library would export nothing at all.
    "SQLITE_API=__attribute__((visibility(\"default\")))")
