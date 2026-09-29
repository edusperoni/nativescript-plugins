export const SQLITE_OK = 0;
export const SQLITE_ERROR = 1;
export const SQLITE_INTERNAL = 2;
export const SQLITE_PERM = 3;
export const SQLITE_ABORT = 4;
export const SQLITE_BUSY = 5;
export const SQLITE_LOCKED = 6;
export const SQLITE_NOMEM = 7;
export const SQLITE_READONLY = 8;
export const SQLITE_INTERRUPT = 9;
export const SQLITE_IOERR = 10;
export const SQLITE_CORRUPT = 11;
export const SQLITE_NOTFOUND = 12;
export const SQLITE_FULL = 13;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_PROTOCOL = 15;
export const SQLITE_EMPTY = 16;
export const SQLITE_SCHEMA = 17;
export const SQLITE_TOOBIG = 18;
export const SQLITE_CONSTRAINT = 19;
export const SQLITE_MISMATCH = 20;
export const SQLITE_MISUSE = 21;
export const SQLITE_NOLFS = 22;
export const SQLITE_AUTH = 23;
export const SQLITE_FORMAT = 24;
export const SQLITE_RANGE = 25;
export const SQLITE_NOTADB = 26;
export const SQLITE_NOTICE = 27;
export const SQLITE_WARNING = 28;
export const SQLITE_ROW = 100;
export const SQLITE_DONE = 101;

export const SQLITE_OPEN_READONLY = 0x00000001;
export const SQLITE_OPEN_READWRITE = 0x00000002;
export const SQLITE_OPEN_CREATE = 0x00000004;
export const SQLITE_OPEN_URI = 0x00000040;
export const SQLITE_OPEN_MEMORY = 0x00000080;
export const SQLITE_OPEN_NOMUTEX = 0x00008000;
export const SQLITE_OPEN_FULLMUTEX = 0x00010000;
export const SQLITE_OPEN_SHAREDCACHE = 0x00020000;
export const SQLITE_OPEN_PRIVATECACHE = 0x00040000;
export const SQLITE_OPEN_NOFOLLOW = 0x01000000;

export const SQLITE_INTEGER = 1;
export const SQLITE_FLOAT = 2;
export const SQLITE_TEXT = 3;
export const SQLITE_BLOB = 4;
export const SQLITE_NULL = 5;

export type SQLiteValue = string | number | boolean | null | ArrayBuffer;
export type SQLiteParams = SQLiteValue[] | Record<string, SQLiteValue>;
export type SQLiteRow = Record<string, SQLiteValue>;

export interface SQLiteArrayResult<T extends SQLiteValue[] = SQLiteValue[]> {
	columns: string[];
	rows: T[];
}

export interface DatabaseOptions {
	path: string;
	readOnly?: boolean;
	poolSize?: number;
	busyTimeout?: number;
	/**
	 * SQLCipher key, applied to every connection in the pool via `PRAGMA key`.
	 * Treated as a passphrase unless `encryptionKeyFormat` says otherwise.
	 */
	encryptionKey?: string;
	/**
	 * How `encryptionKey` is interpreted. Defaults to `'passphrase'`.
	 *
	 * A passphrase is stretched with PBKDF2 (256,000 iterations by default)
	 * once per connection. A `'raw'` key is 64 hex digits (or 96 to carry the
	 * salt) used as key material directly, skipping that derivation — worth it
	 * for a full-entropy random key, where the two are equally strong and the
	 * stretching protects nothing. For a human-chosen passphrase the derivation
	 * is exactly what makes guessing expensive, so leave the default.
	 *
	 * The two are different keys: a database must be opened with the same form
	 * it was created with.
	 */
	encryptionKeyFormat?: 'passphrase' | 'raw';
	/**
	 * SQL run on every connection in the pool immediately after `PRAGMA key`,
	 * before the database is used for anything else. A statement that fails
	 * aborts the open and reports its SQLite error.
	 *
	 * This is the only point at which per-connection setup can both see the
	 * decrypted database and still precede every query. `sqlite3_auto_extension`
	 * runs too early — inside `sqlite3_open_v2`, before any key has been applied —
	 * so setup that needs a readable schema, such as registering an FTS5
	 * tokenizer, must happen here instead. Ordinary connection state like
	 * `PRAGMA foreign_keys=ON` fits here too.
	 */
	onOpen?: string[];
	/**
	 * Run every operation on the writer connection alone, with no reader pool.
	 * Reads then never run concurrently with writes.
	 *
	 * Defaults to `true` for in-memory databases (`:memory:`, an empty path, or a
	 * `mode=memory` URI) — a pool of separate connections cannot share a private
	 * in-memory database. Defaults to `false` for on-disk databases, which use
	 * the reader pool. Set explicitly to override the default (e.g. `false` on an
	 * in-memory database to opt into a shared-cache pool).
	 */
	serialized?: boolean;
	/**
	 * Open every connection on a background thread instead of opening the writer
	 * before `openDatabase()` returns.
	 *
	 * The default is `false`: the writer is opened synchronously, so a bad path
	 * or a wrong encryption key throws from `openDatabase()` itself. Readers are
	 * opened by their own threads either way.
	 *
	 * With `true`, `openDatabase()` returns immediately and never throws for an
	 * open failure — the failure surfaces through `initialized()` and through
	 * every operation afterwards instead. Worth it when the key is a passphrase:
	 * the derivation costs hundreds of milliseconds, and this keeps all of it off
	 * the JavaScript thread.
	 */
	asyncOpen?: boolean;
}

