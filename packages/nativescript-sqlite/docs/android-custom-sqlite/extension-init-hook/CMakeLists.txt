# App-provided SQLite for @edusperoni/nativescript-sqlite (Android):
# SQLite3MultipleCiphers plus a statically linked extension registered from an
# SQLITE_EXTRA_INIT hook.
#
# The same shape works for a custom VFS: register it from the hook instead of,
# or as well as, calling sqlite3_auto_extension().
#
# Layout this file expects:
#   App_Resources/Android/nscsqlite/
#     CMakeLists.txt                       <- this file
#     nscsqlite_extra_init.c               <- the hook
#     sqlite3mc/sqlite3mc_amalgamation.c
#     sqlite3mc/sqlite3mc_amalgamation.h
#     sqlite3mc/sqlite3.h                  <- the amalgamation header copied over
#                                             the plain upstream one the archive
#                                             ships under that name
#     sqlite-vec/sqlite-vec.c
#     sqlite-vec/sqlite-vec.h

cmake_minimum_required(VERSION 3.15.0)

add_library(nscsqlite_sqlite STATIC
    sqlite3mc/sqlite3mc_amalgamation.c
    sqlite-vec/sqlite-vec.c
    nscsqlite_extra_init.c
)

target_include_directories(nscsqlite_sqlite PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/sqlite3mc")

# Only this target needs to see the extension's own header; the plugin does not.
target_include_directories(nscsqlite_sqlite PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/sqlite-vec")

target_compile_definitions(nscsqlite_sqlite PUBLIC
    SQLITE_ENABLE_FTS5
    SQLITE_THREADSAFE=2
    SQLITE_TEMP_STORE=2
    # SQLite3MC calls its own initializer from a hardcoded call site, so unlike
    # SQLCipher it leaves this macro free for the host to use.
    SQLITE_EXTRA_INIT=nscsqlite_extra_init
)

target_compile_definitions(nscsqlite_sqlite PRIVATE
    # Builds the extension into the engine rather than as a loadable module:
    # it calls the sqlite3_* API directly instead of going through
    # sqlite3_api_routines, and drops sqlite3_extension_init.
    SQLITE_CORE
)

# The extension's entry point is reached from inside this library, never from
# outside it, so nothing here needs to be in the dynamic symbol table.
target_compile_options(nscsqlite_sqlite PRIVATE -fvisibility=hidden)

set_target_properties(nscsqlite_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)
