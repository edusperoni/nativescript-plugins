# @edusperoni/nativescript-sqlite

A high-performance SQLite plugin for NativeScript. All database operations run on background threads — GCD queues on iOS, a native thread pool on Android — so the JavaScript thread is never blocked.

**Platform support:** iOS, Android

## Features

- Fully asynchronous — all queries dispatch to native background threads
- Connection pool with WAL mode — concurrent reads, serialized writes
- Transaction queue — concurrent `transaction()` calls are safe, they wait their turn
- Write and read transactions with savepoint (nested transaction) support
- Prepared statements
- Two result formats: objects (`select`) or columnar arrays (`selectArray`)
- Synchronous API sharing the writer connection with the async one — ordered against it, not racing it
- Fully synchronous transactions (`transactionSync`) for migrations and setup
- Custom SQLite builds supported (CocoaPods on iOS, a one-target CMake hook on Android)
- Encryption on both platforms, in the same file format (SQLCipher on iOS, SQLite3MultipleCiphers on Android)
- Drizzle ORM driver included

## Installation

```bash
npm install @edusperoni/nativescript-sqlite
```

**iOS:** The plugin does not bundle SQLite — you must link one. For most apps add to `App_Resources/iOS/build.xcconfig`:

```
OTHER_LDFLAGS = $(inherited) -lsqlite3
```

