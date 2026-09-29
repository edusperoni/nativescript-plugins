# App-provided SQLite for @edusperoni/nativescript-sqlite (Android):
# the upstream amalgamation, compiled with the app's own options.
#
# The plugin add_subdirectory()s this file and links the single target
# `nscsqlite_sqlite`. Everything it needs to compile and link against SQLite
# has to travel on that target, which is why each property below is PUBLIC.
#
# Layout this file expects:
#   App_Resources/Android/nscsqlite/
#     CMakeLists.txt        <- this file
#     sqlite/sqlite3.c      <- from sqlite-amalgamation-<version>.zip
#     sqlite/sqlite3.h

cmake_minimum_required(VERSION 3.15.0)

add_library(nscsqlite_sqlite STATIC sqlite/sqlite3.c)

# PUBLIC: the plugin's own translation units do `#include <sqlite3.h>` and
# resolve it through this directory.
target_include_directories(nscsqlite_sqlite PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/sqlite")

# PUBLIC rather than PRIVATE: these are in force while sqlite3.h is being read
# by the plugin too, and several of them change what that header declares.
target_compile_definitions(nscsqlite_sqlite PUBLIC
    # Multi-thread mode. The plugin never lets two threads touch one connection
    # at the same time, so full serialization (=1) would only buy mutex traffic.
    # 0 is rejected at the first open.
    SQLITE_THREADSAFE=2
    SQLITE_ENABLE_FTS5
    SQLITE_ENABLE_RTREE
    # A mistyped identifier is an error instead of silently becoming a string
    # literal.
    SQLITE_DQS=0
)

# The plugin is a shared library, so everything linked into it must be PIC.
set_target_properties(nscsqlite_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)
