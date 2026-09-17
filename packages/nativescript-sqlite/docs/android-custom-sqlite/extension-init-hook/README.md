# Example: an init hook or statically linked extension

Anything that has to exist before the first connection is opened — a
statically linked extension, an auto-extension registration — goes through
SQLite's `SQLITE_EXTRA_INIT` hook. SQLite calls it once, from inside
`sqlite3_initialize()`.

This example links [sqlite-vec](https://github.com/asg017/sqlite-vec) into
SQLite3MultipleCiphers and registers it from such a hook, so `vec0` virtual
tables work on every connection the plugin opens.

## Files

```
App_Resources/Android/nscsqlite/
  CMakeLists.txt
  nscsqlite_extra_init.c
  sqlite3mc/
    sqlite3mc_amalgamation.c
    sqlite3mc_amalgamation.h
    sqlite3.h            # sqlite3mc_amalgamation.h copied over this name
  sqlite-vec/
    sqlite-vec.c
    sqlite-vec.h
```

`sqlite3mc_amalgamation.h` is a strict superset of `sqlite3.h`, so copying it in
under that name is all the adaptation SQLite3MC needs. The plugin's
`#include <sqlite3.h>` then also sees `sqlite3_key_v2()` and
`sqlite3mc_config()`.

**Overwrite, do not rename.** The SQLite3MC archive already ships a plain
upstream `sqlite3.h` beside the amalgamation. Leave it in place and it is the
one the plugin's include path finds, and the encryption API disappears from the
build. The in-repo `sqlite3mc` preset sidesteps this by copying the header into
a directory of its own; in an app-provided directory, replacing the file is
simpler.

## Chaining, not replacing

`SQLITE_EXTRA_INIT` holds exactly one function name, and some engines already
use it. SQLCipher sets it to `sqlcipher_extra_init`, which is how its crypto
provider gets registered — and its guard is:

```c
#if !defined(SQLITE_EXTRA_INIT)
```

That tests whether the macro *exists*, not what it names. Put your own function
there and the build succeeds, the tests that do not check encryption pass, and
the crypto provider is never registered. So on SQLCipher the hook must call
`sqlcipher_extra_init(unused)` first and return its result if it fails:

```c
int nscsqlite_extra_init(const char *unused) {
  int rc = sqlcipher_extra_init(unused);
  if (rc != SQLITE_OK) return rc;
  return sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
}
```

SQLite3MC calls `sqlite3mc_initialize()` from a hardcoded call site of its own,
so on that engine the hook is free and no chaining is needed.

## Why extension sources need `SQLITE_CORE` and hidden visibility

- `SQLITE_CORE` tells the extension it is being compiled *into* SQLite: it calls
  the `sqlite3_*` API directly rather than through the `sqlite3_api_routines`
  dispatch table, and it does not emit a loadable-module entry point.
- `-fvisibility=hidden` keeps the extension's symbols out of the dynamic symbol
  table. They are only ever called from inside this library. The plugin also
  links with `-Wl,--exclude-libs,ALL`, which hides the symbols of static
  libraries linked into it, so for a static target this is belt and braces —
  but it is the difference between the two on a `SHARED` engine.

## Auto-extensions vs `onOpen`

`sqlite3_auto_extension()` runs inside `sqlite3_open_v2()` — **before** the
plugin applies `PRAGMA key`. Anything that needs to read the schema of an
encrypted database cannot happen there. Use the plugin's
[`onOpen`](../../../README.md#opendatabaseoptions-sqlitedatabase) option for that
instead; it runs on every connection, immediately after keying and before any
query.

## Not available for the built-in presets

The plugin does **not** expose `nscsqlite.sqliteFlags=SQLITE_EXTRA_INIT=...` as a
working pass-through for `bundled` or `sqlite3mc`. A raw pass-through cannot be
made safe for the general case, for the SQLCipher reason above: the macro is
tested for existence, so a user-supplied value silently displaces whatever the
engine needed there, and the failure is invisible at build time.

Statically linked extensions for the built-in presets are out of scope for this
release. If you need one, use the app-provided directory — which is what this
example is.
