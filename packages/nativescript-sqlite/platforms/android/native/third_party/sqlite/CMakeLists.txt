cmake_minimum_required(VERSION 3.15.0)

add_library(sqlite3_bundled STATIC
    sqlite3.c
    sqlite3.h
)

target_include_directories(sqlite3_bundled PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

# Allow custom compile flags
if(DEFINED MYLIB_SQLITE_FLAGS)
    # Split the semicolon-separated string into a list
    string(REPLACE ";" " " FLAG_LIST "${MYLIB_SQLITE_FLAGS}")
    target_compile_definitions(sqlite3_bundled PUBLIC ${FLAG_LIST})
else()
    # Default flags if none provided
    target_compile_definitions(sqlite3_bundled PUBLIC
        SQLITE_ENABLE_FTS5
        SQLITE_THREADSAFE=2 # Multi-thread mode: safe for multiple threads to use different db connections
    )
endif()

if(UNIX AND (CMAKE_COMPILER_IS_GNUCXX OR ${CMAKE_CXX_COMPILER_ID} STREQUAL "Clang"))
    set_target_properties(sqlite3_bundled PROPERTIES COMPILE_FLAGS "-fPIC")
    target_compile_options(sqlite3_bundled PRIVATE "-ffunction-sections")
endif()

add_library(SQLite::SQLite3 ALIAS sqlite3_bundled)
