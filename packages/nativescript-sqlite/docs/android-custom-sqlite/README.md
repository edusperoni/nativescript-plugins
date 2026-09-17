# App-provided SQLite on Android — worked examples

Five complete `CMakeLists.txt` files for the plugin's app-provided SQLite hook.
Each directory holds one file you can copy into
`App_Resources/Android/nscsqlite/` plus a short page explaining what it does and
what it costs.

Start from [Bringing your own SQLite](../../README.md#bringing-your-own-sqlite)
in the main README for the contract these all implement.

| example | what it is for |
|---|---|
| [`upstream-amalgamation`](upstream-amalgamation) | The plainest instance of the contract: upstream SQLite with your own compile options. |
| [`sqlcipher-libtomcrypt`](sqlcipher-libtomcrypt) | Real SQLCipher, statically linked, no OpenSSL. For apps that need SQLCipher's own pragmas. |
| [`prebuilt-imported`](prebuilt-imported) | Link a `.so` someone else compiled. Fewest lines, most caveats. |
| [`shared-engine`](shared-engine) | One SQLite shared with the app's other native code instead of a private static copy. |
| [`extension-init-hook`](extension-init-hook) | An `SQLITE_EXTRA_INIT` hook or a statically linked extension. |

The two built-in presets are instances of the same contract and are the
shortest reference examples of all:

- [`platforms/android/native/sqlite/bundled/CMakeLists.txt`](../../platforms/android/native/sqlite/bundled/CMakeLists.txt)
- [`platforms/android/native/sqlite/sqlite3mc/CMakeLists.txt`](../../platforms/android/native/sqlite/sqlite3mc/CMakeLists.txt)

## The contract, in one paragraph

Define one target called **`nscsqlite_sqlite`** — `STATIC`, `SHARED` or
`IMPORTED`. Give it a **PUBLIC** include directory containing a usable
`sqlite3.h`, its compile definitions (PUBLIC for anything that changes what
`sqlite3.h` declares, such as `SQLITE_HAS_CODEC`), and its link dependencies as
**PUBLIC** so they reach the plugin's link line. That is the entire interface.
