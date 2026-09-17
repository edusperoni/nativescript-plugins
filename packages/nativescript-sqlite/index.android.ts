import { DatabaseOptions, RuntimeInfo, SQLITE_ERROR, SQLiteArrayResult, SQLiteDatabase, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, Transaction, ReadTransaction, PreparedStatement, isInMemoryPath, resolveEncryptionKey } from './common';

export { DatabaseOptions, RuntimeInfo, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, ReadTransaction, Transaction, PreparedStatement, isInMemoryPath, resolveEncryptionKey };
export type { SQLiteDatabase };
export {
	SQLITE_OK,
	SQLITE_ERROR,
	SQLITE_INTERNAL,
	SQLITE_PERM,
	SQLITE_ABORT,
	SQLITE_BUSY,
	SQLITE_LOCKED,
	SQLITE_NOMEM,
	SQLITE_READONLY,
	SQLITE_INTERRUPT,
	SQLITE_IOERR,
	SQLITE_CORRUPT,
	SQLITE_NOTFOUND,
	SQLITE_FULL,
	SQLITE_CANTOPEN,
	SQLITE_PROTOCOL,
	SQLITE_EMPTY,
	SQLITE_SCHEMA,
	SQLITE_TOOBIG,
	SQLITE_CONSTRAINT,
	SQLITE_MISMATCH,
	SQLITE_MISUSE,
	SQLITE_NOLFS,
	SQLITE_AUTH,
	SQLITE_FORMAT,
	SQLITE_RANGE,
	SQLITE_NOTADB,
	SQLITE_NOTICE,
	SQLITE_WARNING,
	SQLITE_ROW,
	SQLITE_DONE,
	SQLITE_OPEN_READONLY,
	SQLITE_OPEN_READWRITE,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_URI,
	SQLITE_OPEN_MEMORY,
	SQLITE_OPEN_NOMUTEX,
	SQLITE_OPEN_FULLMUTEX,
	SQLITE_OPEN_SHAREDCACHE,
	SQLITE_OPEN_PRIVATECACHE,
	SQLITE_OPEN_NOFOLLOW,
	SQLITE_INTEGER,
	SQLITE_FLOAT,
	SQLITE_TEXT,
	SQLITE_BLOB,
	SQLITE_NULL,
} from './common';

declare const global: any;
declare const __non_webpack_require__: (name: string) => any;

// Load native library.
// The V8 backend's JNI_OnLoad calls DatabaseBinding::Init via
// v8::Isolate::GetCurrent(), so global.NSCSQLite is ready as soon as
// loadLibrary returns.  The napi backend instead registers a Node-API module
// from a static constructor, which only the runtime's own require() resolves —
// webpack rewrites a plain `require`, so it has to be reached through
// __non_webpack_require__.
java.lang.System.loadLibrary('nscsqlite');

function loadNativeClass(): any {
	if (global.NSCSQLite) return global.NSCSQLite;
	return __non_webpack_require__('nscsqlite').NSCSQLite;
}

const NSCSQLite = loadNativeClass();

interface NativeOpenOptions {
	readOnly: boolean;
	poolSize: number;
	busyTimeout: number;
	encryptionKey: string | null;
	onOpen: string[];
	serialized: boolean;
}

// The native layer rejects/throws plain Error objects with a `.code` number
// property.  Re-wrap them as SQLiteError so callers can use `instanceof`.
function rewrapNativeError(e: unknown): never {
	if (e instanceof SQLiteError) throw e;
	if (e != null && typeof e === 'object' && typeof (e as any).code === 'number') {
		throw new SQLiteError((e as Error).message ?? String(e), (e as any).code);
	}
	throw e;
}

function toOpenError(e: any, path: string): never {
	const code = typeof e?.code === 'number' ? e.code : SQLITE_ERROR;
	const message = e?.message;
	throw new SQLiteError(message ? `Failed to open database "${path}": ${message}` : `Failed to open database: ${path}`, code);
}

class PreparedStatementImpl implements PreparedStatement {
	constructor(
		private _db: any,
		private _stmtId: number,
	) {}

