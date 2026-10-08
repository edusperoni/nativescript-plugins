import { DatabaseOptions, NativeOpenStep, RuntimeInfo, SQLITE_ERROR, SQLITE_MISUSE, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, isInMemoryPath, resolveEncryptionKey, resolveOpenSequence } from './common';
import type { PreparedStatement, ReadTransaction, SQLiteDatabase, Transaction } from '.';

export { DatabaseOptions, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, RuntimeInfo };
export type { PreparedStatement, ReadTransaction, SQLiteDatabase, Transaction };
export * from './common';

declare class NSSQLiteDatabase extends NSObject {
	/** Returns null with `error` set when the writer cannot be opened, unless asyncOpen is true. */
	static openWithPathPoolSizeReadOnlyBusyTimeoutEncryptionKeyOpenSequenceSerializedAsyncOpenError(path: string, poolSize: number, readOnly: boolean, busyTimeout: number, encryptionKey: string | null, openSequence: NativeOpenStep[], serialized: boolean, asyncOpen: boolean, error: interop.Reference<NSError>): NSSQLiteDatabase;

	initializedWithCompletion(completion: (error: NSError) => void): void;

	executeParamsCompletion(sql: string, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectParamsCompletion(sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayParamsCompletion(sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;

	beginTransactionCompletion(behavior: string, completion: (txId: number, error: NSError) => void): void;
	executeInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	commitTransactionCompletion(txId: number, completion: (error: NSError) => void): void;
	rollbackTransactionCompletion(txId: number, completion: (error: NSError) => void): void;

	beginReadTransaction(completion: (txId: number, error: NSError) => void): void;
	selectInReadTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayInReadTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	endReadTransactionCompletion(txId: number, completion: (error: NSError) => void): void;

	prepareCompletion(sql: string, completion: (stmtId: number, error: NSError) => void): void;
	executePreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectPreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayPreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	finalizePreparedCompletion(stmtId: number, completion: (error: NSError) => void): void;

	executeSyncParamsJoinTransactionError(sql: string, params: NSArray<any>, joinTransaction: boolean, error: interop.Reference<NSError>): boolean;
	selectSyncParamsBlobsError(sql: string, params: NSArray<any>, blobs: interop.Reference<NSArray<NSData>>, error: interop.Reference<NSError>): string;
	selectArraySyncParamsBlobsError(sql: string, params: NSArray<any>, blobs: interop.Reference<NSArray<NSData>>, error: interop.Reference<NSError>): string;

	executeInTransactionSyncSqlParamsError(txId: number, sql: string, params: NSArray<any>, error: interop.Reference<NSError>): boolean;
	selectInTransactionSyncSqlParamsBlobsError(txId: number, sql: string, params: NSArray<any>, blobs: interop.Reference<NSArray<NSData>>, error: interop.Reference<NSError>): string;
	selectArrayInTransactionSyncSqlParamsBlobsError(txId: number, sql: string, params: NSArray<any>, blobs: interop.Reference<NSArray<NSData>>, error: interop.Reference<NSError>): string;

	beginTransactionSyncError(behavior: string, error: interop.Reference<NSError>): number;
	endTransactionSyncCommitError(txId: number, commit: boolean, error: interop.Reference<NSError>): boolean;

	runtimeInfo(): NSDictionary<string, any>;

	closeWithCompletion(completion: () => void): void;
	close(): void;
	isOpen: boolean;
}

function toNSError(error: NSError): SQLiteError {
	const extCode = error.userInfo?.objectForKey?.('extendedCode') as number | undefined;
	return new SQLiteError(error.localizedDescription, error.code, extCode ?? error.code);
}

function openErrorMessage(path: string, reason?: string): string {
	return reason ? `Failed to open database "${path}": ${reason}` : `Failed to open database: ${path}`;
}

/** Both open routes — `openDatabase()` and `initialized()` — report through this. */
function toOpenError(error: NSError, path: string): SQLiteError {
	const extCode = error.userInfo?.objectForKey?.('extendedCode') as number | undefined;
	return new SQLiteError(openErrorMessage(path, error.localizedDescription), error.code, extCode ?? error.code);
}

/** The sync entry points report failure through a trailing NSError out-parameter. */
function syncError(ref: interop.Reference<NSError>, fallback: string): SQLiteError {
	const error = ref.value;
	return error ? toNSError(error) : new SQLiteError(fallback, SQLITE_ERROR);
}

type SyncSelectCall = (blobs: interop.Reference<NSArray<NSData>>, error: interop.Reference<NSError>) => string;

function runSelectSync<T>(call: SyncSelectCall): T[] {
	const blobs = new interop.Reference<NSArray<NSData>>();
	const error = new interop.Reference<NSError>();
	const json = call(blobs, error);
	if (!json) throw syncError(error, 'selectSync failed');
	return parseSelectResult<T[]>(json, blobs.value ?? null);
}

function runSelectArraySync<T extends SQLiteValue[]>(call: SyncSelectCall): SQLiteArrayResult<T> {
	const blobs = new interop.Reference<NSArray<NSData>>();
	const error = new interop.Reference<NSError>();
	const json = call(blobs, error);
	if (!json) throw syncError(error, 'selectArraySync failed');
	return parseArrayResult<T>(json, blobs.value ?? null);
}

function marshalParams(params?: SQLiteParams): NSArray<any> {
	if (!params) return NSArray.new<any>();
	if (Array.isArray(params)) {
		return NSArray.arrayWithArray(
			params.map((v) => {
				if (v === null || v === undefined) return NSNull.null();
				if (typeof v === 'boolean') return NSNumber.numberWithBool(v);
				if (typeof v === 'number') return NSNumber.numberWithDouble(v);
				if (typeof v === 'string') return v as any;
				if (v instanceof ArrayBuffer) return NSData.dataWithData(v as any);
				return NSNull.null();
			}),
		);
	}
	const dict = NSMutableDictionary.new<string, any>();
	for (const key of Object.keys(params)) {
		const v = (params as Record<string, SQLiteValue>)[key];
		if (v === null || v === undefined) {
			dict.setObjectForKey(NSNull.null(), key);
		} else if (typeof v === 'boolean') {
			dict.setObjectForKey(NSNumber.numberWithBool(v), key);
		} else if (typeof v === 'number') {
			dict.setObjectForKey(NSNumber.numberWithDouble(v), key);
		} else if (typeof v === 'string') {
			dict.setObjectForKey(v as any, key);
		} else if (v instanceof ArrayBuffer) {
			dict.setObjectForKey(NSData.dataWithData(v as any), key);
		} else {
			dict.setObjectForKey(NSNull.null(), key);
		}
	}
	return NSArray.arrayWithObject(dict);
}

function parseSelectResult<T>(json: string, blobs: NSArray<NSData> | null): T {
	const rows = JSON.parse(json);
	if (blobs && blobs.count > 0) {
		hydrateBlobs(rows, blobs);
	}
	return rows;
}

function hydrateBlobs(rows: any[], blobs: NSArray<NSData>): void {
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			const val = row[key];
			if (val && typeof val === 'object' && '__blob__' in val) {
				const nsData = blobs.objectAtIndex(val.__blob__);
				row[key] = interop.bufferFromData(nsData);
			}
		}
	}
}

function parseArrayResult<T extends SQLiteValue[]>(json: string, blobs: NSArray<NSData> | null): SQLiteArrayResult<T> {
	const result = JSON.parse(json) as SQLiteArrayResult<T>;
	if (blobs && blobs.count > 0) {
		for (const row of result.rows) {
			for (let i = 0; i < row.length; i++) {
				const val = row[i] as any;
				if (val && typeof val === 'object' && '__blob__' in val) {
					const nsData = blobs.objectAtIndex(val.__blob__);
					(row as any)[i] = interop.bufferFromData(nsData);
				}
			}
		}
	}
	return result;
}

/**
 * The synchronous reads every transaction object offers. They run on the
 * connection that owns the transaction, so they see its uncommitted rows and
 * never trip the SQLITE_BUSY safeguard `db.executeSync` applies.
 */
class TxSyncReads {
	constructor(
		protected native: NSSQLiteDatabase,
		protected txId: number,
	) {}

	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[] {
		return runSelectSync<T>((blobs, error) => this.native.selectInTransactionSyncSqlParamsBlobsError(this.txId, sql, marshalParams(params), blobs, error));
	}

	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		return runSelectArraySync<T>((blobs, error) => this.native.selectArrayInTransactionSyncSqlParamsBlobsError(this.txId, sql, marshalParams(params), blobs, error));
	}

	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined {
		return this.selectSync<T>(sql, params)[0];
	}

	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		const result = this.selectArraySync<T>(sql, params);
		return { columns: result.columns, rows: result.rows.slice(0, 1) };
	}
}

