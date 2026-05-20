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
	encryptionKey?: string;
}

export interface RuntimeInfo {
	version: string;
	sourceId: string;
	compileOptions: string[];
}

export interface ReadTransaction {
	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]>;
	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined>;
	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>>;
}

export interface Transaction extends ReadTransaction {
	execute(sql: string, params?: SQLiteParams): Promise<void>;
	savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
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

	prepare(sql: string): Promise<PreparedStatement>;

	executeSync(sql: string, params?: SQLiteParams): void;
	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[];
	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;
	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined;
	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T>;

	// Low-level transaction control (for driver integrations like drizzle)
	beginTransaction(behavior?: 'deferred' | 'immediate' | 'exclusive'): Promise<number>;
	executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void>;
	selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]>;
	selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult>;
	commitTransaction(txId: number): Promise<void>;
	rollbackTransaction(txId: number): Promise<void>;

	getRuntimeInfo(): RuntimeInfo;

	close(): Promise<void>;
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
