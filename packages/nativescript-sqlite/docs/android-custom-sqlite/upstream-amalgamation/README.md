# Example: upstream amalgamation with custom flags

The plainest instance of the contract: one `add_library`, one include directory,
one set of compile definitions.

Use this when the `bundled` preset is almost what you want but you need a
different SQLite version, or compile options that `nscsqlite.sqliteFlags` cannot
express (removing one of the preset's defaults, for instance).

## Setup

1. Download an amalgamation from [sqlite.org/download.html](https://sqlite.org/download.html)
   (`sqlite-amalgamation-<version>.zip`).
2. Create `App_Resources/Android/nscsqlite/` and copy this `CMakeLists.txt` into it.
3. Unzip the amalgamation so that `sqlite3.c` and `sqlite3.h` land in
   `App_Resources/Android/nscsqlite/sqlite/`.

```
App_Resources/Android/nscsqlite/
  CMakeLists.txt
  sqlite/
    sqlite3.c
    sqlite3.h
```

Nothing else is needed — the directory is picked up by convention. No Gradle
property, no `nscsqlite.sqlite` value; if `App_Resources/Android/nscsqlite/CMakeLists.txt`
exists it wins, and setting `nscsqlite.sqlite` as well is an error.

## Notes

- Add `sqlite3ext.h` to the `sqlite/` directory too if you intend to compile
  extensions against it later.
- `sqlite/` holds ~9 MB of source. Keep the directory at the top level of
  `App_Resources/Android/` — under `src/` the CLI copies it into the generated
  Gradle project on every prepare.
- SQLite must be at least 3.9.0; anything older fails the plugin's compile-time
  version check with a message naming the requirement.
- Dropping `SQLITE_ENABLE_FTS5` is fine if you do not use FTS5 — the plugin does
  not call into it. Removing APIs the plugin *does* call (e.g. with
  `SQLITE_OMIT_COMPILEOPTION_DIAGS`, which is handled, or an `SQLITE_OMIT_*` that
  is not) surfaces as a link error naming the missing symbol.