class TxSyncStatements extends TxSyncReads {
	executeSync(sql: string, params?: SQLiteParams): void {
		const error = new interop.Reference<NSError>();
		if (!this.native.executeInTransactionSyncSqlParamsError(this.txId, sql, marshalParams(params), error)) {
			throw syncError(error, 'executeSync failed');
		}
	}
}

class WriteTxImpl extends TxSyncStatements implements Transaction {
	constructor(
		native: NSSQLiteDatabase,
		txId: number,
		private _savepointCounter: { value: number },
	) {
		super(native, txId);
	}

	execute(sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	async savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const name = `sp_${this._savepointCounter.value++}`;
		await this.execute(`SAVEPOINT ${name}`);
		try {
			const result = await fn(this);
			await this.execute(`RELEASE ${name}`);
			return result;
		} catch (e) {
			await this.execute(`ROLLBACK TO ${name}`);
			throw e;
		}
	}
}

/** The transaction object `transactionSync` hands to its callback. */
class SyncTxImpl extends TxSyncStatements {
	constructor(
		native: NSSQLiteDatabase,
		txId: number,
		private _savepointCounter: { value: number },
	) {
		super(native, txId);
	}

	savepointSync<T>(fn: (tx: SyncTxImpl) => T): T {
		const name = `sp_${this._savepointCounter.value++}`;
		this.executeSync(`SAVEPOINT ${name}`);
		try {
			const result = fn(this);
			this.executeSync(`RELEASE ${name}`);
			return result;
		} catch (e) {
			this.executeSync(`ROLLBACK TO ${name}`);
			throw e;
		}
	}
}