/** The shape SQLCipher reads as key bytes instead of stretching as a passphrase. */
const RAW_KEY_LITERAL = /^x'(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{96})'$/;
const RAW_KEY_HEX = /^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{96})$/;

/**
 * Resolves `encryptionKey` + `encryptionKeyFormat` into the value handed to
 * `PRAGMA key`.
 *
 * SQLCipher switches to raw-key material on its own whenever a key happens to
 * look like `x'<64 hex>'`, which would silently make it a different key from
 * the same characters as a passphrase. Rather than let that ride on the shape
 * of a string, an unannounced raw-looking key is rejected: the caller has to
 * say which one they meant.
 */
export function resolveEncryptionKey(options: DatabaseOptions): string | null {
	const key = options.encryptionKey;
	if (!key) {
		return null;
	}
	if (options.encryptionKeyFormat === 'raw') {
		if (RAW_KEY_LITERAL.test(key)) {
			return key;
		}
		if (RAW_KEY_HEX.test(key)) {
			return `x'${key}'`;
		}
		throw new Error("nativescript-sqlite: a raw encryptionKey must be 64 or 96 hex digits, optionally wrapped as x'…'");
	}
	if (RAW_KEY_LITERAL.test(key)) {
		throw new Error("nativescript-sqlite: this encryptionKey has SQLCipher's raw-key shape (x'<hex>'), so SQLCipher would use it as key bytes rather than stretch it as a passphrase. Pass encryptionKeyFormat: 'raw' to confirm that, or use a key of a different shape.");
	}
	return key;
}

/**
 * Returns true if the path refers to an in-memory (or temporary) database:
 * bare `:memory:`, an empty path, or a `mode=memory` / `:memory:` URI.
 */
export function isInMemoryPath(path: string): boolean {
	return path === ':memory:' || path === '' || path.indexOf('mode=memory') !== -1 || path.indexOf(':memory:') !== -1;
}

export interface RuntimeInfo {
	version: string;
	sourceId: string;
	compileOptions: string[];
}

/**
 * The synchronous reads every transaction object offers.
 *
 * They run on the connection that owns the transaction and see its uncommitted
 * state. Unlike the database-level sync methods they are never refused while a
 * transaction is open — they are the sanctioned way in. Using a transaction
 * object after it has committed or rolled back throws `SQLITE_MISUSE`.
 */
export interface SyncReads {
	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[];
	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;
	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined;
	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;
}

export interface ReadTransaction extends SyncReads {
	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]>;
	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined>;
	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
}

