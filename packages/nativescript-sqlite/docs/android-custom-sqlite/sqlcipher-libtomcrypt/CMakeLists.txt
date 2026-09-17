# App-provided SQLite for @edusperoni/nativescript-sqlite (Android):
# SQLCipher with the LibTomCrypt crypto provider. Static, no OpenSSL, no
# Prefab dependency, nothing extra in the APK.
#
# Layout this file expects:
#   App_Resources/Android/nscsqlite/
#     CMakeLists.txt              <- this file
#     sqlcipher/sqlite3.c         <- SQLCipher amalgamation
#     sqlcipher/sqlite3.h
#     libtomcrypt/src/...         <- unpacked LibTomCrypt release
#
# Point LTC_DIR elsewhere if LibTomCrypt lives outside App_Resources.

cmake_minimum_required(VERSION 3.15.0)

set(LTC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/libtomcrypt"
    CACHE PATH "Unpacked LibTomCrypt source tree")

# ---------------------------------------------------------------------------
# LibTomCrypt
# ---------------------------------------------------------------------------

file(GLOB_RECURSE LTC_SOURCES "${LTC_DIR}/src/*.c")

add_library(nscsqlite_tomcrypt STATIC ${LTC_SOURCES})

target_include_directories(nscsqlite_tomcrypt PUBLIC "${LTC_DIR}/src/headers")

target_compile_definitions(nscsqlite_tomcrypt PUBLIC
    LTC_SOURCE
    # LTC_NOTHING switches every algorithm off; each LTC_* below opts one back
    # in. The set is exactly what SQLCipher's LibTomCrypt provider calls.
    LTC_NOTHING
    # Keeps the bignum layer out, which is what removes the libtommath
    # dependency: src/math/ltm_desc.c is the only file that includes
    # <tommath.h>, and it is #ifdef LTM_DESC.
    LTC_NO_MATH
    LTC_NO_ASM
    # Makes LTC_ARGCHK return an error instead of calling crypt_argchk(), whose
    # default lands on abort() — a bad argument would otherwise take the whole
    # app process down rather than failing the statement.
    ARGTYPE=4
    LTC_RIJNDAEL
    LTC_CBC_MODE
    LTC_SHA1
    LTC_SHA256
    LTC_SHA512
    LTC_HMAC
    LTC_PKCS_5
    LTC_FORTUNA
    LTC_RNG_GET_BYTES
    LTC_DEVRANDOM
    LTC_TRY_URANDOM_FIRST
    LTC_HASH_HELPERS
)

# Third-party sources that are not warning-clean under the plugin's flags.
target_compile_options(nscsqlite_tomcrypt PRIVATE -Wno-everything -fvisibility=hidden)

set_target_properties(nscsqlite_tomcrypt PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ---------------------------------------------------------------------------
# SQLCipher
# ---------------------------------------------------------------------------

find_library(_log log)

add_library(nscsqlite_sqlite STATIC sqlcipher/sqlite3.c)

target_include_directories(nscsqlite_sqlite PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/sqlcipher")

target_compile_definitions(nscsqlite_sqlite PUBLIC
    # PUBLIC because it gates the sqlite3_key()/sqlite3_rekey() declarations in
    # sqlite3.h, which the plugin also reads.
    SQLITE_HAS_CODEC
    SQLCIPHER_CRYPTO_LIBTOMCRYPT
    # Zetetic's documented build setting: temp tables and spill files stay in
    # memory, so plaintext never reaches a file the codec does not cover.
    SQLITE_TEMP_STORE=2
    SQLITE_THREADSAFE=2
    # SQLCipher registers its crypto provider from these hooks. Its guard is
    # `#if !defined(SQLITE_EXTRA_INIT)` — it tests only that the macro exists —
    # so naming anything else here silently leaves the provider unregistered.
    SQLITE_EXTRA_INIT=sqlcipher_extra_init
    SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown
    SQLITE_ENABLE_FTS5
    SQLITE_ENABLE_RTREE
    SQLITE_HAVE_ISNAN
    SQLITE_OMIT_LOAD_EXTENSION
    NDEBUG
)

set_target_properties(nscsqlite_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)

# PUBLIC so both propagate onto the plugin's link line.
target_link_libraries(nscsqlite_sqlite PUBLIC nscsqlite_tomcrypt ${_log})