**Android:** No setup needed — the plugin compiles SQLite itself. The first build downloads a pinned amalgamation and caches it. For encryption, extra compile flags, or your own SQLite build, see [Android SQLite Setup](#android-sqlite-setup).

For all linking options see [iOS SQLite Linking](#ios-sqlite-linking) and [Android SQLite Setup](#android-sqlite-setup).

## Quick Start

```typescript
import { openDatabase } from '@edusperoni/nativescript-sqlite';
import { knownFolders } from '@nativescript/core';

const db = openDatabase({
  path: knownFolders.documents().path + '/mydb.sqlite',
});

// Create a table
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    age INTEGER
  )
`);

// Insert data
await db.execute(
  'INSERT INTO users (name, email, age) VALUES (?, ?, ?)',
  ['Alice', 'alice@example.com', 30]
);

// Query rows (returns array of objects)
const users = await db.select('SELECT * FROM users WHERE age > ?', [25]);
// => [{ id: 1, name: "Alice", email: "alice@example.com", age: 30 }]

// Get a single row
const user = await db.get('SELECT * FROM users WHERE id = ?', [1]);
// => { id: 1, name: "Alice", ... } or undefined

// Clean up
await db.close();
```

## API Reference

### `openDatabase(options): SQLiteDatabase`

Opens a database and returns a `SQLiteDatabase` instance. The connection pool is created immediately; you can start using the database right away, without waiting for it — see [Opening off the JavaScript thread](#opening-off-the-javascript-thread).

```typescript
const db = openDatabase({
  path: '/path/to/database.sqlite',
  readOnly: false,      // default: false
  poolSize: 4,          // number of reader connections, default: 4
  busyTimeout: 5000,    // milliseconds, default: 5000
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | *required* | Full path to the database file, or `":memory:"` |
| `readOnly` | `boolean` | `false` | Open in read-only mode |
| `poolSize` | `number` | `4` | Number of reader connections in the pool (ignored in serialized mode) |
| `busyTimeout` | `number` | `5000` | Busy timeout in milliseconds |
| `serialized` | `boolean` | auto | Use a single serialized connection instead of the reader pool. Defaults to `true` for in-memory databases, `false` otherwise |
| `encryptionKey` | `string` | — | Applied to every connection via `PRAGMA key`. Requires an engine with a codec — see [Encryption Caveats](#encryption-caveats) |
| `encryptionKeyFormat` | `'passphrase' \| 'raw'` | `'passphrase'` | How `encryptionKey` is interpreted. See [Passphrase vs raw key](#passphrase-vs-raw-key) |
| `onOpen` | `string[]` | `[]` | SQL run on every connection right after `PRAGMA key`, before anything else. A statement that fails aborts the open |
| `asyncOpen` | `boolean` | `false` | Open the writer on a background thread as well, so `openDatabase()` neither blocks nor throws. See [Opening off the JavaScript thread](#opening-off-the-javascript-thread) |

> **In-memory databases:** passing `":memory:"` (or an empty path) defaults to **serialized mode** — a single connection handles all reads, writes, transactions, and sync calls. This is required because a pool of separate connections cannot share a private in-memory database. In serialized mode at most one transaction is active at a time and reads never run concurrently with writes. Each `openDatabase(":memory:")` call gets its own isolated database.
>
> To run a connection *pool* over an in-memory database instead, set `serialized: false` and pass a [`memdb` VFS](https://sqlite.org/uri.html) URI (SQLite ≥ 3.36, i.e. iOS 15+) so the pooled connections share one database:
>
> ```ts
> openDatabase({ path: 'file:/mydb?vfs=memdb', serialized: false });
> ```
>
> Prefer `memdb` over the older `?mode=memory&cache=shared` (shared-cache) form: shared cache uses table-level locking and returns `SQLITE_LOCKED` on contention, which `busyTimeout` does **not** retry; `memdb` returns a retryable `SQLITE_BUSY` instead. The shared in-memory database lives only while at least one connection is open (the pool keeps it alive), and is destroyed once the database is closed. The URI name must begin with `/`.

#### Opening off the JavaScript thread

Opening a connection is not always cheap. With an `encryptionKey` it costs a PBKDF2 derivation — [around 90 ms each](#the-cost-of-a-passphrase), once per connection — so where those opens run matters.

- **Reader connections are always opened by their own threads.** Their key derivation never runs on the JavaScript thread; it surfaces as latency on the first read routed to each reader.
- **The writer is opened synchronously inside `openDatabase()`** by default, so a bad path, a wrong key or a failing `onOpen` statement still throws from `openDatabase()` itself, where you would look for it.
- **`asyncOpen: true` opens the writer on a background thread too.** `openDatabase()` then returns immediately and **never throws for an open failure** — there is nothing left in it that can fail.

`initialized()` resolves once every connection is open, and rejects with the error that failed the open:

```typescript
const db = openDatabase({ path: dbPath, encryptionKey: passphrase, asyncOpen: true });

try {
  await db.initialized();
} catch (e) {
  // wrong key, bad path, a failing onOpen statement — nothing was thrown by openDatabase()
}
```

**Awaiting it is optional**, `asyncOpen` or not. Async methods queue behind the opens on their own and reject with the open error if one failed; sync methods block until the writer is open and then run or throw. So the default case needs nothing at all:

```typescript
const db = openDatabase({ path: dbPath });
await db.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)');
```

`initialized()` is there for callers that want the failure at a point of their choosing — which, with `asyncOpen`, is the only way to get it up front.

A reader that fails to open is not quietly dropped from the pool: reads routed to it fail with that open error.

`isOpen` is true from `openDatabase()` until `close()`, including while connections are still opening. It answers "has this database been closed", not "is it ready".

### SQLiteDatabase

#### Async Methods

All async methods dispatch work to background threads and return Promises. Reads use reader connections from the pool; writes use the writer connection — the same one the [sync methods](#sync-methods) run on.

```typescript
// Execute a write statement (INSERT, UPDATE, DELETE, CREATE, etc.)
await db.execute(sql, params?);

// Query multiple rows as objects
const rows = await db.select<MyType>(sql, params?);

// Query multiple rows as columnar arrays (more efficient for large results)
const result = await db.selectArray(sql, params?);
// result.columns => ['id', 'name', 'age']
// result.rows    => [[1, 'Alice', 30], [2, 'Bob', 25]]

// Query a single row as an object
const row = await db.get<MyType>(sql, params?);

// Query a single row as a columnar array
const rowArr = await db.getArray(sql, params?);
// rowArr.columns => ['id', 'name', 'age']
// rowArr.rows    => [[1, 'Alice', 30]]  (or [] if no match)
```

#### Sync Methods

Synchronous methods block the JavaScript thread and hand you the result directly. Use these for migrations, app setup, or when the query is fast and you need the answer now.

```typescript
db.executeSync(sql, params?, options?);
const rows = db.selectSync<MyType>(sql, params?);
const result = db.selectArraySync(sql, params?);
const row = db.getSync<MyType>(sql, params?);
const rowArr = db.getArraySync(sql, params?);
```

They run on the **writer connection** — the same connection the async API writes through, mutually exclusive with it and ordered behind it. A sync call runs inline on the calling thread when the writer is idle, and otherwise waits for whatever is already queued on the writer. There is no second writer, so a sync write and an async write can no longer contend for the file lock and time out against each other.

Two consequences follow directly from sharing one connection:

- a sync read sees an open transaction's **uncommitted** rows, because it is running on the connection that wrote them;
- a sync call issued after a burst of un-awaited `execute()` calls sees **all** of them — the writer is FIFO, so there is nothing to await.

```typescript
db.execute('INSERT INTO users (name) VALUES (?)', ['Alice']); // not awaited
db.execute('INSERT INTO users (name) VALUES (?)', ['Bob']);   // not awaited

db.getSync('SELECT count(*) as n FROM users'); // => { n: 2 }
```

`readOnly` databases follow the same rule, with no special case.

##### `executeSync` during an open transaction

Running on the writer means a sync write issued while a transaction is open would silently become part of that transaction. Rather than let that happen, `executeSync` throws while a transaction opened through `transaction()` or `beginTransaction()` is active — immediately, before it touches SQLite:

> a transaction is active on this database; use the transaction object's executeSync, or pass { joinTransaction: true } to run inside it

It is a `SQLiteError` with code `SQLITE_BUSY` (5), and the message is identical on both platforms.

Only `executeSync` is refused. Sync **reads** stay allowed and see the transaction's uncommitted rows, and a transaction driven entirely by `executeSync('BEGIN') … executeSync('COMMIT')` is not tracked by the plugin and keeps working unchanged.

The asymmetry worth knowing about: plain async `db.execute()` during an open transaction **does** join the transaction, as it always has, and is not refused.

##### Synchronous work inside a transaction

Three sanctioned ways, in order of preference.

**1. The transaction object's own sync methods.** `Transaction` offers `executeSync`, `selectSync`, `selectArraySync`, `getSync` and `getArraySync`; `ReadTransaction` offers the four reads. They run on the connection that owns the transaction, so they never reach the safeguard above.

```typescript
await db.transaction(async (tx) => {
  tx.executeSync('INSERT INTO users (name) VALUES (?)', ['Alice']);
  const { n } = tx.getSync<{ n: number }>('SELECT count(*) as n FROM users');
  await tx.execute('INSERT INTO audit (note) VALUES (?)', [`users: ${n}`]);
});
```

Using a transaction object after it has committed or rolled back throws `SQLITE_MISUSE` (21), sync methods included.

**2. `db.transactionSync(fn)`**, when the whole transaction can be synchronous — see [Synchronous Transactions](#synchronous-transactions).

**3. `executeSync(sql, params?, { joinTransaction: true })`** — the escape hatch, for code that cannot be handed the transaction object. The statement then runs inside whichever transaction is open, which means **it commits or rolls back with that transaction** rather than standing on its own.

```typescript
function applyLegacyMigrationStep(db: SQLiteDatabase) {
  db.executeSync('UPDATE users SET seen = 1', undefined, { joinTransaction: true });
}

await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
  applyLegacyMigrationStep(db); // joins this transaction; rolls back with it
});
```

`params` stays positional, so `executeSync(sql, undefined, { joinTransaction: true })` is the no-parameters form. When no transaction is open the option makes no difference.

#### Lifecycle

```typescript
db.isOpen;              // boolean — true from openDatabase() until close()
await db.initialized(); // resolves when every connection is open; optional
await db.close();       // waits for in-flight operations to finish, then closes all connections
```

`initialized()` and `isOpen` are described under [Opening off the JavaScript thread](#opening-off-the-javascript-thread).

`close()` is async — it waits for all queued operations on the writer and reader queues to drain, rolls back any active write transaction, finalizes prepared statements, and rejects any pending queued transactions. The returned Promise resolves when everything is fully shut down.

### Parameters

Both positional and named parameters are supported.

**Positional parameters** use `?` placeholders:

```typescript
await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['Alice', 30]);
```

**Named parameters** use `:name`, `$name`, or `@name` placeholders and are passed as an object:

```typescript
await db.execute(
  'INSERT INTO users (name, age) VALUES (:name, :age)',
  { name: 'Alice', age: 30 }
);
```

The prefix (`:`, `$`, `@`) is added automatically if omitted — you can pass `{ name: 'Alice' }` instead of `{ ':name': 'Alice' }`.

**Supported value types:**

| JS Type         | SQLite Type                     |
| --------------- | ------------------------------- |
| `string`      | TEXT                            |
| `number`      | INTEGER or REAL (auto-detected) |
| `boolean`     | INTEGER (0 or 1)                |
| `null`        | NULL                            |
| `ArrayBuffer` | BLOB                            |

### Transactions

#### Write Transactions

Write transactions use `BEGIN DEFERRED` by default. They are serialized through a transaction queue — concurrent calls to `transaction()` are safe and will wait their turn automatically.

```typescript
const userId = await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
  const user = await tx.get('SELECT last_insert_rowid() as id');
  await tx.execute('INSERT INTO profiles (user_id, bio) VALUES (?, ?)', [user.id, 'Hello!']);
  return user.id;
});
```

If the callback throws, the transaction is rolled back. If it completes normally, it is committed. The return value of the callback is forwarded to the caller.

If the COMMIT itself fails — a deferred constraint, a full disk — `transaction()` **rejects** with that error and the transaction is rolled back. Earlier versions resolved regardless, so a commit failure was invisible.

While a transaction is open, `db.executeSync` refuses to run: see [`executeSync` during an open transaction](#executesync-during-an-open-transaction) for the three sanctioned ways to do synchronous work inside one.

**Concurrent transactions** are safe — the second transaction waits for the first to finish before starting:

```typescript
// Both run, but writes are serialized via the transaction queue
const [r1, r2] = await Promise.all([
  db.transaction(async (tx) => { /* ... */ }),
  db.transaction(async (tx) => { /* ... */ }),
]);
```

#### Read Transactions

Read transactions claim a dedicated reader connection for the duration of the transaction, providing a consistent snapshot.

```typescript
await db.readTransaction(async (tx) => {
  const users = await tx.select('SELECT * FROM users');
  const count = await tx.get('SELECT count(*) as n FROM orders');
  // Both queries see the same snapshot
});
```

Read transactions do not block the writer or other readers.

> **Platform difference:** a failing COMMIT on a *read* transaction rejects on Android and is silent on iOS. On a write transaction both platforms reject.

#### Nested Transactions (Savepoints)

Use `savepoint()` inside a write transaction:

```typescript
await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);

  try {
    await tx.savepoint(async (sp) => {
      await sp.execute('INSERT INTO users (name) VALUES (?)', ['Bob']);
      throw new Error('changed my mind');
    });
  } catch {
    // Bob's insert is rolled back, Alice's is still pending
  }

  // Transaction commits with only Alice
});
```

#### Synchronous Transactions

`transactionSync(fn)` runs a whole transaction without yielding: BEGIN, the callback, COMMIT — or ROLLBACK and a rethrow if the callback throws. The callback receives a `SyncTransaction`: the five sync methods plus `savepointSync`.

```typescript
const userId = db.transactionSync((tx) => {
  tx.executeSync('INSERT INTO users (name) VALUES (?)', ['Alice']);
  const { id } = tx.getSync<{ id: number }>('SELECT last_insert_rowid() as id');

  tx.savepointSync((sp) => {
    sp.executeSync('INSERT INTO profiles (user_id, bio) VALUES (?, ?)', [id, 'Hello!']);
  });

  return id;
});
```

**The writer is held for the whole callback.** That is what makes the transaction airtight, and it has a consequence worth being explicit about: work already queued on the writer runs *before* the transaction starts, and work dispatched from *inside* the callback — an un-awaited `db.execute()`, say — stays on the queue and runs only once the transaction has committed or rolled back. It is therefore **not** part of the transaction and is not rolled back with it.

```typescript
db.transactionSync((tx) => {
  tx.executeSync('INSERT INTO users (name) VALUES (?)', ['Alice']); // inside

  db.execute('INSERT INTO users (name) VALUES (?)', ['Bob']);       // queued; runs after COMMIT
});
```

The callback must be synchronous. Returning a thenable rolls the transaction back and throws `SQLITE_MISUSE` (21), because the continuation could not have run inside the transaction anyway — an `async` callback here would be quietly wrong, so it is refused instead.

### Prepared Statements

Prepared statements are compiled once and can be executed multiple times with different parameters. They are created on the writer connection.

```typescript
const stmt = await db.prepare('INSERT INTO users (name, age) VALUES (?, ?)');

await stmt.execute(['Alice', 30]);
await stmt.execute(['Bob', 25]);

const rows = await stmt.select(['Alice', 30]); // if it were a SELECT

await stmt.finalize(); // release native resources
```

Prepared statements are automatically finalized when the database is closed, but it is good practice to finalize them explicitly when no longer needed.

### `selectArray` / `getArray` — Columnar Result Format

`selectArray` and `getArray` return column names once and rows as arrays of values. This is more efficient than `select`/`get` for large result sets since column names are not repeated per row.

```typescript
const result = await db.selectArray<[number, string, number]>(
  'SELECT id, name, age FROM users'
);

console.log(result.columns); // ['id', 'name', 'age']
for (const [id, name, age] of result.rows) {
  console.log(id, name, age);
}

// Single row variant
const single = await db.getArray('SELECT id, name FROM users WHERE id = ?', [1]);
// single.columns => ['id', 'name']
// single.rows    => [[1, 'Alice']]  (or [] if no match)
```

Available on all contexts: `db.selectArray()`, `db.getArray()`, `db.selectArraySync()`, `db.getArraySync()`, `tx.selectArray()`, `tx.getArray()`, `tx.selectArraySync()`, `tx.getArraySync()`, `stmt.selectArray()`, `stmt.getArray()`.

### Error Handling

All errors are instances of `SQLiteError`, which extends `Error`:

```typescript
import { SQLiteError, SQLITE_CONSTRAINT } from '@edusperoni/nativescript-sqlite';

try {
  await db.execute('INSERT INTO users (id) VALUES (?)', [1]); // duplicate
} catch (e) {
  if (e instanceof SQLiteError) {
    console.log(e.message);      // human-readable error from sqlite3_errmsg
    console.log(e.code);         // sqlite3 result code (e.g. 19 for CONSTRAINT)
    console.log(e.extendedCode); // extended result code for more detail
  }
}
```

### Low-Level Transaction Control

For driver integrations (e.g., drizzle), the database exposes `txId`-based methods that allow external transaction management:

```typescript
const txId = await db.beginTransaction('deferred'); // 'deferred' | 'immediate' | 'exclusive'
await db.executeInTransaction(txId, 'INSERT INTO users (name) VALUES (?)', ['Alice']);
const rows = await db.selectInTransaction(txId, 'SELECT * FROM users');
await db.commitTransaction(txId);
// or: await db.rollbackTransaction(txId);
```

Each of the three statement methods has a synchronous counterpart that runs on the connection owning the transaction, for drivers that have to produce a result without yielding:

```typescript
db.executeInTransactionSync(txId, sql, params?);
const rows = db.selectInTransactionSync(txId, sql, params?);
const result = db.selectArrayInTransactionSync(txId, sql, params?);
```

A `txId` that is unknown or already finished throws a `SQLiteError` with code `SQLITE_MISUSE` (21). The wording differs between platforms — Android says `invalid transaction id <n>`, iOS says `Invalid transaction ID` — so branch on the code, never the message.

A transaction opened with `beginTransaction()` is tracked like any other, so `db.executeSync` refuses to join it until it is committed or rolled back. See [`executeSync` during an open transaction](#executesync-during-an-open-transaction).

These are used by the drizzle driver to scope each drizzle transaction to its own `txId`, enabling safe concurrent transactions through `Promise.all`.

## Drizzle ORM Integration

A custom drizzle driver is included. It creates a dedicated session per transaction, so concurrent transactions are fully isolated.

```typescript
import { drizzle } from '@edusperoni/nativescript-sqlite/drizzle-driver';
import { openDatabase } from '@edusperoni/nativescript-sqlite';
import * as schema from './schema';

const sqlite = openDatabase({ path: '...' });
const db = drizzle(sqlite, { schema });

// Standard drizzle usage
const users = await db.select().from(schema.users);

// Transactions — concurrent calls are safe
await Promise.all([
  db.transaction(async (tx) => {
    await tx.insert(schema.users).values({ name: 'Alice' });
  }),
  db.transaction(async (tx) => {
    await tx.insert(schema.users).values({ name: 'Bob' });
  }),
]);
```

Requires `drizzle-orm` as a peer dependency (`>=0.45.0`).

## Architecture

### Connection Pool

The plugin opens `1 + poolSize` SQLite connections to the same database file:

- **1 writer connection** — opened with `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE`. All writes (`execute`, write transactions) **and every synchronous method** dispatch to a serial GCD queue, so one of them runs at a time, in the order it was issued.
- **N reader connections** — opened with `SQLITE_OPEN_READWRITE` + `PRAGMA query_only=ON`. Reads (`select`, `get`) are distributed across readers via round-robin, each with its own serial GCD queue. Multiple reads can run concurrently on different readers. Readers open as READWRITE so they can initialize WAL shared memory, but `query_only` prevents accidental writes.
- **Transaction queue** — concurrent `transaction()` calls are queued. The next transaction's `BEGIN` only dispatches after the previous one commits or rolls back.

There is no separate connection behind the `*Sync` methods; they share the writer, which is what gives them their ordering guarantees — see [Sync Methods](#sync-methods).

WAL (Write-Ahead Logging) mode is enabled automatically on the writer. WAL allows readers to proceed without blocking writes, and writes to proceed without blocking readers.

The queue descriptions above are iOS terminology. Android has the same structure — one writer, `poolSize` readers, a transaction queue — built on a native thread pool instead of GCD. Both platforms open each reader on the thread that serves it, and open the writer inside `openDatabase()` unless [`asyncOpen`](#opening-off-the-javascript-thread) moves it off too. With an `encryptionKey` that matters, because every connection is keyed — see [The cost of a passphrase](#the-cost-of-a-passphrase).

### Performance

- All SQLite work (prepare, bind, step, column extraction) happens on background threads.
- Results are serialized to a JSON string on the background thread. Only one value (the string) crosses the native-to-JS bridge. `JSON.parse` in V8 is highly optimized native C++ code.
- Blob columns are returned separately (iOS: `NSData`→`ArrayBuffer` via `interop.bufferFromData`; Android: `byte[]`→`ArrayBuffer` by direct copy) and re-inserted into the parsed objects before the Promise resolves.
- The `selectArray` / `getArray` format avoids repeating column names per row, reducing both serialization cost and memory usage for large result sets.
- Named parameters (`:name`, `$name`, `@name`) are bound natively on both platforms via `sqlite3_bind_parameter_index`. The prefix is added automatically if omitted — pass `{ name: 'Alice' }` and the binding adds the `:` before looking up the parameter index.

## iOS SQLite Linking

The plugin does **not** bundle or link a SQLite library on iOS — you must provide one. This gives you full control over the SQLite version and features available. Add **one** of the following to your app:

### Option A: System SQLite (simplest)

Link the SQLite that ships with iOS. Add to `App_Resources/iOS/build.xcconfig`:

```
OTHER_LDFLAGS = $(inherited) -lsqlite3
```

This is the simplest setup. The system SQLite does not support encryption or some newer extensions (e.g., recovery).

### Option B: Custom SQLite via CocoaPods

Use a custom SQLite build with specific compile-time options (FTS5, recovery, etc.). Add to `App_Resources/iOS/Podfile`:

```ruby
pod 'sqlite3', '~> 3.46.0'
```

Or use your own podspec pointing to a custom SQLite build. The pod's sqlite3 symbols replace the system ones at link time. No plugin code changes needed.

### Option C: SQLCipher (encryption)

Use SQLCipher for transparent AES-256 database encryption. Add to `App_Resources/iOS/Podfile`:

```ruby
pod 'SQLCipher', '~> 4.6'
```

Then pass an encryption key when opening the database:

```typescript
const db = openDatabase({
  path: knownFolders.documents().path + '/encrypted.sqlite',
  encryptionKey: 'my-secret-key',
});
```

Every connection (the writer and each reader) automatically receives the key via `PRAGMA key` after opening. If the key is wrong or missing for an encrypted database, operations will fail with `SQLITE_NOTADB`.

#### Passphrase vs raw key

The string above is a passphrase: SQLCipher stretches it with PBKDF2 (256,000 iterations by default) **once per connection**, so `poolSize: 4` pays that cost five times. [The cost of a passphrase](#the-cost-of-a-passphrase) has the measurements and says which of those five land on the JavaScript thread.

If your key is already full-entropy random bytes, ask for the raw form instead and skip derivation entirely:

```typescript
const db = openDatabase({
  path: knownFolders.documents().path + '/encrypted.sqlite',
  encryptionKey: hexKey, // 64 hex digits = the 32-byte key; 96 supplies the salt too
  encryptionKeyFormat: 'raw',
});
```

The two are equally strong for a random key — PBKDF2 exists to stretch low-entropy secrets, and there is nothing to stretch. For a human-chosen passphrase, that derivation is exactly what makes offline guessing expensive, so keep the default.

They are, however, **different keys**: a database must be opened with the same form it was created with.

`encryptionKeyFormat` is explicit rather than inferred because SQLCipher switches to raw-key material on its own for any key shaped like `x'<64 hex>'`. Leaving that to the shape of a string means one key silently becoming another, so a raw-looking key passed without the option is rejected with an error instead.

The same two options mean the same thing on Android — see [`sqlite3mc` (encryption)](#sqlite3mc-encryption) for the Android engine that reads and writes the same files, and [The cost of a passphrase](#the-cost-of-a-passphrase) for what that per-connection derivation actually costs, measured. Whatever engine you end up on, read [Encryption Caveats](#encryption-caveats): a missing codec is silent on every engine the plugin did not compile itself, which is all of them on iOS.

## Android SQLite Setup

On Android the plugin **compiles SQLite itself**, as part of its own native build. The SQLite inside Android is not an NDK API and cannot be linked, so the question is not which library to link — as it is on iOS — but which sources to compile. Out of the box that is the upstream SQLite amalgamation and there is nothing for you to configure.

The rest of this section is about changing that: turning on encryption, adding compile flags, or handing the plugin a SQLite you built yourself. The app-provided directory is the Android counterpart of picking a pod in [iOS SQLite Linking](#ios-sqlite-linking) — the same single hook, expressed in CMake instead of a Podfile.

### Requirements

- **`@nativescript/android` 9.1 or newer** for the default Node-API backend. Older runtimes need `nscsqlite.backend=v8`; see [Backends](#backends).
- **NDK and CMake** — both come with the Android toolchain NativeScript already installs and configures. Nothing extra to install.
- **Network access on the first build.** The SQLite amalgamation is downloaded rather than vendored, pinned by URL and SHA-256 in `platforms/android/native/downloads.properties` and verified before anything is extracted. It is cached under `<gradle user home>/nscsqlite` — `~/.gradle/nscsqlite` unless you moved `GRADLE_USER_HOME` — and reused by every later build and every project on the machine. To build with no network at all, see [Offline and CI builds](#offline-and-ci-builds).

Compiling SQLite costs a few seconds per ABI on a clean build. Incremental builds do not recompile it.

### Choosing the SQLite build

Two presets are built in. Both are compiled from a downloaded amalgamation; neither adds a dependency to your APK beyond the plugin's own `libnscsqlite.so`.

#### `bundled` (default)

The upstream SQLite amalgamation, with FTS5 enabled. This is what you get if you set nothing.

**It cannot encrypt, and it refuses to pretend otherwise.** Upstream SQLite has no codec, so `PRAGMA key` on it returns `SQLITE_OK` and writes the database in plaintext — measured on a device, the file header was literally `SQLite format 3`, and it then opened with the wrong key and with no key at all. Rather than let that happen quietly, the preset publishes a compile definition (`NSCSQLITE_ENGINE_HAS_NO_CODEC`), and passing an `encryptionKey` to `openDatabase()` on such a build throws before opening anything:

> this build uses the bundled SQLite, which cannot encrypt; select `nscsqlite.sqlite=sqlite3mc` or provide your own SQLite

This is the one case the plugin *can* detect, because it compiled the engine itself. It does not generalise — see [What the plugin deliberately does not check](#what-the-plugin-deliberately-does-not-check).

#### `sqlite3mc` (encryption)

[SQLite3MultipleCiphers](https://github.com/utelle/SQLite3MultipleCiphers) — the answer to "I need encrypted databases on Android".

```properties
# App_Resources/Android/gradle.properties
nscsqlite.sqlite=sqlite3mc
```

```typescript
const db = openDatabase({
  path: knownFolders.documents().path + '/encrypted.sqlite',
  encryptionKey: 'my-secret-key',
});
```

What you should know about it:

- **It produces SQLCipher 4 files.** The preset is compiled with `CODEC_TYPE=CODEC_TYPE_SQLCIPHER` and `SQLITE3MC_USE_SQLCIPHER_LEGACY`, which makes a plain `PRAGMA key` read and write SQLCipher 4 databases. A database created here opens under `pod 'SQLCipher'` on iOS and vice versa, with passphrases and with raw keys, so one encrypted file can be shared across both platforms of the same app. This was verified against SQLCipher 4.16.0 at its default settings, on a host build, covering ordinary tables, FTS5 and non-ASCII text; SQLCipher's non-default cipher settings and WAL mode were not part of that test.
- **It brings its own crypto.** No OpenSSL, no Prefab dependency, no extra `.so` in the APK. Hardware AES on arm64 is detected at run time, with no compiler flags — forcing `-maes`-style flags actually breaks armeabi-v7a.
- **Passphrase or raw key** work exactly as on iOS, through `encryptionKeyFormat`. See [Passphrase vs raw key](#passphrase-vs-raw-key) — that section applies verbatim here.
- **Key derivation is paid per connection.** The writer's is paid by `openDatabase()`; the readers' are paid on their own threads. See [The cost of a passphrase](#the-cost-of-a-passphrase) below — it is the single most important thing to know before shipping this.
- **SQLCipher's own pragmas do not exist here.** `cipher_version`, `cipher_migrate`, `cipher_compatibility`, `sqlcipher_export` and the rest are not implemented by SQLite3MC and are **silently ignored** — SQLite ignores an unknown pragma rather than failing. Code that branches on `PRAGMA cipher_version`, migrates legacy databases with `cipher_migrate`, or exports with `sqlcipher_export()` will not do what it did on iOS. Those apps want real SQLCipher through the app-provided directory: see [SQLCipher with LibTomCrypt](docs/android-custom-sqlite/sqlcipher-libtomcrypt).
- **You can confirm at run time that you really got this preset.** `SELECT sqlite3mc_version()` returns `SQLite3 Multiple Ciphers <version>`, and `PRAGMA cipher` returns `sqlcipher` — the SQLCipher-legacy setting above, read back from the live engine. [Encryption Caveats](#the-engine-specific-assertion) turns the first of those into a one-line `onOpen` assertion that fails the open on any other engine, which is worth having if a mis-set Gradle property would otherwise drop you onto `bundled`.

#### The cost of a passphrase

A passphrase is stretched with PBKDF2-HMAC-SHA512 at 256,000 iterations, **once per `PRAGMA key`** — roughly 90 ms per connection — and every connection is keyed. At the default `poolSize: 4` that is five derivations: one writer, four readers.

What matters is *where* they run. Readers are opened by their own threads, so only the writer's derivation lands on the JavaScript thread — and `asyncOpen: true` moves that one off as well.

Measured on an emulator with the `sqlite3mc` preset in SQLCipher-legacy mode, `poolSize: 4`:

| | before this change | now |
|---|---|---|
| `openDatabase()` with a passphrase (JS thread blocked) | ≈ 582 ms | **93 ms** |
| first pooled read afterwards | — | ≈ 92 ms |
| `openDatabase()` with a raw key | 0.66 ms | **0.67 ms** |
| `openDatabase()` with no key | ≈ 2.5 ms | ≈ 3.4 ms |

Read that honestly: the derivations did not get faster, they moved. The JavaScript thread now pays **one** instead of six — the four readers derive on their own threads, and the sixth connection, the old dedicated sync one, no longer exists. The readers' cost has not vanished; it reappears as ≈ 92 ms of latency on the **first read routed to each reader**, once per reader. Trading a frozen UI for a slow first query is almost always the right trade, but it is a trade.

These are emulator numbers, not device numbers; treat the shape as real and the absolute values as indicative.

**A raw key does not reduce that cost — it removes it.** With no PBKDF2 to run, a keyed open is as cheap as an unkeyed one, on the writer and on every reader alike. If your key is already full-entropy random bytes, this is the whole problem solved, and it is the first thing to reach for:

- **`encryptionKeyFormat: 'raw'` with a 64-hex key.** There is nothing to stretch in a random key, so the two forms are equally strong for one, and interoperability with official SQLCipher was verified in both directions with raw keys. This is *not* a shortcut for a human-chosen passphrase, where the derivation is exactly what makes guessing expensive — see [Passphrase vs raw key](#passphrase-vs-raw-key).

If you must stretch a passphrase, three things reduce what it costs you:

- **[`asyncOpen: true`](#opening-off-the-javascript-thread)** — the writer opens on a background thread too, so no derivation at all runs on the JavaScript thread. `openDatabase()` then cannot report an open failure; `initialized()` does.
- **A smaller `poolSize`** — each reader you drop is one derivation you do not pay and one first-read stall you do not take.
- **`serialized: true`** — one connection handles everything, so one derivation. Reads no longer run concurrently with writes; for a small database that is often a fair trade.

#### Adding compile flags

`nscsqlite.sqliteFlags` takes `;`-separated compile definitions and is **additive** on top of the selected preset's defaults:

```properties
nscsqlite.sqliteFlags=SQLITE_ENABLE_RTREE;SQLITE_DQS=0;SQLITE_MAX_EXPR_DEPTH=0
```

| preset | defaults (overridable) | required (fixed) |
|---|---|---|
| `bundled` | `SQLITE_ENABLE_FTS5` | `SQLITE_THREADSAFE=2` |
| `sqlite3mc` | `SQLITE_ENABLE_FTS5`, `CODEC_TYPE=CODEC_TYPE_SQLCIPHER`, `SQLITE3MC_USE_SQLCIPHER_LEGACY` | `SQLITE_THREADSAFE=2`, `SQLITE_TEMP_STORE=2` |

Your flags are appended after the defaults and before the required set, and the last definition of a macro name wins. So you can change a default's **value** — your own `CODEC_TYPE=…` replaces the preset's, moving `sqlite3mc` onto one of its other ciphers (its documentation lists them, and doing so gives up the SQLCipher file compatibility above). You cannot remove a default, and you cannot change the required set. If you need to do either, use the [app-provided directory](#bringing-your-own-sqlite), where the whole define list is yours.

#### Where the properties go

**`App_Resources/Android/gradle.properties` is the place for app configuration.** It is checked in with the app, it applies to every build, and it is the only route that takes more than one setting reliably:

```properties
nscsqlite.sqlite=sqlite3mc
nscsqlite.sqliteFlags=SQLITE_ENABLE_RTREE;SQLITE_DQS=0
```

**For CI and scripting, use the environment variables.** Every property has one:

```bash
NSCSQLITE_SQLITE=sqlite3mc NSCSQLITE_SQLITE_FLAGS='SQLITE_ENABLE_RTREE' ns build android
```

Precedence is **`-P` property → environment variable → default**, so an environment variable overrides the built-in default but not something the app or the command line states explicitly.

> **`--gradleArgs` carries exactly one property.** The NativeScript CLI does not split it: `--gradleArgs=-Pa=1 -Pb=2` reaches Gradle as a single property `a` whose value is the string `1 -Pb=2`, and the second setting is lost without a warning. The `=` after `--gradleArgs` is also mandatory — the space-separated form `--gradleArgs -Pnscsqlite.sqlite=sqlite3mc` is dropped entirely.
>
> So `-P` is fine for exactly one override and nothing else:
>
> ```bash
> ns build android --gradleArgs=-Pnscsqlite.sqlite=sqlite3mc
> ```
>
> For anything more, use `gradle.properties` or the environment variables. The environment is also the only route for a scripted build, because Gradle refuses `-P` property names containing a dot when they arrive that way — which is why these variables exist at all.

Whichever route you take, the build log line beginning `nscsqlite: backend=… sqlite=…` reports what was actually selected.

#### All properties

| property | environment variable | values | default | meaning |
|---|---|---|---|---|
| `nscsqlite.backend` | `NSCSQLITE_BACKEND` | `napi` \| `v8` | `napi` | Which JS binding the native library is built against. |
| `nscsqlite.sqlite` | `NSCSQLITE_SQLITE` | `bundled` \| `sqlite3mc` | `bundled` | Which built-in preset to compile. `nscsqlite.sqliteImpl` is accepted as an alias for backwards compatibility. |
| `nscsqlite.sqliteProjectDir` | `NSCSQLITE_SQLITE_PROJECT_DIR` | path | — | An app-provided CMake directory. Absolute paths are used as-is; a relative path resolves against the app root (the directory holding the app's `package.json`). |
| `nscsqlite.sqliteFlags` | `NSCSQLITE_SQLITE_FLAGS` | `;`-separated defines | — | Extra compile definitions, additive on top of the preset's defaults. |
| `nscsqlite.sqliteSourceDir` | `NSCSQLITE_SQLITE_SOURCE_DIR` | path | — | A directory holding an already-extracted amalgamation for the selected preset; skips the download. |
| `nscsqlite.v8IncludeDir` | `NSCSQLITE_V8_INCLUDE_DIR` | path | — | Pre-extracted V8 headers; skips that download. Only relevant to the `v8` backend. |
| `nscsqlite.cacheDir` | `NSCSQLITE_CACHE_DIR` | path | `<gradle user home>/nscsqlite` | Download cache root. |

### Bringing your own SQLite

The presets cover the common cases. When they do not — real SQLCipher, a custom VFS, a statically linked extension, an engine shared with your own native code, a prebuilt `.so` — the app supplies a CMake directory and the plugin builds against whatever comes out of it.

#### Where the directory goes

By convention:

```
App_Resources/Android/nscsqlite/CMakeLists.txt
```

If that file exists it is used, with no property to set. `nscsqlite.sqliteProjectDir` points somewhere else instead — a shared directory in a monorepo, for instance, so the same sources can back the iOS podspec and the Android build.

The directory is deliberately **not** under `App_Resources/Android/src/`. The NativeScript CLI copies everything under `src/` into the generated Gradle project on every prepare; a ~9 MB amalgamation would be duplicated each time, and fresh timestamps on the copies would make ninja recompile SQLite on every build. A top-level directory in `App_Resources/Android/` is read in place and never copied.

An app-provided directory replaces the preset entirely — nothing is downloaded, and none of the preset's compile definitions apply. Configuring both a directory and an explicit `nscsqlite.sqlite` is an error naming them both, rather than a silent preference for one.

#### The contract

Your `CMakeLists.txt` must define **one target named `nscsqlite_sqlite`** — `STATIC`, `SHARED` or `IMPORTED`. Everything the plugin needs travels on that target:

- a **PUBLIC** include directory containing a usable `sqlite3.h`. PUBLIC because the plugin's own translation units do `#include <sqlite3.h>` and resolve it through your target;
- its compile definitions, **PUBLIC** for anything that changes what `sqlite3.h` declares. `SQLITE_HAS_CODEC` is the one that catches people out: it gates the `sqlite3_key()` declarations, so as PRIVATE it would compile your engine correctly and hide the API from the plugin;
- its link dependencies as **PUBLIC**, so they propagate onto the plugin's link line.

That is the entire interface. The plugin `add_subdirectory()`s your directory and links that one target; it knows nothing else about SQLite.

Both built-in presets are implemented as instances of this same contract, which makes them the shortest reference examples there are:

- [`platforms/android/native/sqlite/bundled/CMakeLists.txt`](platforms/android/native/sqlite/bundled/CMakeLists.txt)
- [`platforms/android/native/sqlite/sqlite3mc/CMakeLists.txt`](platforms/android/native/sqlite/sqlite3mc/CMakeLists.txt)

#### What the plugin checks

- **At compile time:** that the `sqlite3.h` you supplied reports `SQLITE_VERSION_NUMBER >= 3009000`. SQLite 3.9.0 is the FTS5 floor. An older header fails with an `#error` naming the requirement.
- **At link time, implicitly:** the plugin links with `--no-undefined`, so any API it calls that your engine does not provide is a build error naming the missing symbol. It needs about 33 functions — open/close/exec, prepare/step/reset/finalize, the bind and column families, changes/rowid, `sqlite3_libversion`, `sqlite3_sourceid`. `sqlite3_key` is **not** among them: keys are applied with `PRAGMA key`, so an engine that answers that pragma some other way works fine. `sqlite3_compileoption_get` is called only under `#ifndef SQLITE_OMIT_COMPILEOPTION_DIAGS`.
- **At the first open:** that `sqlite3_threadsafe() != 0`.

#### What the plugin deliberately does not check

**Whether encryption is actually available.** There is no correct test for it in the general case.

"Refuse if `sqlite3_key` is missing" rejects working setups: an engine can answer `PRAGMA key` from a custom VFS that does its own encryption and exports no codec symbols at all. `PRAGMA cipher_version` is SQLCipher-specific — SQLite3MC does not implement it, and neither does such a VFS. Anything the plugin could check would be a guess about which engine you chose, which is exactly the decision it just handed to you.

The one exception is the `bundled` preset, where the plugin compiled the engine itself and therefore *knows* there is no codec; a keyed open on that build is refused. That knowledge does not extend to an engine you supplied. So for an app-provided directory the plugin applies the key and gets out of the way, and asserting that a codec is present is your job — [Encryption Caveats](#encryption-caveats) gives you an engine-independent probe and an `onOpen` assertion.

#### Link hygiene applied to every configuration

Whichever engine you end up with, the plugin links its own library with:

- `-Wl,--exclude-libs,ALL`, which hides the symbols of every static library linked into it. `libnscsqlite.so` therefore exports no `sqlite3_*` symbols: nothing else in the process can bind to the plugin's SQLite, and it cannot collide with another one. This is the Android counterpart of the iOS trap where another dependency's `-lsqlite3` quietly redirects the plugin to a different engine, and it works without the app having to remember `-fvisibility=hidden`.
- `-Wl,-z,max-page-size=16384`, for the 16 KB page alignment Google Play requires of apps targeting API 35+.

Both apply to `libnscsqlite.so` itself, which covers a `STATIC` engine completely. A `SHARED` or `IMPORTED` engine is a separate file with its own dynamic symbol table and its own alignment, and the plugin cannot re-link it — see the notes in those two examples.

#### Worked examples

Five complete `CMakeLists.txt` files, each with a page on what it does and what it costs, live in [`docs/android-custom-sqlite/`](docs/android-custom-sqlite):

| example | what it is for |
|---|---|
| [upstream amalgamation with custom flags](docs/android-custom-sqlite/upstream-amalgamation) | The plainest instance of the contract. Start here to see the shape. |
| [SQLCipher with LibTomCrypt](docs/android-custom-sqlite/sqlcipher-libtomcrypt) | Real SQLCipher — its pragmas, its migrations — statically linked, no OpenSSL, no Prefab. |
| [a prebuilt `.so` as an IMPORTED target](docs/android-custom-sqlite/prebuilt-imported) | Link a library someone else compiled — and take on what the plugin can no longer do for you. |
| [a SHARED engine shared with other native code](docs/android-custom-sqlite/shared-engine) | One SQLite in the process instead of a private static copy. |
| [a custom VFS, init hook, or statically linked extension](docs/android-custom-sqlite/extension-init-hook) | The `SQLITE_EXTRA_INIT` chaining-shim pattern. |

One thing to know before reaching for the last one: the plugin does **not** expose a raw `SQLITE_EXTRA_INIT` pass-through for the built-in presets, and that is on purpose. SQLCipher's guard is `#if !defined(SQLITE_EXTRA_INIT)` — it tests that the macro *exists*, not what it names — so a user-supplied value silently displaces `sqlcipher_extra_init`, the build succeeds, and the crypto provider is never registered. Statically linked extensions for the built-in presets are out of scope for this release; they go through the app-provided directory.

### Backends

The plugin's native library binds to the JavaScript engine through one of two backends. **Both expose an identical JavaScript API** — nothing in the rest of this README changes between them.

**`napi` (default).** Binds through Node-API. It needs no V8 headers and downloads none, and it is insulated from V8 changes inside the runtime. Requires `@nativescript/android` 9.1 or newer.

**`v8`.** Binds through the raw V8 C++ API, kept as a reference and benchmark implementation. It compiles against V8's public headers, which the build downloads and pins to match the runtime's V8 (`platforms/android/native/downloads.properties`). Because it reaches into V8 directly, **it is tied to the V8 version inside `@nativescript/android` and has to be rebuilt when that changes**; a mismatch is not a build error.

```properties
nscsqlite.backend=v8
```

### Offline and CI builds

The build downloads two things: the SQLite amalgamation for the selected preset, and — on the `v8` backend only — the V8 public headers. Both are pinned by URL and SHA-256 and cached; a machine that has built once needs no network again.

To move the cache:

```properties
nscsqlite.cacheDir=/var/cache/nscsqlite
```

Point it at a directory your CI restores between runs and the downloads happen once, ever.

To skip the downloads entirely — an air-gapped builder, or a vendored copy under version control — supply the extracted trees:

```properties
# A directory holding the already-extracted amalgamation for the selected preset
nscsqlite.sqliteSourceDir=/opt/vendor/sqlite-amalgamation-3530100
# Only needed on the v8 backend
nscsqlite.v8IncludeDir=/opt/vendor/v8/include
```

`nscsqlite.sqliteSourceDir` must match the preset you selected: the `bundled` preset expects an upstream amalgamation, `sqlite3mc` expects a SQLite3MultipleCiphers one. The pinned URLs and checksums are in `platforms/android/native/downloads.properties` if you want to fetch and verify them yourself.

An [app-provided directory](#bringing-your-own-sqlite) needs no SQLite download at all — your sources are already on disk. On the `v8` backend the V8 headers are still fetched.

### Troubleshooting

**`undefined reference to 'sqlite3_…'` when linking `libnscsqlite.so`**

The engine you supplied does not provide an API the plugin calls. The plugin links with `--no-undefined` precisely so this is a build failure rather than a crash in the field, and the error names the symbol.

- `sqlite3_compileoption_get` — your build has `SQLITE_OMIT_COMPILEOPTION_DIAGS`. The plugin guards that call, so if you still see it, the define did not reach the plugin's own translation units: make it PUBLIC on your target.
- Anything else — you have an `SQLITE_OMIT_*` that removes an API the plugin needs, or a prebuilt library that never had it. Drop the define, or pick a different engine. There is no runtime fallback.

**`nscsqlite.sqlite=sqlcipher` or `nscsqlite.sqlite=custom` fails the build**

Both values are retired and the build says so rather than quietly doing something else.

- `sqlcipher` → use `sqlite3mc`, which writes the same SQLCipher 4 files and needs no OpenSSL. If you need SQLCipher itself, use the [app-provided directory](#bringing-your-own-sqlite) and the [LibTomCrypt example](docs/android-custom-sqlite/sqlcipher-libtomcrypt).
- `custom` → use the app-provided directory with an `IMPORTED` target: the [prebuilt example](docs/android-custom-sqlite/prebuilt-imported). The old `nscsqlite.sqliteIncludeDir`, `nscsqlite.sqliteLibDir` and `nscsqlite.sqliteLibName` properties are gone with it; `find_library` could never see the app's directory under the NDK toolchain, so that mode did not actually work.

**`openDatabase` fails with "the linked SQLite was built with SQLITE_THREADSAFE=0"**

Checked at the first open, because a single-threaded SQLite cannot back a connection pool. Rebuild your engine with `SQLITE_THREADSAFE=2`; both presets already set it and it is not overridable there.

**The app crashes or misbehaves on the `v8` backend after a runtime upgrade**

The `v8` backend compiles against V8's public headers and must match the V8 inside `@nativescript/android`. Nothing checks this at build time. Clear the header cache under `<gradle user home>/nscsqlite`, rebuild, and if the mismatch persists switch to the default `napi` backend, which is not exposed to V8's internals.

**`openDatabase()` throws "this build uses the bundled SQLite, which cannot encrypt"**

You passed an `encryptionKey` to a build using the `bundled` preset, which has no codec. The plugin refuses (with `SQLITE_MISUSE`) rather than writing a plaintext database. Set `nscsqlite.sqlite=sqlite3mc`, or supply an engine that encrypts. If you thought you had already set the property, check the build log line `nscsqlite: backend=… sqlite=…` and the entry below.

**`openDatabase()` throws `SQLITE_NOTADB` (code 26) on an existing database**

The key is wrong, or the file is encrypted and you passed no key — or the reverse, a plaintext file opened with a key on an engine that has a codec. The failure now surfaces at open rather than at the first query, so the code and message come from the connection that failed.

**`PRAGMA key` succeeds but the database is not encrypted**

Possible on any engine the plugin did not compile itself — the `sqlite3mc` preset aside, that means an app-provided directory on Android and every configuration on iOS. See [Encryption Caveats](#encryption-caveats) for how to prove it one way or the other.

**A property passed on the command line had no effect**

`--gradleArgs` carries exactly one property, and only with the `=` form. `--gradleArgs=-Pa=1 -Pb=2` reaches Gradle as one property `a` with the value `1 -Pb=2`; `--gradleArgs -Pa=1` is dropped entirely. Put app configuration in `App_Resources/Android/gradle.properties`, or use the `NSCSQLITE_*` environment variables for scripted builds. The build log line beginning `nscsqlite: backend=… sqlite=…` tells you what was actually selected.

## Encryption Caveats

**`PRAGMA key` against an engine with no codec returns `SQLITE_OK` and the database is written in plaintext.** This is a property of SQLite itself — an unrecognised pragma is not an error — and it holds on both platforms. Pass an `encryptionKey` to a codec-less engine and everything works: no error, no warning, and a file whose header reads `SQLite format 3`, openable with the wrong key or with none.

### What the plugin catches for you

Exactly one case: **Android's `bundled` preset**. The plugin compiled that engine, so it knows there is no codec in it, and a keyed `openDatabase()` on such a build throws instead of writing plaintext.

That is the limit of what it can know. For the `sqlite3mc` preset, for any engine you supply through the app-provided directory, and for **every iOS configuration** — where the SQLite comes from your Podfile and the plugin never sees how it was built — it cannot tell a missing codec from one living inside a custom VFS. Refusing on a missing `sqlite3_key` symbol would reject working setups; `PRAGMA cipher_version` is SQLCipher-specific. See [What the plugin deliberately does not check](#what-the-plugin-deliberately-does-not-check).

**So: if you bring your own engine, asserting that it actually encrypts is your job.** Two ways to do it.

### The engine-independent proof

Create a throwaway database with a key, close it, and reopen it **without** the key. If that succeeds, there is no encryption. This works on any engine — a codec, a VFS that encrypts itself, or nothing at all — because it tests the file rather than the API:

```typescript
import { openDatabase } from '@edusperoni/nativescript-sqlite';
import { File, knownFolders } from '@nativescript/core';

async function encryptionWorks(): Promise<boolean> {
  const path = knownFolders.documents().path + '/_codec_probe.db';
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (File.exists(path + suffix)) File.fromPath(path + suffix).remove();
    }
  };
  cleanup();

  try {
    const keyed = openDatabase({ path, encryptionKey: 'probe-key', poolSize: 1 });
    try {
      await keyed.execute('CREATE TABLE probe (x INTEGER)');
    } finally {
      await keyed.close();
    }
  } catch {
    cleanup();
    return false; // the keyed open itself was rejected
  }

  let plain;
  try {
    plain = openDatabase({ path, poolSize: 1 });
    await plain.select('SELECT x FROM probe');
    return false; // readable without the key — plaintext
  } catch {
    return true;
  } finally {
    if (plain) await plain.close().catch(() => undefined);
    cleanup();
  }
}
```

This is what the plugin's own demo test suite uses to decide whether to run its encryption tests (`tools/demo/nativescript-sqlite/test-suite/index.ts`). Note the cost: it performs a keyed open, which on a passphrase is not free — see [The cost of a passphrase](#the-cost-of-a-passphrase). Run it once, at first launch or in a debug build, and cache the answer; do not run it on every start.

### The engine-specific assertion

`onOpen` runs on every connection immediately after `PRAGMA key` and before any query, and a statement that fails there aborts the open with its SQLite error. That makes it the right place for a cheap, permanent assertion — **but the statement has to be written for one specific engine.**

```typescript
// REAL SQLCIPHER ONLY — pod 'SQLCipher' on iOS, or the LibTomCrypt example on
// Android. This would FAIL on the sqlite3mc preset, which encrypts perfectly
// well and simply has no sqlcipher_export.
//
// Resolving sqlcipher_export is a prepare-time error on any other engine; the
// CASE means it is never actually called.
const db = openDatabase({
  path: dbPath,
  encryptionKey: key,
  onOpen: ["SELECT CASE WHEN 0 THEN sqlcipher_export('main') END"],
});
```

The `sqlite3mc` preset has its own, built the same way — and it is the mirror image, not a substitute:

```typescript
// SQLITE3MC PRESET ONLY — this would FAIL on real SQLCipher, which has no
// sqlite3mc_version(). Resolving the function name is a prepare-time error on
// any other engine; the CASE means it is never actually called.
const db = openDatabase({
  path: dbPath,
  encryptionKey: key,
  onOpen: ['SELECT CASE WHEN 0 THEN sqlite3mc_version() END'],
});
```

There is still no engine-independent version, because each engine exposes something different:

| engine | what it answers to | what it ignores |
|---|---|---|
| SQLCipher | `PRAGMA cipher_version`, `PRAGMA cipher_migrate`, the `sqlcipher_export()` SQL function | `sqlite3mc_version()` |
| `sqlite3mc` preset | `PRAGMA cipher` (returns `sqlcipher`), `PRAGMA legacy`, the `sqlite3mc_version()` SQL function | every `cipher_*` pragma above, silently |
| a custom VFS with its own crypto | whatever that VFS defines | both of the above |
| plain SQLite | nothing at all | both of the above — and `PRAGMA key` still returns OK |

A pragma alone cannot carry either assertion: SQLite ignores an unknown one rather than failing, so `PRAGMA cipher_version` on plain SQLite returns no rows and `onOpen` sees a statement that ran fine. That is why both examples reference a **function** instead — a name the wrong engine cannot resolve is a prepare-time error, and `onOpen` turns it into a failed open.

**These assertions prove which engine is linked, not that a given database is encrypted.** `sqlite3mc_version()` resolving tells you the `sqlite3mc` preset really was compiled in — which is exactly the failure mode worth guarding, since a Gradle property you thought you set and did not is how you end up on `bundled`. It says nothing about the file on disk. Only [the probe above](#the-engine-independent-proof) does that.

### Wrong keys are loud

None of the above is about a *wrong* key. That case is reported clearly on both platforms, and reported **at `openDatabase()`** — the first statement the plugin runs after keying touches the database, so the open fails with the SQLite error (`SQLITE_NOTADB`, code 26) rather than letting a broken handle through to your first query.

It is only the *absent codec* that is silent, and only on an engine the plugin did not build.

## Type Definitions

```typescript
type SQLiteValue = string | number | boolean | null | ArrayBuffer;
type SQLiteParams = SQLiteValue[] | Record<string, SQLiteValue>;
type SQLiteRow = Record<string, SQLiteValue>;

interface SQLiteArrayResult<T extends SQLiteValue[] = SQLiteValue[]> {
  columns: string[];
  rows: T[];
}

interface DatabaseOptions {
  path: string;
  readOnly?: boolean;
  poolSize?: number;
  busyTimeout?: number;
  encryptionKey?: string;
  encryptionKeyFormat?: 'passphrase' | 'raw';
  onOpen?: string[];
  serialized?: boolean;
  asyncOpen?: boolean;
}

interface ExecuteSyncOptions {
  joinTransaction?: boolean;
}
```

## License

Apache License Version 2.0
