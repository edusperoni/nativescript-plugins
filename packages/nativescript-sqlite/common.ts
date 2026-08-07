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
	 * Run every operation on a single serialized connection instead of the
	 * writer + reader pool. In serialized mode at most one transaction is active
	 * at a time and reads never run concurrently with writes.
	 *
	 * Defaults to `true` for in-memory databases (`:memory:`, an empty path, or a
	 * `mode=memory` URI) — a pool of separate connections cannot share a private
	 * in-memory database. Defaults to `false` for on-disk databases, which use
	 * the reader pool. Set explicitly to override the default (e.g. `false` on an
	 * in-memory database to opt into a shared-cache pool).
	 */
	serialized?: boolean;
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
