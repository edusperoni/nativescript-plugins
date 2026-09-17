# Shared by the in-repo presets; an app-provided directory owns its own defines
# and does not use this file.

# Produces the compile-definition list for a preset: DEFAULTS, then the user's
# NSCSQLITE_SQLITE_FLAGS, then REQUIRED, with the last definition of a macro
# name winning.  The de-duplication is what makes an override an override: two
# -D options for the same name reach the plugin's C++ sources as a macro
# redefinition, which -Werror turns into a build failure.
function(nscsqlite_preset_definitions out_var)
    cmake_parse_arguments(_arg "" "" "DEFAULTS;REQUIRED" ${ARGN})

    set(_all ${_arg_DEFAULTS})
    foreach(_flag IN LISTS NSCSQLITE_SQLITE_FLAGS)
        string(STRIP "${_flag}" _flag)
        string(REGEX REPLACE "^-D" "" _flag "${_flag}")
        if(NOT _flag STREQUAL "")
            list(APPEND _all "${_flag}")
        endif()
    endforeach()
    list(APPEND _all ${_arg_REQUIRED})

    set(_seen "")
    set(_result "")
    list(REVERSE _all)
    foreach(_flag IN LISTS _all)
        string(REGEX REPLACE "=.*$" "" _name "${_flag}")
        if(NOT "${_name}" IN_LIST _seen)
            list(APPEND _seen "${_name}")
            list(APPEND _result "${_flag}")
        endif()
    endforeach()
    list(REVERSE _result)

    set(${out_var} "${_result}" PARENT_SCOPE)
endfunction()

# The amalgamation is unpacked outside the source tree, so every preset needs
# NSCSQLITE_SQLITE_SOURCE_DIR to have been passed in.
function(nscsqlite_require_source_file preset file)
    if(NOT EXISTS "${NSCSQLITE_SQLITE_SOURCE_DIR}/${file}")
        message(FATAL_ERROR
            "The '${preset}' preset needs NSCSQLITE_SQLITE_SOURCE_DIR to point at an "
            "extracted amalgamation containing ${file} (looked in "
            "'${NSCSQLITE_SQLITE_SOURCE_DIR}'). include.gradle downloads and caches the "
            "archive pinned in native/downloads.properties; pass "
            "-Pnscsqlite.sqliteSourceDir=<dir> to build from a local copy instead.")
    endif()
endfunction()
