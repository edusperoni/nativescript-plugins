import { DatabaseOptions, OpenStep, openDatabase, SQLiteDatabase, SQLITE_NOTADB } from '@edusperoni/nativescript-sqlite';
import { canRead, closeQuietly, removeDbFiles, requireSQLCipher, tempDbPath } from './helpers';

const TIMEOUT = 60000;

describe('nativescript-sqlite: encryption', () => {
	let opened: SQLiteDatabase[] = [];
	let paths: string[] = [];

	function dbPath(name: string): string {
		const path = tempDbPath(name);
		paths.push(path);
		return path;
	}

	function open(options: DatabaseOptions): SQLiteDatabase {
		const db = openDatabase(options);
		opened.push(db);
		return db;
	}

	async function writeSecret(options: DatabaseOptions, val: string): Promise<void> {
		const db = open(options);
		await db.execute(`CREATE TABLE secret (id INTEGER PRIMARY KEY, val TEXT)`);
		await db.execute(`INSERT INTO secret VALUES (1, '${val}')`);
		await db.close();
	}

	afterEach(async () => {
		for (const db of opened) await closeQuietly(db);
		for (const path of paths) removeDbFiles(path);
		opened = [];
		paths = [];
	});

	describe('a passphrase-keyed database', () => {
		const key = 'secret-key-123';

		it(
			'keeps its data across close and reopen with the same key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_passphrase_roundtrip.db');

				const db = open({ path, encryptionKey: key });
				expect(db.isOpen).toBeTrue();
				await db.execute(`CREATE TABLE secret (id INTEGER PRIMARY KEY, val TEXT)`);
				await db.execute(`INSERT INTO secret VALUES (1, 'hidden')`);
				await db.close();

				const again = open({ path, encryptionKey: key });
				const row = await again.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
				expect(row).toEqual(jasmine.objectContaining({ val: 'hidden' }));
				await again.close();
			},
			TIMEOUT,
		);

		// Unreadability is what tells a codec apart from an engine that accepts
		// `PRAGMA key` and writes plaintext.
		it(
			'cannot be read without the key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_passphrase_nokey.db');
				await writeSecret({ path, encryptionKey: key }, 'hidden');

				expect(await canRead(path)).toBeFalse();
			},
			TIMEOUT,
		);

		it(
			'cannot be read with a wrong key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_passphrase_wrongkey.db');
				await writeSecret({ path, encryptionKey: key }, 'hidden');

				expect(await canRead(path, 'the-wrong-key')).toBeFalse();
			},
			TIMEOUT,
		);
	});

	describe('a raw-keyed database', () => {
		const rawKey = '0123456789abcdef'.repeat(4);

		it(
			'keeps its data across close and reopen with the same raw key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_raw_roundtrip.db');
				await writeSecret({ path, encryptionKey: rawKey, encryptionKeyFormat: 'raw' }, 'raw');

				const again = open({ path, encryptionKey: rawKey, encryptionKeyFormat: 'raw' });
				const row = await again.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
				expect(row).toEqual(jasmine.objectContaining({ val: 'raw' }));
				await again.close();
			},
			TIMEOUT,
		);

		it(
			'cannot be read with the same characters as a passphrase',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_raw_as_passphrase.db');
				await writeSecret({ path, encryptionKey: rawKey, encryptionKeyFormat: 'raw' }, 'raw');

				expect(await canRead(path, rawKey)).toBeFalse();
			},
			TIMEOUT,
		);
	});

	describe('the JavaScript-thread cost of a keyed open', () => {
		const key = 'latency-probe-key';

		/** Milliseconds `openDatabase()` itself blocks the JS thread for. */
		async function measureOpen(options: DatabaseOptions): Promise<number> {
			const t0 = Date.now();
			const db = openDatabase(options);
			const ms = Date.now() - t0;
			opened.push(db);
			await db.initialized();
			await db.execute(`CREATE TABLE IF NOT EXISTS k (x INTEGER)`);
			await db.close();
			return ms;
		}

		// Readers are keyed on their own threads, so only the writer's derivation
		// lands on the JS thread whatever the pool size.
		it(
			'does not grow with the pool size',
			async () => {
				await requireSQLCipher();
				const pool4 = await measureOpen({ path: dbPath('spec_cipher_lat_pool4.db'), encryptionKey: key, poolSize: 4 });
				const pool1 = await measureOpen({ path: dbPath('spec_cipher_lat_pool1.db'), encryptionKey: key, poolSize: 1 });

				expect(pool4).toBeLessThan(pool1 * 2 + 100);
			},
			TIMEOUT,
		);

		it(
			'keeps every derivation off the JS thread with asyncOpen',
			async () => {
				await requireSQLCipher();
				const ms = await measureOpen({ path: dbPath('spec_cipher_lat_async4.db'), encryptionKey: key, poolSize: 4, asyncOpen: true });

				expect(ms).toBeLessThan(50);
			},
			TIMEOUT,
		);
	});

	describe('a wrong key', () => {
		const key = 'latency-probe-key';
		const wrongKey = 'not-the-key';

		async function seed(name: string): Promise<string> {
			const path = dbPath(name);
			const db = open({ path, encryptionKey: key, poolSize: 1 });
			await db.execute(`CREATE TABLE k (x INTEGER)`);
			await db.close();
			return path;
		}

		it(
			'throws SQLITE_NOTADB from openDatabase in the default mode',
			async () => {
				await requireSQLCipher();
				const path = await seed('spec_cipher_wrong_sync.db');

				expect(() => open({ path, encryptionKey: wrongKey, poolSize: 1 })).toThrow(jasmine.objectContaining({ code: SQLITE_NOTADB }));
			},
			TIMEOUT,
		);

		it(
			'rejects initialized() with SQLITE_NOTADB under asyncOpen',
			async () => {
				await requireSQLCipher();
				const path = await seed('spec_cipher_wrong_async_init.db');

				const bad = open({ path, encryptionKey: wrongKey, poolSize: 1, asyncOpen: true });
				await expectAsync(bad.initialized()).toBeRejectedWith(jasmine.objectContaining({ code: SQLITE_NOTADB }));
				await bad.close();
			},
			TIMEOUT,
		);

		it(
			'makes sync methods throw the open error once an asyncOpen has failed',
			async () => {
				await requireSQLCipher();
				const path = await seed('spec_cipher_wrong_async_sync.db');

				const bad = open({ path, encryptionKey: wrongKey, poolSize: 1, asyncOpen: true });
				await bad.initialized().catch(() => undefined);
				expect(() => bad.getSync(`SELECT 1`)).toThrow(jasmine.objectContaining({ code: SQLITE_NOTADB }));
				await bad.close();
			},
			TIMEOUT,
		);

		it(
			'makes async methods reject with the open error once an asyncOpen has failed',
			async () => {
				await requireSQLCipher();
				const path = await seed('spec_cipher_wrong_async_exec.db');

				const bad = open({ path, encryptionKey: wrongKey, poolSize: 1, asyncOpen: true });
				await bad.initialized().catch(() => undefined);
				await expectAsync(bad.execute(`SELECT 1`)).toBeRejectedWith(jasmine.objectContaining({ code: SQLITE_NOTADB }));
				await bad.close();
			},
			TIMEOUT,
		);

		// The read lands on a reader the pool never started; it has to report why
		// the database could not be opened, not that it is closed.
		it(
			'rejects a pooled read issued before the failing asyncOpen settles with the open error',
			async () => {
				await requireSQLCipher();
				const path = await seed('spec_cipher_wrong_async_pooled.db');

				const bad = open({ path, encryptionKey: wrongKey, poolSize: 2, asyncOpen: true });
				await expectAsync(bad.select(`SELECT 1`)).toBeRejectedWith(jasmine.objectContaining({ code: SQLITE_NOTADB }));
				await bad.close();
			},
			TIMEOUT,
		);
	});

	describe('an openSequence step before the key', () => {
		const key = 'sequence-cipher-key';
		// A non-default cipher has to be selected before the key is applied, so a
		// database written this way only reopens if the step really ran first.
		const sequence = [{ sql: "PRAGMA cipher = 'chacha20'" }, OpenStep.key, OpenStep.wal];

		it(
			'reopens the database under the same sequence and key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_seq_reopen.db');
				await writeSecret({ path, encryptionKey: key, openSequence: sequence, serialized: true }, 'hidden');

				const again = open({ path, encryptionKey: key, openSequence: sequence, serialized: true });
				const row = await again.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
				expect(row).toEqual(jasmine.objectContaining({ val: 'hidden' }));
				await again.close();
			},
			TIMEOUT,
		);

		it(
			'produces a database the default sequence cannot read with the same key',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_seq_default.db');
				await writeSecret({ path, encryptionKey: key, openSequence: sequence, serialized: true }, 'hidden');

				expect(await canRead(path, key)).toBeFalse();
			},
			TIMEOUT,
		);

		it(
			'keeps the key out of the error when the key step fails',
			async () => {
				await requireSQLCipher();
				const path = dbPath('spec_cipher_seq_wrongkey.db');
				await writeSecret({ path, encryptionKey: key, openSequence: sequence, serialized: true }, 'hidden');

				const wrongKey = 'the-wrong-key-entirely';
				let error: Error | undefined;
				try {
					open({ path, encryptionKey: wrongKey, openSequence: sequence, serialized: true });
				} catch (e) {
					error = e as Error;
				}
				expect(error).withContext('a wrong key should still fail the open').toBeDefined();
				expect(error?.message).toEqual(jasmine.any(String));
				expect(error?.message).not.toContain(wrongKey);
			},
			TIMEOUT,
		);
	});
});