class ReadTxImpl extends TxSyncReads implements ReadTransaction {
	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInReadTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInReadTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}
}

class PreparedStatementImpl implements PreparedStatement {
	constructor(
		private native: NSSQLiteDatabase,
		private stmtId: number,
	) {}

	execute(params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executePreparedParamsCompletion(this.stmtId, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectPreparedParamsCompletion(this.stmtId, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayPreparedParamsCompletion(this.stmtId, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	finalize(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.finalizePreparedCompletion(this.stmtId, (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}
}

class SQLiteDatabaseImpl implements SQLiteDatabase {
	constructor(
		private native: NSSQLiteDatabase,
		private path: string,
	) {}

	get isOpen(): boolean {
		return this.native.isOpen;
	}

	/** A fresh promise per call, so a rejection nobody observes is never created. */
	initialized(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.native.initializedWithCompletion((error) => {
				if (error) {
					reject(toOpenError(error, this.path));
				} else {
					resolve();
				}
			});
		});
	}

	execute(sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeParamsCompletion(sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectParamsCompletion(sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayParamsCompletion(sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const txId = await new Promise<number>((resolve, reject) => {
			this.native.beginTransactionCompletion('deferred', (id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});

		const tx = new WriteTxImpl(this.native, txId, { value: 0 });
		try {
			const result = await fn(tx);
			await new Promise<void>((resolve, reject) => {
				this.native.commitTransactionCompletion(txId, (error) => {
					if (error) {
						reject(toNSError(error));
					} else {
						resolve();
					}
				});
			});
			return result;
		} catch (e) {
			await new Promise<void>((resolve) => {
				this.native.rollbackTransactionCompletion(txId, () => resolve());
			});
			throw e;
		}
	}

	async readTransaction<T>(fn: (tx: ReadTransaction) => Promise<T>): Promise<T> {
		const txId = await new Promise<number>((resolve, reject) => {
			this.native.beginReadTransaction((id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});

		const tx = new ReadTxImpl(this.native, txId);
		try {
			const result = await fn(tx);
			await new Promise<void>((resolve) => {
				this.native.endReadTransactionCompletion(txId, () => resolve());
			});
			return result;
		} catch (e) {
			await new Promise<void>((resolve) => {
				this.native.endReadTransactionCompletion(txId, () => resolve());
			});
			throw e;
		}
	}

	prepare(sql: string): Promise<PreparedStatement> {
		return new Promise((resolve, reject) => {
			this.native.prepareCompletion(sql, (stmtId, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(new PreparedStatementImpl(this.native, stmtId));
				}
			});
		});
	}

	executeSync(sql: string, params?: SQLiteParams, options?: { joinTransaction?: boolean }): void {
		const error = new interop.Reference<NSError>();
		if (!this.native.executeSyncParamsJoinTransactionError(sql, marshalParams(params), options?.joinTransaction ?? false, error)) {
			throw syncError(error, 'executeSync failed');
		}
	}

	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[] {
		return runSelectSync<T>((blobs, error) => this.native.selectSyncParamsBlobsError(sql, marshalParams(params), blobs, error));
	}

	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		return runSelectArraySync<T>((blobs, error) => this.native.selectArraySyncParamsBlobsError(sql, marshalParams(params), blobs, error));
	}

	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined {
		return this.selectSync<T>(sql, params)[0];
	}

	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		const result = this.selectArraySync<T>(sql, params);
		return { columns: result.columns, rows: result.rows.slice(0, 1) };
	}

	transactionSync<T>(fn: (tx: SyncTxImpl) => T): T {
		const beginError = new interop.Reference<NSError>();
		const txId = this.native.beginTransactionSyncError('deferred', beginError);
		if (txId < 0) {
			throw syncError(beginError, 'beginTransactionSync failed');
		}

		const tx = new SyncTxImpl(this.native, txId, { value: 0 });
		let result: T;
		try {
			result = fn(tx);
			// Nothing can be awaited inside the span, so a promise here would be
			// committed before the work it stands for had run.
			if (result && typeof (result as unknown as Promise<T>).then === 'function') {
				throw new SQLiteError('transactionSync requires a synchronous callback, but it returned a promise; use transaction() instead', SQLITE_MISUSE);
			}
		} catch (e) {
			this._endTransactionSync(txId, false);
			throw e;
		}
		this._endTransactionSync(txId, true);
		return result;
	}

	private _endTransactionSync(txId: number, commit: boolean): void {
		const error = new interop.Reference<NSError>();
		if (!this.native.endTransactionSyncCommitError(txId, commit, error) && commit) {
			throw syncError(error, 'commit failed');
		}
	}

	executeInTransactionSync(txId: number, sql: string, params?: SQLiteParams): void {
		const error = new interop.Reference<NSError>();
		if (!this.native.executeInTransactionSyncSqlParamsError(txId, sql, marshalParams(params), error)) {
			throw syncError(error, 'executeInTransactionSync failed');
		}
	}

	selectInTransactionSync(txId: number, sql: string, params?: SQLiteParams): SQLiteRow[] {
		return runSelectSync<SQLiteRow>((blobs, error) => this.native.selectInTransactionSyncSqlParamsBlobsError(txId, sql, marshalParams(params), blobs, error));
	}

	selectArrayInTransactionSync(txId: number, sql: string, params?: SQLiteParams): SQLiteArrayResult {
		return runSelectArraySync<SQLiteValue[]>((blobs, error) => this.native.selectArrayInTransactionSyncSqlParamsBlobsError(txId, sql, marshalParams(params), blobs, error));
	}

	// Low-level transaction control for driver integrations

	beginTransaction(behavior?: string): Promise<number> {
		return new Promise((resolve, reject) => {
			this.native.beginTransactionCompletion(behavior ?? 'deferred', (id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});
	}

	executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<SQLiteRow[]>(json, blobs));
				}
			});
		});
	}

	selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult(json, blobs));
				}
			});
		});
	}

	commitTransaction(txId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.commitTransactionCompletion(txId, (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	rollbackTransaction(txId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.rollbackTransactionCompletion(txId, (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	getRuntimeInfo(): RuntimeInfo {
		const info = this.native.runtimeInfo();
		const options = info.objectForKey('compileOptions') as NSArray<string>;
		const compileOptions: string[] = [];
		for (let i = 0; i < options.count; i++) {
			compileOptions.push(options.objectAtIndex(i));
		}
		return {
			version: info.objectForKey('version') as string,
			sourceId: info.objectForKey('sourceId') as string,
			compileOptions,
		};
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.native.closeWithCompletion(() => {
				resolve();
			});
		});
	}
}

export function openDatabase(options: DatabaseOptions): SQLiteDatabase {
	const serialized = options.serialized ?? isInMemoryPath(options.path);
	// Resolved before anything native runs, so a rejected sequence leaves no file behind.
	const openSequence = resolveOpenSequence(options);
	const error = new interop.Reference<NSError>();
	const native = NSSQLiteDatabase.openWithPathPoolSizeReadOnlyBusyTimeoutEncryptionKeyOpenSequenceSerializedAsyncOpenError(options.path, options.poolSize ?? 4, options.readOnly ?? false, options.busyTimeout ?? 5000, resolveEncryptionKey(options), openSequence, serialized, options.asyncOpen ?? false, error);
	if (!native) {
		const failure = error.value;
		throw failure ? toOpenError(failure, options.path) : new SQLiteError(openErrorMessage(options.path), SQLITE_ERROR);
	}
	return new SQLiteDatabaseImpl(native, options.path);
}
