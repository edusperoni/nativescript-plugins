import { DatabaseOptions, RuntimeInfo, SQLiteArrayResult, SQLiteDatabase, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, Transaction, ReadTransaction, PreparedStatement } from './common';

export { DatabaseOptions, RuntimeInfo, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, ReadTransaction, Transaction, PreparedStatement };
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

// Load native library.
// JNI_OnLoad in bridge.cpp calls DatabaseBinding::Init via v8::Isolate::GetCurrent(),
// so global.NSCSQLite is ready as soon as loadLibrary returns.
java.lang.System.loadLibrary('nscsqlite');

const NSCSQLite = global.NSCSQLite;

// The native layer rejects/throws plain Error objects with a `.code` number
// property.  Re-wrap them as SQLiteError so callers can use `instanceof`.
function rewrapNativeError(e: unknown): never {
	if (e instanceof SQLiteError) throw e;
	if (e != null && typeof e === 'object' && typeof (e as any).code === 'number') {
		throw new SQLiteError((e as Error).message ?? String(e), (e as any).code);
	}
	throw e;
}

// Transparent proxy around the raw native object that catches errors from every
// method call (both sync throws and promise rejections) and rewraps them.
function makeNativeProxy(native: any): any {
	return new Proxy(native, {
		get(target, prop) {
			const val = target[prop];
			if (typeof val !== 'function') return val;
			return function (...args: any[]) {
				let result: any;
				try {
					result = val.apply(target, args);
				} catch (e) {
					rewrapNativeError(e);
				}
				if (result != null && typeof result.then === 'function') {
					return result.catch(rewrapNativeError);
				}
				return result;
			};
		},
	});
}

class PreparedStatementImpl implements PreparedStatement {
	constructor(
		private _db: any,
		private _stmtId: number,
	) {}

	async execute(params?: SQLiteParams): Promise<void> {
		await this._db.stepStatement(this._stmtId, params, 0);
	}

	async select<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T[]> {
		return await this._db.stepStatement(this._stmtId, params, 1);
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return await this._db.stepStatement(this._stmtId, params, 2);
	}

	async get<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T | undefined> {
		return await this._db.stepStatement(this._stmtId, params, 3);
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return await this._db.stepStatement(this._stmtId, params, 4);
	}

	async finalize(): Promise<void> {
		await this._db.finalizeStatement(this._stmtId);
	}
}

class ReadTransactionImpl implements ReadTransaction {
	constructor(
		protected _db: any,
		protected _txId: number,
	) {}

	async select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return await this._db.selectInTransaction(this._txId, sql, params, 1);
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return await this._db.selectInTransaction(this._txId, sql, params, 2);
	}

	async get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		const res = await this._db.selectInTransaction(this._txId, sql, params, 1);
		return res && res.length > 0 ? res[0] : undefined;
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		const res = await this._db.selectInTransaction(this._txId, sql, params, 2);
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
		await this._db.executeInTransaction(this._txId, sql, params);
	}

	async savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const name = `_sp${TransactionImpl._savepointSeq++}`;
		await this._db.executeInTransaction(this._txId, `SAVEPOINT ${name}`);
		try {
			const result = await fn(this);
			await this._db.executeInTransaction(this._txId, `RELEASE SAVEPOINT ${name}`);
			return result;
		} catch (e) {
			await this._db.executeInTransaction(this._txId, `ROLLBACK TO SAVEPOINT ${name}`);
			await this._db.executeInTransaction(this._txId, `RELEASE SAVEPOINT ${name}`);
			throw e;
		}
	}
}

class SQLiteDatabaseImpl implements SQLiteDatabase {
	private _db: any;
	private _isOpen = false;

	constructor(options: DatabaseOptions) {
		// Each sqlite3_open_v2(':memory:') call creates a new independent in-memory
		// database, so the writer, readers, and sync connections would each get their
		// own isolated database. Fix: translate ':memory:' to a named shared-cache URI
		// so all pool connections share a single in-memory database instance.
		// Requires SQLITE_OPEN_URI in the C++ layer (sqlite_connection.cpp).
		if (options.path === ':memory:') {
			const uid = `_nscmem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			options = { ...options, path: `file:${uid}?mode=memory&cache=shared` };
		}
		this._db = makeNativeProxy(new NSCSQLite(options.path, options));
		this._isOpen = true;
	}

	get isOpen() {
		return this._isOpen;
	}

	async execute(sql: string, params?: SQLiteParams): Promise<void> {
		await this._db.execute(sql, params);
	}

	async select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return await this._db.select(sql, params);
	}

	async selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return await this._db.selectArray(sql, params);
	}

	async get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return await this._db.get(sql, params);
	}

	async getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return await this._db.getArray(sql, params);
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
		const stmtId = await this._db.prepare(sql);
		return new PreparedStatementImpl(this._db, stmtId);
	}

	executeSync(sql: string, params?: SQLiteParams): void {
		this._db.executeSync(sql, params);
	}

	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[] {
		return this._db.selectSync(sql, params);
	}

	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		return this._db.selectArraySync(sql, params);
	}

	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined {
		return this._db.getSync(sql, params);
	}

	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		return this._db.getArraySync(sql, params);
	}

	async beginTransaction(behavior?: 'deferred' | 'immediate' | 'exclusive'): Promise<number> {
		return await this._db.beginTransaction(behavior);
	}

	async executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void> {
		await this._db.executeInTransaction(txId, sql, params);
	}

	async selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]> {
		return await this._db.selectInTransaction(txId, sql, params, 1);
	}

	async selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult> {
		return await this._db.selectInTransaction(txId, sql, params, 2);
	}

	async commitTransaction(txId: number): Promise<void> {
		await this._db.commitTransaction(txId);
	}

	async rollbackTransaction(txId: number): Promise<void> {
		await this._db.rollbackTransaction(txId);
	}

	getRuntimeInfo(): RuntimeInfo {
		return this._db.getRuntimeInfo();
	}

	async close(): Promise<void> {
		if (this._isOpen) {
			await this._db.close();
			this._isOpen = false;
		}
	}
}

export function openDatabase(options: DatabaseOptions): SQLiteDatabase {
	return new SQLiteDatabaseImpl(options);
}
