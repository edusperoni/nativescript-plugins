import { File, knownFolders } from '@nativescript/core';
import { openDatabase, SQLiteDatabase } from '@edusperoni/nativescript-sqlite';

const SIDECARS = ['', '-wal', '-shm', '-journal'];

/** Deletes `path` and its WAL/SHM/journal files if present. */
export function removeDbFiles(path: string): void {
	for (const suffix of SIDECARS) {
		if (File.exists(path + suffix)) File.fromPath(path + suffix).remove();
	}
}

/** A fresh database path in the documents folder; any previous file at it is deleted. */
export function tempDbPath(name: string): string {
	const path = knownFolders.documents().path + '/' + name;
	removeDbFiles(path);
	return path;
}

/** Closes `db`, ignoring the error a database that is already closed reports. */
export async function closeQuietly(db: SQLiteDatabase | undefined): Promise<void> {
	if (db) await db.close().catch(() => undefined);
}

/**
 * Whether `path` can be read with `key` (or with no key). Unreadability is the
 * only engine-independent proof that a database is encrypted.
 */
export async function canRead(path: string, key?: string, table = 'secret'): Promise<boolean> {
	let db: SQLiteDatabase | undefined;
	try {
		db = openDatabase(key === undefined ? { path } : { path, encryptionKey: key });
		await db.select(`SELECT * FROM ${table}`);
		return true;
	} catch (e) {
		return false;
	} finally {
		await closeQuietly(db);
	}
}

let sqlcipher: Promise<boolean> | undefined;

/**
 * Whether the linked engine has a codec. One without a codec accepts `PRAGMA key`
 * and writes plaintext, so no compile option or pragma identifies a codec across
 * engines; whether a keyed database is unreadable without its key does.
 */
export function hasSQLCipher(): Promise<boolean> {
	if (!sqlcipher) sqlcipher = detectSQLCipher();
	return sqlcipher;
}

async function detectSQLCipher(): Promise<boolean> {
	const path = tempDbPath('_nsc_codec_probe.db');
	try {
		const keyed = openDatabase({ path, encryptionKey: 'codec-probe-key' });
		try {
			await keyed.execute('CREATE TABLE probe (x INTEGER)');
		} finally {
			await keyed.close();
		}
	} catch (e) {
		removeDbFiles(path);
		return false;
	}
	try {
		return !(await canRead(path, undefined, 'probe'));
	} finally {
		removeDbFiles(path);
	}
}

/** Marks the calling spec pending when the engine has no codec. Call it first in the spec. */
export async function requireSQLCipher(): Promise<void> {
	if (!(await hasSQLCipher())) pending('the linked SQLite engine has no codec');
}