	async execute(params?: SQLiteParams): Promise<void> {
		try {
			await this._db.stepStatement(this._stmtId, params, 0);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async select<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T[]> {
		try {
			return await this._db.stepStatement(this._stmtId, params, 1);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		try {
			return await this._db.stepStatement(this._stmtId, params, 2);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async get<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T | undefined> {
		try {
			return await this._db.stepStatement(this._stmtId, params, 3);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		try {
			return await this._db.stepStatement(this._stmtId, params, 4);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async finalize(): Promise<void> {
		try {
			await this._db.finalizeStatement(this._stmtId);
		} catch (e) {
			rewrapNativeError(e);
		}
	}
}

class ReadTransactionImpl implements ReadTransaction {
	constructor(
		protected _db: any,
		protected _txId: number,
	) {}

	async select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		try {
			return await this._db.selectInTransaction(this._txId, sql, params, 1);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		try {
			return await this._db.selectInTransaction(this._txId, sql, params, 2);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		const res = await this.select<T>(sql, params);
		return res && res.length > 0 ? res[0] : undefined;
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		const res = await this.selectArray<T>(sql, params);
		if (res && res.rows && res.rows.length > 0) {
			return { columns: res.columns, rows: [res.rows[0]] as any };
		}
		return { columns: res.columns, rows: [] };
	}
}

class TransactionImpl extends ReadTransactionImpl implements Transaction {
	private static _savepointSeq = 0;

	constructor(db: any, txId: number) {
		super(db, txId);
	}

	async execute(sql: string, params?: SQLiteParams): Promise<void> {
		try {
			await this._db.executeInTransaction(this._txId, sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const name = `_sp${TransactionImpl._savepointSeq++}`;
		await this.execute(`SAVEPOINT ${name}`);
		try {
			const result = await fn(this);
			await this.execute(`RELEASE SAVEPOINT ${name}`);
			return result;
		} catch (e) {
			await this.execute(`ROLLBACK TO SAVEPOINT ${name}`);
			await this.execute(`RELEASE SAVEPOINT ${name}`);
			throw e;
		}
	}
}

class SQLiteDatabaseImpl implements SQLiteDatabase {
	private _db: any;
	private _isOpen = false;

	constructor(options: DatabaseOptions) {
		const serialized = options.serialized ?? isInMemoryPath(options.path);
		const native: NativeOpenOptions = {
			readOnly: options.readOnly ?? false,
			poolSize: options.poolSize ?? 4,
			busyTimeout: options.busyTimeout ?? 5000,
			encryptionKey: resolveEncryptionKey(options),
			onOpen: options.onOpen ?? [],
			serialized,
		};

		// Each sqlite3_open_v2(':memory:') call creates a new independent in-memory
		// database, so a pool's connections would each get their own.  A shared-cache
		// URI gives them one database instead; it is only needed when the caller has
		// opted out of serialized mode, which otherwise opens a single connection.
		let path = options.path;
		if (!serialized && path === ':memory:') {
			const uid = `_nscmem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			path = `file:${uid}?mode=memory&cache=shared`;
		}

		try {
			this._db = new NSCSQLite(path, native);
		} catch (e) {
			toOpenError(e, options.path);
		}
		this._isOpen = true;
	}

	get isOpen() {
		return this._isOpen;
	}

	async execute(sql: string, params?: SQLiteParams): Promise<void> {
		try {
			await this._db.execute(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		try {
			return await this._db.select(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		try {
			return await this._db.selectArray(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		try {
			return await this._db.get(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		try {
			return await this._db.getArray(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const txId = await this.beginTransaction();
		try {
			const tx = new TransactionImpl(this._db, txId);
			const res = await fn(tx);
			await this.commitTransaction(txId);
			return res;
		} catch (e) {
			await this.rollbackTransaction(txId);
			throw e;
		}
	}

	async readTransaction<T>(fn: (tx: ReadTransaction) => Promise<T>): Promise<T> {
		const txId = await this.beginTransaction('deferred');
		try {
			const tx = new ReadTransactionImpl(this._db, txId);
			const res = await fn(tx);
			await this.commitTransaction(txId);
			return res;
		} catch (e) {
			await this.rollbackTransaction(txId);
			throw e;
		}
	}

	async prepare(sql: string): Promise<PreparedStatement> {
		let stmtId: number;
		try {
			stmtId = await this._db.prepare(sql);
		} catch (e) {
			rewrapNativeError(e);
		}
		return new PreparedStatementImpl(this._db, stmtId);
	}

	executeSync(sql: string, params?: SQLiteParams): void {
		try {
			this._db.executeSync(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[] {
		try {
			return this._db.selectSync(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		try {
			return this._db.selectArraySync(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined {
		try {
			return this._db.getSync(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		try {
			return this._db.getArraySync(sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async beginTransaction(behavior?: 'deferred' | 'immediate' | 'exclusive'): Promise<number> {
		try {
			return await this._db.beginTransaction(behavior);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void> {
		try {
			await this._db.executeInTransaction(txId, sql, params);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]> {
		try {
			return await this._db.selectInTransaction(txId, sql, params, 1);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult> {
		try {
			return await this._db.selectInTransaction(txId, sql, params, 2);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async commitTransaction(txId: number): Promise<void> {
		try {
			await this._db.commitTransaction(txId);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async rollbackTransaction(txId: number): Promise<void> {
		try {
			await this._db.rollbackTransaction(txId);
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	getRuntimeInfo(): RuntimeInfo {
		try {
			return this._db.getRuntimeInfo();
		} catch (e) {
			rewrapNativeError(e);
		}
	}

	async close(): Promise<void> {
		if (this._isOpen) {
			try {
				await this._db.close();
			} catch (e) {
				rewrapNativeError(e);
			}
			this._isOpen = false;
		}
	}
}

export function openDatabase(options: DatabaseOptions): SQLiteDatabase {
	return new SQLiteDatabaseImpl(options);
}