export interface Transaction extends ReadTransaction {
	execute(sql: string, params?: SQLiteParams): Promise<void>;
	executeSync(sql: string, params?: SQLiteParams): void;
	savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * The transaction handed to `transactionSync`. Synchronous throughout: the
 * callback runs between BEGIN and COMMIT with the connection held, so nothing
 * dispatched asynchronously can interleave with it.
 */
export interface SyncTransaction extends SyncReads {
	executeSync(sql: string, params?: SQLiteParams): void;
	savepointSync<T>(fn: (tx: SyncTransaction) => T): T;
}

export interface ExecuteSyncOptions {
	/**
	 * Run the statement inside whichever transaction is currently open instead of
	 * refusing. The write is then committed or rolled back with that transaction.
	 *
	 * An escape hatch for code that cannot be handed the transaction object; when
	 * no transaction is open it makes no difference. Prefer the transaction
	 * object's own `executeSync`, which cannot be wrong about what it joins.
	 */
	joinTransaction?: boolean;
}

export interface PreparedStatement {
	execute(params?: SQLiteParams): Promise<void>;
	select<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T[]>;
	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
	get<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T | undefined>;
	getArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
	finalize(): Promise<void>;
}

export interface SQLiteDatabase {
	execute(sql: string, params?: SQLiteParams): Promise<void>;
	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]>;
	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined>;
	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;

	transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
	readTransaction<T>(fn: (tx: ReadTransaction) => Promise<T>): Promise<T>;

	/**
	 * Runs a transaction without yielding: BEGIN, the callback, COMMIT — or
	 * ROLLBACK and a rethrow if the callback throws.
	 *
	 * The writer connection is held for the whole callback, so nothing dispatched
	 * asynchronously runs inside the transaction. Work queued before it runs
	 * first; work started from inside the callback — an un-awaited `execute()`,
	 * say — runs only after the transaction has committed or rolled back, and so
	 * is not part of it.
	 *
	 * The callback must be synchronous. Returning a thenable rolls the
	 * transaction back and throws, because its continuation could not run inside
	 * the transaction anyway.
	 */
	transactionSync<T>(fn: (tx: SyncTransaction) => T): T;

	prepare(sql: string): Promise<PreparedStatement>;

	/**
	 * The synchronous methods share the writer connection with the asynchronous
	 * ones, mutually exclusive and in the order the work was issued: a sync call
	 * runs inline when the writer is idle, and otherwise waits behind whatever is
	 * already queued on it. So a sync read sees the rows an open transaction has
	 * written but not yet committed, and a sync call after a burst of un-awaited
	 * `execute()` calls sees all of them.
	 *
	 * `executeSync` throws `SQLITE_BUSY` while a transaction opened through
	 * `transaction()` or `beginTransaction()` is still active: that statement
	 * would silently join the transaction. Use that transaction's own
	 * `executeSync`, or pass `{ joinTransaction: true }` to say you meant to join
	 * it. Sync reads stay allowed.
	 */
	executeSync(sql: string, params?: SQLiteParams, options?: ExecuteSyncOptions): void;
	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[];
	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;
	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined;
	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;

	// Low-level transaction control (for driver integrations like drizzle)
	beginTransaction(behavior?: 'deferred' | 'immediate' | 'exclusive'): Promise<number>;
	executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void>;
	selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]>;
	selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult>;
	executeInTransactionSync(txId: number, sql: string, params?: SQLiteParams): void;
	selectInTransactionSync(txId: number, sql: string, params?: SQLiteParams): SQLiteRow[];
	selectArrayInTransactionSync(txId: number, sql: string, params?: SQLiteParams): SQLiteArrayResult;
	commitTransaction(txId: number): Promise<void>;
	rollbackTransaction(txId: number): Promise<void>;

	getRuntimeInfo(): RuntimeInfo;

	/**
	 * Resolves once every connection is open, or rejects with the error that
	 * failed the open.
	 *
	 * Awaiting it is optional. Asynchronous methods queue behind the opens on
	 * their own and reject with the same error if one failed; synchronous methods
	 * block until the writer is open and then run or throw. It is there for
	 * callers that want the failure at a point of their choosing — in particular
	 * with `asyncOpen`, where `openDatabase()` cannot throw.
	 */
	initialized(): Promise<void>;

	close(): Promise<void>;
	/** True from `openDatabase()` until `close()`, including while connections are still opening. */
	readonly isOpen: boolean;
}

export class SQLiteError extends Error {
	constructor(
		message: string,
		public readonly code: number,
		public readonly extendedCode?: number,
	) {
		super(message);
		this.name = 'SQLiteError';
	}
}
