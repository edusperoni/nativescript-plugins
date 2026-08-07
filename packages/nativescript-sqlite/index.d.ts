import { DatabaseOptions, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue } from './common';

export { DatabaseOptions, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue };
export { SQLITE_OK, SQLITE_ERROR, SQLITE_BUSY, SQLITE_CONSTRAINT, SQLITE_MISMATCH, SQLITE_MISUSE, SQLITE_RANGE, SQLITE_ROW, SQLITE_DONE, SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE, SQLITE_OPEN_MEMORY, SQLITE_OPEN_URI, SQLITE_OPEN_NOMUTEX, SQLITE_OPEN_FULLMUTEX, SQLITE_INTEGER, SQLITE_FLOAT, SQLITE_TEXT, SQLITE_BLOB, SQLITE_NULL } from './common';

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

	close(): Promise<void>;
	readonly isOpen: boolean;
}

export function openDatabase(options: DatabaseOptions): SQLiteDatabase;
