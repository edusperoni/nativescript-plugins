# Example: a SHARED engine shared with other native code

By default the plugin links SQLite statically, so `libnscsqlite.so` contains its
own private copy. That is the right answer for almost every app.

Build the engine as a shared library instead when the app has **other** native
code that must talk to the same SQLite — the same page cache, the same
registered functions, the same `sqlite3_auto_extension` list. Two
static copies in one process are two independent engines that merely happen to
open the same files.

It also makes the engine swappable: in the prototype behind this example, the
`.so` was replaced with a build of a different SQLite version without relinking
the plugin, and all 33 APIs the plugin needs still resolved.

## Setup

```
App_Resources/Android/nscsqlite/
  CMakeLists.txt
  sqlite/
    sqlite3.c
    sqlite3.h
```

Your other native target then links `nscsqlite_sqlite` the same way the plugin
does, or declares its own `SHARED IMPORTED` target for `libnscsqlite3.so`.

## What to check

- **The library must reach the APK.** It is produced by the same external native
  build as `libnscsqlite.so`, so AGP should package it alongside; confirm it
  once with `unzip -l platforms/android/app/build/outputs/apk/debug/app-debug.apk | grep 'lib/'`.
  If it is missing at run time the app fails at `dlopen`, not at build time.
- **Symbols are exported on purpose here.** `libnscsqlite3.so` has a dynamic
  symbol table with `sqlite3_*` in it — that is the point of the exercise, and it
  is the thing the static default avoids. Keeping the SONAME `libnscsqlite3.so`
  rather than `libsqlite3.so` is what stops an unrelated dependency from binding
  to it by accident.
- **16 KB alignment.** The plugin passes `-Wl,-z,max-page-size=16384` when it
  links its own library. If your NDK is older than r28 you may want the same flag
  on this target: `target_link_options(nscsqlite_sqlite PRIVATE -Wl,-z,max-page-size=16384)`.
- **`SQLITE_API` is not optional** with `C_VISIBILITY_PRESET hidden`. The
  amalgamation defines `SQLITE_API` as nothing on ELF, so without the override in
  the `CMakeLists.txt` the library exports no symbols and the plugin fails to
  link.
