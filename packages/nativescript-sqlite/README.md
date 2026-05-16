# @edusperoni/nativescript-sqlite

A high-performance SQLite plugin for NativeScript. All database operations run on background threads via GCD — the JavaScript thread is never blocked.

**Platform support:** iOS (Android planned)

## Features

- Fully asynchronous — all queries dispatch to native background threads
- Connection pool with WAL mode — concurrent reads, serialized writes
- Transaction queue — concurrent `transaction()` calls are safe, they wait their turn
- Write and read transactions with savepoint (nested transaction) support
- Prepared statements
- Two result formats: objects (`select`) or columnar arrays (`selectArray`)
- Synchronous API available for simple use cases (migrations, setup)
- Custom SQLite builds supported via CocoaPods
- Drizzle ORM driver included

## Installation

```bash
npm install @edusperoni/nativescript-sqlite
```

The plugin does not bundle SQLite — you must link one. For most apps, add to `App_Resources/iOS/build.xcconfig`:

```
OTHER_LDFLAGS = $(inherited) -lsqlite3
```

For other options (custom builds, SQLCipher encryption), see [SQLite Linking](#sqlite-linking).

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

Opens a database and returns a `SQLiteDatabase` instance. The connection pool is created immediately.

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
| `poolSize` | `number` | `4` | Number of reader connections in the pool |
| `busyTimeout` | `number` | `5000` | Busy timeout in milliseconds |

### SQLiteDatabase

#### Async Methods

All async methods dispatch work to background threads and return Promises. Reads use reader connections from the pool; writes use the dedicated writer connection.

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

Synchronous methods block the JavaScript thread. They use a dedicated connection separate from the async pool. Use these for migrations, app setup, or when you need the result immediately and the query is fast.

```typescript
db.executeSync(sql, params?);
const rows = db.selectSync<MyType>(sql, params?);
const result = db.selectArraySync(sql, params?);
const row = db.getSync<MyType>(sql, params?);
const rowArr = db.getArraySync(sql, params?);
```

#### Lifecycle

```typescript
db.isOpen;        // boolean
await db.close(); // waits for in-flight operations to finish, then closes all connections
```

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

| JS Type | SQLite Type |
|---------|-------------|
| `string` | TEXT |
| `number` | INTEGER or REAL (auto-detected) |
| `boolean` | INTEGER (0 or 1) |
| `null` | NULL |
| `ArrayBuffer` | BLOB |

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

Available on all contexts: `db.selectArray()`, `db.getArray()`, `db.selectArraySync()`, `db.getArraySync()`, `tx.selectArray()`, `tx.getArray()`, `stmt.selectArray()`, `stmt.getArray()`.

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

The plugin opens multiple SQLite connections to the same database file:

- **1 writer connection** — opened with `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE`. All writes (`execute`, write transactions) dispatch to a serial GCD queue, ensuring only one write happens at a time.
- **N reader connections** — opened with `SQLITE_OPEN_READWRITE` + `PRAGMA query_only=ON`. Reads (`select`, `get`) are distributed across readers via round-robin, each with its own serial GCD queue. Multiple reads can run concurrently on different readers. Readers open as READWRITE so they can initialize WAL shared memory, but `query_only` prevents accidental writes.
- **1 sync connection** — opened lazily on the first sync call. Used exclusively by `executeSync`/`selectSync`/`getSync` on the main thread.
- **Transaction queue** — concurrent `transaction()` calls are queued. The next transaction's `BEGIN` only dispatches after the previous one commits or rolls back.

WAL (Write-Ahead Logging) mode is enabled automatically on the writer. WAL allows readers to proceed without blocking writes, and writes to proceed without blocking readers.

### Performance

- All SQLite work (prepare, bind, step, column extraction) happens on background GCD threads.
- Results are serialized to a JSON string on the background thread. Only one value (the string) crosses the native-to-JS bridge. `JSON.parse` in V8 is highly optimized native C++ code.
- Blob columns are returned as separate `NSData` objects and converted to `ArrayBuffer` via `interop.bufferFromData` (no extra copy).
- The `selectArray` / `getArray` format avoids repeating column names per row, reducing both serialization cost and memory usage for large result sets.

## SQLite Linking

The plugin does **not** bundle or link a SQLite library — you must provide one. This gives you full control over the SQLite version and features available. Add **one** of the following to your app:

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

Every connection in the pool (writer, readers, sync) automatically receives the key via `PRAGMA key` after opening. If the key is wrong or missing for an encrypted database, operations will fail with `SQLITE_NOTADB`.

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
}
```

## License

Apache License Version 2.0
