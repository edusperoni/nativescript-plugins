# Example: SQLCipher with LibTomCrypt

Real SQLCipher — `PRAGMA cipher_version`, `PRAGMA cipher_migrate`,
`sqlcipher_export()` and the rest of its pragma surface — built statically with
LibTomCrypt as the crypto provider.

This is the provider Zetetic's own `sqlcipher-android` artifact uses. Nothing
extra lands in the APK: no `libcrypto.so`, no Prefab dependency, no forced
`c++_shared`.

**Before choosing this, read the cost section below.** If you only need
encrypted databases that interoperate with `pod 'SQLCipher'` on iOS, the
built-in [`sqlite3mc` preset](../../../README.md#sqlite3mc-encryption) gives you
that with a one-line Gradle property and faster crypto on arm64.

## Setup

1. Get a SQLCipher amalgamation (`sqlite3.c` + `sqlite3.h`) — from a SQLCipher
   release tarball, or by running `./configure && make sqlite3.c` in a SQLCipher
   checkout.
2. Get a [LibTomCrypt](https://github.com/libtom/libtomcrypt) release and unpack it.
3. Lay them out under `App_Resources/Android/nscsqlite/`:

```
App_Resources/Android/nscsqlite/
  CMakeLists.txt
  sqlcipher/
    sqlite3.c
    sqlite3.h
  libtomcrypt/
    src/...
```

Then open the database with a key as usual:

```typescript
const db = openDatabase({
  path: knownFolders.documents().path + '/encrypted.sqlite',
  encryptionKey: 'my-secret-key',
  onOpen: [
    // Resolving sqlcipher_export fails at prepare time on an engine that is not
    // SQLCipher; the CASE means it is never actually called.
    "SELECT CASE WHEN 0 THEN sqlcipher_export('main') END",
  ],
});
```

That `onOpen` line is worth having because the plugin cannot tell whether an
app-provided engine encrypts — it only knows that for its own `bundled` preset.
The assertion is **specific to real SQLCipher**: it would fail on the `sqlite3mc`
preset, which encrypts perfectly well and has no `sqlcipher_export`. See
[Encryption Caveats](../../../README.md#encryption-caveats), which also gives an
engine-independent probe.

## Cost

All numbers below were measured on a **host** arm64 build at `-O2`, not on a
device — treat them as a ratio, not as a budget.

LibTomCrypt has no ARMv8 crypto-extension paths, so it is materially slower than
OpenSSL:

| operation | LibTomCrypt | OpenSSL |
|---|---|---|
| PBKDF2-HMAC-SHA512, 256,000 iterations (SQLCipher's default) | 237 ms | 62 ms |
| AES-256-CBC page crypto | 286 MiB/s | 1,702 MiB/s |

The key derivation runs **on every connection**, and this plugin opens
`poolSize + 2` of them — a writer, `poolSize` readers and a sync connection —
**synchronously, on the JavaScript thread, inside `openDatabase()`**. At the
default `poolSize: 4` that is six derivations before the first query. For a sense
of scale, the `sqlite3mc` preset measured ≈ 90 ms per keyed connection and
≈ 540 ms per `openDatabase()` on an emulator; **this configuration has not been
measured on Android at all**, and the host ratios above are the only evidence
there is. Two things reduce it:

- `encryptionKeyFormat: 'raw'` skips PBKDF2 entirely. Only do this if your key is
  already full-entropy random bytes — see
  [Passphrase vs raw key](../../../README.md#passphrase-vs-raw-key).
- `serialized: true` or a smaller `poolSize` means fewer connections to key.

Size, measured on an arm64 link of the plugin: +93 KB over plain SQLite, with the
`DT_NEEDED` list identical to the baseline build.

## Two upstream issues to be aware of

Both are in SQLCipher's LibTomCrypt provider as shipped, and were found by
reading the source rather than by hitting them at runtime:

- `sqlcipher_ltc_activate()` ignores the return value of `rng_get_bytes()`. If
  `/dev/urandom` cannot be opened — fd exhaustion, for example — Fortuna can end
  up seeded with zeros while the call still reports success.
- Its error paths return without releasing the provider mutex, so a failed first
  activation deadlocks later opens.

## Notes

- `SQLITE_HAS_CODEC` **must** be PUBLIC. It gates the `sqlite3_key()` /
  `sqlite3_rekey()` declarations in `sqlite3.h`, and the plugin compiles against
  that same header.
- `ARGTYPE=4` is a correctness setting, not tuning. LibTomCrypt's default
  `LTC_ARGCHK` routes a bad argument to `abort()`, which kills the app process
  instead of returning an error.
- Do not put your own value in `SQLITE_EXTRA_INIT` here. SQLCipher's guard is
  `#if !defined(SQLITE_EXTRA_INIT)`, so any other name compiles cleanly and
  leaves the crypto provider unregistered. To chain your own initialisation, use
  the shim pattern in [`../extension-init-hook`](../extension-init-hook).
- SQLCipher and the plugin's `sqlite3mc` preset produce the same file format
  when SQLCipher is at its version 4 defaults, but they are different engines:
  databases move between them, pragmas do not.
