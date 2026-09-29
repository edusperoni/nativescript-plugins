# Example: a prebuilt `.so` as an IMPORTED target

Link against a SQLite that someone else compiled — typically the `.so` inside an
Android SQLite AAR.

This works, and it is a handful of lines of CMake. It is also the option where the most
responsibility moves from the plugin to you. Read the whole of this page before
choosing it; the source-built examples have none of these problems.

## What you take on

When SQLite is compiled as part of the plugin's own CMake project, the plugin
handles alignment, symbol hiding, packaging and version agreement. With a
prebuilt library, none of that is true any more.

**Packaging.** The plugin does not put the `.so` in your APK, and CMake
`IMPORTED` targets are not packaged by AGP. Either:

- let a Gradle dependency package it — add the AAR in
  `App_Resources/Android/app.gradle`, and point `NSCSQLITE_PREBUILT_DIR` at the
  extracted `jni/` tree; or
- package loose files yourself, e.g. in `App_Resources/Android/app.gradle`:

  ```groovy
  android {
      sourceSets.main.jniLibs.srcDirs += ["${getAppResourcesPath()}/Android/nscsqlite/prebuilt"]
  }
  ```

  Every ABI you build for needs a matching library, or the app fails at
  `dlopen` — not at build time.

**Headers.** Of six Android SQLite AARs inspected while designing this feature,
**none** ships headers or a Prefab package. You have to supply a `sqlite3.h`
from somewhere else, and there is nothing keeping it in agreement with the
binary: the skew is permanent and grows with every release the provider ships.
A header that declares an API the `.so` does not export is a link error; the
reverse is silent.

**16 KB page alignment.** Google Play requires 16 KB-aligned native libraries
for apps targeting API 35+. The plugin links its own library with
`-Wl,-z,max-page-size=16384`; it cannot re-link yours. Two of the six AARs
inspected were not 16 KB-aligned on all ABIs. Check before you ship:

```bash
unzip -o app.apk 'lib/*' -d /tmp/apklibs
llvm-readelf --program-headers /tmp/apklibs/lib/arm64-v8a/libsqlcipher.so | grep LOAD
```

**Licence.** Zetetic's `sqlcipher-android` is dual-licensed; the Community
Edition requires that you reproduce their copyright notice in your app. Zetetic
documents the Java API only — linking native code directly against their `.so`
is not a supported configuration.

**Symbol hygiene.** The plugin's `-Wl,--exclude-libs,ALL` hides the symbols of
static libraries linked into it. A shared library keeps its own dynamic symbol
table, so its `sqlite3_*` symbols stay visible in the process and can be bound
to by, or collide with, another SQLite loaded alongside it.

## Verifying the link

A missing API shows up as a build error, because the plugin links with
`--no-undefined`. That is the one guard that still applies here, and it is how a
provider missing `sqlite3_compileoption_get` was caught during this feature's
design. See
[Troubleshooting](../../../README.md#troubleshooting) for what to do with such
an error.

## Prebuilt providers surveyed

| artifact | SQLite | `sqlite3_key` | links with the plugin | 16 KB aligned | headers / Prefab |
|---|---|---|---|---|---|
| `net.zetetic:sqlcipher-android` 4.19.0 | 3.53.4 | yes | yes | all ABIs | none |
| `androidx.sqlite:sqlite-bundled-android` 2.7.1 | 3.50.1 | no | yes | all ABIs | none |
| `com.github.requery:sqlite-android` 3.49.0 | 3.49.0 | no | **no** (`sqlite3_compileoption_get`) | arm64 / x86_64 only | none |
| `mil.nga:sqlite-android` | 3.45.2 | no | yes | **no** | none |

The SQLite that ships inside Android itself is not an NDK API and cannot be
linked at all.

## Notes

- The Android SDK's own `sqlite3` is unavailable to native code; this example is
  about libraries you ship.
- If you want one SQLite shared between the plugin and your other native code
  *and* you are willing to compile it, [`../shared-engine`](../shared-engine)
  gives you the same single-copy property with none of the caveats above.
