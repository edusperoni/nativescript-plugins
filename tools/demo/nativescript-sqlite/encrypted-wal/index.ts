import { File, knownFolders } from '@nativescript/core';
import { openDatabase, SQLiteDatabase } from '@edusperoni/nativescript-sqlite';
import { getClock } from '../benchmark/harness';

// logcat drops the tail of long lines, so the JSON is emitted in chunks well under that limit.
const LOG_CHUNK = 3000;

const KEY = 'hunter2';
const BULK_ROWS = 5000;
const WRITER_BATCHES = 40;
const WRITER_ROWS_PER_BATCH = 50;
const READS_PER_BATCH = 20;
const MIN_READS = 400;

export interface RunEncryptedWalOptions {
	label?: string;
}

/**
 * What the SQLite this build linked does with `encryptionKey`.
 *
 * `refused` is the plugin's own bundled preset, which knows at compile time
 * that it has no codec. `plaintext` is any other codec-less engine: it accepts
 * the key and writes a readable database, which is the trap the README warns
 * about and which the plugin cannot detect for an app-provided engine.
 */
type CodecMode = 'codec' | 'refused' | 'plaintext';

interface StepRecord {
	step: string;
	ok: boolean;
	ms: number;
	detail?: unknown;
	error?: string;
	code?: unknown;
	stack?: string;
}

export interface EncryptedWalResult {
	schema: 1;
	label: string;
	startedAt: string;
	durationMs: number;
	codecMode: CodecMode;
	passed: boolean;
	failures: string[];
	steps: StepRecord[];
	timings: Record<string, number>;
}

function sanitizeLabel(label: string): string {
	const cleaned = label.replace(/[^A-Za-z0-9._-]/g, '-');
	return cleaned.length > 0 ? cleaned : 'run';
}

function describeError(err: unknown): { message: string; code: unknown; stack: string } {
	const e = err as any;
	return {
		message: e && e.message ? String(e.message) : String(err),
		code: e && e.code !== undefined ? e.code : null,
		stack: e && e.stack ? String(e.stack) : '',
	};
}

function round(value: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function removeIfPresent(path: string): void {
	try {
		if (File.exists(path)) {
			File.fromPath(path).removeSync(() => {
				/* a leftover that cannot be removed shows up as a failing assertion later */
			});
		}
	} catch (err) {
		/* same */
	}
}

async function closeQuietly(db: SQLiteDatabase | undefined): Promise<void> {
	if (!db) return;
	try {
		await db.close();
	} catch (err) {
		/* a handle that refuses to close is reported by the step that owns it */
	}
}

function removeDatabaseFiles(path: string): void {
	removeIfPresent(path);
	removeIfPresent(`${path}-wal`);
	removeIfPresent(`${path}-shm`);
}

/**
 * Establishes what this build does with a key, by behaviour rather than by
 * compile options: no pragma or compile option identifies a codec across
 * engines, but whether a keyed database is unreadable without its key does.
 */
async function probeCodec(path: string): Promise<{ mode: CodecMode; openError: { message: string; code: unknown } | null }> {
	removeDatabaseFiles(path);

	let keyed: SQLiteDatabase | undefined;
	try {
		keyed = openDatabase({ path, encryptionKey: KEY, poolSize: 1 });
		await keyed.execute('CREATE TABLE probe (x INTEGER)');
	} catch (err) {
		await closeQuietly(keyed);
		removeDatabaseFiles(path);
		return { mode: 'refused', openError: describeError(err) };
	}
	await closeQuietly(keyed);

	let plain: SQLiteDatabase | undefined;
	let mode: CodecMode = 'codec';
	try {
		plain = openDatabase({ path, poolSize: 1 });
		await plain.select('SELECT x FROM probe');
		mode = 'plaintext';
	} catch (err) {
		mode = 'codec';
	}
	await closeQuietly(plain);
	removeDatabaseFiles(path);
	return { mode, openError: null };
}

export async function runEncryptedWalTest(opts?: RunEncryptedWalOptions): Promise<EncryptedWalResult> {
	const options = opts || {};
	const label = sanitizeLabel(options.label || 'encwal');
	const clock = getClock();
	const startedAt = new Date().toISOString();
	const suiteStart = clock.now();

	const steps: StepRecord[] = [];
	const failures: string[] = [];
	const timings: Record<string, number> = {};
	let codecMode: CodecMode = 'plaintext';

	async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
		const t0 = clock.now();
		try {
			const value = await fn();
			const ms = round(clock.now() - t0, 2);
			steps.push({ step: name, ok: true, ms, detail: value === undefined ? null : value });
			console.log(`[NSCENCWAL] ${name} ok ${ms}ms`);
			return value;
		} catch (err) {
			const ms = round(clock.now() - t0, 2);
			const described = describeError(err);
			steps.push({ step: name, ok: false, ms, error: described.message, code: described.code, stack: described.stack });
			failures.push(`${name}: ${described.message}`);
			console.log(`[NSCENCWAL] ${name} FAILED ${described.message}`);
			return undefined;
		}
	}

	try {
		const docs = knownFolders.documents().path;
		const dbPath = `${docs}/enc_wal.db`;
		const plainPath = `${docs}/plain_ctl.db`;
		const scPath = `${docs}/sc_pass.db`;

		let db: SQLiteDatabase | undefined;

		// ── A. Capability ────────────────────────────────────────────────────

		await step('A.runtimeInfo', async () => {
			const probe = openDatabase({ path: ':memory:', poolSize: 1 });
			try {
				const info = probe.getRuntimeInfo();
				return {
					version: info.version,
					sourceId: info.sourceId,
					compileOptionCount: info.compileOptions.length,
					compileOptions: info.compileOptions,
				};
			} finally {
				await closeQuietly(probe);
			}
		});

		const capability = await step('A.codecCapability', async () => {
			const probe = await probeCodec(`${docs}/codec_probe.db`);
			if (probe.mode === 'refused') {
				// The bundled preset is the only engine the plugin knows to be
				// codec-less, and the refusal has to name it so the message is
				// actionable rather than just a failed open.
				assert(/bundled SQLite/.test(probe.openError.message), `a keyed open was refused, but not by the bundled-SQLite guard: ${probe.openError.message}`);
			}
			return probe;
		});
		codecMode = capability ? capability.mode : 'plaintext';

		const keyed = codecMode === 'codec';
		// Everything but the key stays the same on a codec-less build, so WAL,
		// the reader pool and durability are still exercised there.
		const openKeyed = (extra: Record<string, unknown>) => openDatabase((keyed ? { ...extra, encryptionKey: KEY } : extra) as any);
		const suffix = keyed ? 'key' : 'nokey';

		// ── B. Create the WAL database ───────────────────────────────────────
		await step('B.cleanup', () => {
			removeDatabaseFiles(dbPath);
			removeDatabaseFiles(plainPath);
			return { existsAfter: File.exists(dbPath) };
		});

		await step('B.open.pool4', async () => {
			const t0 = clock.now();
			db = openKeyed({ path: dbPath, poolSize: 4 });
			const opened = clock.now();
			const jm = await db.get<{ journal_mode: string }>('PRAGMA journal_mode');
			const firstQuery = clock.now();
			timings[`createOpenMs_${suffix}_pool4`] = round(opened - t0, 2);
			timings[`createFirstQueryMs_${suffix}_pool4`] = round(firstQuery - opened, 2);
			assert(!!jm && String(jm.journal_mode).toLowerCase() === 'wal', `journal_mode is ${jm && jm.journal_mode}, expected wal`);
			return { journalMode: jm.journal_mode, openMs: timings[`createOpenMs_${suffix}_pool4`], firstQueryMs: timings[`createFirstQueryMs_${suffix}_pool4`] };
		});

		await step('B.schema', async () => {
			await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
			await db.execute("INSERT INTO t VALUES (1,'hello'),(2,'ünïcödé')");
			await db.execute('CREATE VIRTUAL TABLE f USING fts5(body)');
			await db.execute("INSERT INTO f VALUES ('encrypted full text')");
			await db.execute('CREATE TABLE big(id INTEGER PRIMARY KEY, a TEXT, b REAL)');
			const t = await db.select<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id');
			const f = await db.select<{ body: string }>("SELECT body FROM f WHERE f MATCH 'encrypted'");
			assert(t.length === 2 && t[1].v === 'ünïcödé', `table t reads back as ${JSON.stringify(t)}`);
			assert(f.length === 1, `fts5 match returned ${f.length} rows`);
			return { t, f };
		});

		// ── C. Concurrency under encryption + WAL ────────────────────────────
		await step('C.bulkInsert', async () => {
			const t0 = clock.now();
			await db.transaction(async (tx) => {
				for (let i = 1; i <= BULK_ROWS; i++) {
					await tx.execute('INSERT INTO big(id, a, b) VALUES (?, ?, ?)', [i, `row-${i}`, i * 1.5]);
				}
			});
			const ms = round(clock.now() - t0, 2);
			timings.bulkInsertMs = ms;
			const row = await db.get<{ n: number }>('SELECT count(*) AS n FROM big');
			assert(row.n === BULK_ROWS, `big has ${row.n} rows, expected ${BULK_ROWS}`);
			return { rows: BULK_ROWS, ms };
		});

		await step('C.concurrentWriterAndPooledReaders', async () => {
			let writerError: string | null = null;
			let writerDone = false;

			const writer = (async () => {
				for (let b = 0; b < WRITER_BATCHES; b++) {
					await db.transaction(async (tx) => {
						for (let j = 0; j < WRITER_ROWS_PER_BATCH; j++) {
							const id = BULK_ROWS + b * WRITER_ROWS_PER_BATCH + j + 1;
							await tx.execute('INSERT INTO big(id, a, b) VALUES (?, ?, ?)', [id, `w-${id}`, id]);
						}
					});
				}
			})()
				.then(() => {
					writerDone = true;
				})
				.catch((err) => {
					writerDone = true;
					writerError = describeError(err).message;
				});

			const readErrors: string[] = [];
			const batchMins: number[] = [];
			const batchMaxs: number[] = [];
			let reads = 0;
			let monotonicViolations = 0;
			const t0 = clock.now();

			while (reads < MIN_READS || !writerDone) {
				const batch: Promise<number>[] = [];
				for (let k = 0; k < READS_PER_BATCH; k++) {
					batch.push(
						(async () => {
							const c = await db.get<{ n: number }>('SELECT count(*) AS n FROM big');
							const rows = await db.select<{ id: number; a: string; b: number }>('SELECT id, a, b FROM big WHERE id BETWEEN ? AND ? ORDER BY id', [11, 60]);
							if (rows.length !== 50) throw new Error(`range read returned ${rows.length} rows, expected 50`);
							if (rows[0].id !== 11 || rows[0].a !== 'row-11') throw new Error(`range read returned ${JSON.stringify(rows[0])}`);
							return c.n;
						})(),
					);
				}
				let values: number[];
				try {
					values = await Promise.all(batch);
				} catch (err) {
					readErrors.push(describeError(err).message);
					break;
				}
				reads += values.length;
				let min = values[0];
				let max = values[0];
				for (const v of values) {
					if (v < BULK_ROWS) readErrors.push(`count ${v} below the committed floor ${BULK_ROWS}`);
					if (v < min) min = v;
					if (v > max) max = v;
				}
				if (batchMaxs.length > 0 && min < batchMaxs[batchMaxs.length - 1]) monotonicViolations++;
				batchMins.push(min);
				batchMaxs.push(max);
			}

			await writer;
			const ms = round(clock.now() - t0, 2);
			timings.concurrentPhaseMs = ms;

			const expected = BULK_ROWS + WRITER_BATCHES * WRITER_ROWS_PER_BATCH;
			const final = await db.get<{ n: number }>('SELECT count(*) AS n FROM big');

			assert(writerError === null, `writer failed: ${writerError}`);
			assert(readErrors.length === 0, `reader errors: ${readErrors.slice(0, 5).join(' | ')}`);
			assert(monotonicViolations === 0, `${monotonicViolations} non-monotonic count observations`);
			assert(final.n === expected, `final count ${final.n}, expected ${expected}`);

			return { reads, batches: batchMins.length, firstCount: batchMins[0], lastCount: batchMaxs[batchMaxs.length - 1], finalCount: final.n, expected, ms };
		});

		await step('C.preparedStatement', async () => {
			const stmt = await db.prepare('SELECT count(*) AS n FROM big WHERE id <= ?');
			try {
				const a = await stmt.get<{ n: number }>([1000]);
				const b = await stmt.get<{ n: number }>([2500]);
				assert(a.n === 1000 && b.n === 2500, `prepared statement returned ${a.n}/${b.n}`);
				return { at1000: a.n, at2500: b.n };
			} finally {
				await stmt.finalize();
			}
		});

		await step('C.syncConnection', () => {
			const rows = db.selectSync<{ n: number }>('SELECT count(*) AS n FROM big');
			const one = db.getSync<{ v: string }>('SELECT v FROM t WHERE id = ?', [2]);
			const fts = db.selectSync<{ body: string }>("SELECT body FROM f WHERE f MATCH 'full'");
			assert(rows[0].n === BULK_ROWS + WRITER_BATCHES * WRITER_ROWS_PER_BATCH, `selectSync count ${rows[0].n}`);
			assert(!!one && one.v === 'ünïcödé', `getSync returned ${JSON.stringify(one)}`);
			assert(fts.length === 1, `selectSync fts5 returned ${fts.length} rows`);
			return { count: rows[0].n, unicode: one.v, ftsRows: fts.length };
		});

		// ── D. Durability ────────────────────────────────────────────────────
		await step('D.close', async () => {
			await db.close();
			db = undefined;
			return {
				dbExists: File.exists(dbPath),
				walExists: File.exists(`${dbPath}-wal`),
				shmExists: File.exists(`${dbPath}-shm`),
				walSize: File.exists(`${dbPath}-wal`) ? File.fromPath(`${dbPath}-wal`).size : 0,
				dbSize: File.exists(dbPath) ? File.fromPath(dbPath).size : 0,
			};
		});

		// Sampled again after a delay because the pool's connections are torn down on
		// their own threads: the sidecar files can outlive the resolved close promise.
		await step('D.closeSettled', async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
			return {
				walExists: File.exists(`${dbPath}-wal`),
				shmExists: File.exists(`${dbPath}-shm`),
				walSize: File.exists(`${dbPath}-wal`) ? File.fromPath(`${dbPath}-wal`).size : 0,
				dbSize: File.exists(dbPath) ? File.fromPath(dbPath).size : 0,
			};
		});

		await step('D.reopen.pool4', async () => {
			const t0 = clock.now();
			const re = openKeyed({ path: dbPath, poolSize: 4 });
			const opened = clock.now();
			try {
				const count = await re.get<{ n: number }>('SELECT count(*) AS n FROM big');
				const firstQuery = clock.now();
				timings[`reopenOpenMs_${suffix}_pool4`] = round(opened - t0, 2);
				timings[`reopenFirstQueryMs_${suffix}_pool4`] = round(firstQuery - opened, 2);
				const jm = await re.get<{ journal_mode: string }>('PRAGMA journal_mode');
				const integrity = await re.get('PRAGMA integrity_check');
				const t = await re.select<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id');
				const fts = await re.select<{ body: string }>("SELECT body FROM f WHERE f MATCH 'encrypted'");
				const integrityValue = integrity ? String(integrity[Object.keys(integrity)[0]]) : '';
				assert(count.n === BULK_ROWS + WRITER_BATCHES * WRITER_ROWS_PER_BATCH, `count after reopen ${count.n}`);
				assert(integrityValue === 'ok', `integrity_check = ${integrityValue}`);
				assert(t.length === 2 && t[1].v === 'ünïcödé', `table t after reopen ${JSON.stringify(t)}`);
				assert(fts.length === 1, `fts5 match after reopen returned ${fts.length} rows`);
				return {
					count: count.n,
					journalMode: jm.journal_mode,
					integrity: integrityValue,
					openMs: timings[`reopenOpenMs_${suffix}_pool4`],
					firstQueryMs: timings[`reopenFirstQueryMs_${suffix}_pool4`],
				};
			} finally {
				await closeQuietly(re);
			}
		});

		await step('D.reopen.pool1', async () => {
			const t0 = clock.now();
			const re = openKeyed({ path: dbPath, poolSize: 1 });
			const opened = clock.now();
			try {
				const count = await re.get<{ n: number }>('SELECT count(*) AS n FROM big');
				const firstQuery = clock.now();
				timings[`reopenOpenMs_${suffix}_pool1`] = round(opened - t0, 2);
				timings[`reopenFirstQueryMs_${suffix}_pool1`] = round(firstQuery - opened, 2);
				assert(count.n === BULK_ROWS + WRITER_BATCHES * WRITER_ROWS_PER_BATCH, `count with poolSize 1 ${count.n}`);
				return { count: count.n, openMs: timings[`reopenOpenMs_${suffix}_pool1`], firstQueryMs: timings[`reopenFirstQueryMs_${suffix}_pool1`] };
			} finally {
				await closeQuietly(re);
			}
		});

		if (keyed) {
			// A raw key is used as key material directly, so this open skips the
			// PBKDF2 derivation the passphrase form pays once per connection.
			await step('D.reopen.rawKey.pool4', async () => {
				const rawPath = `${docs}/enc_wal_raw.db`;
				removeDatabaseFiles(rawPath);
				const rawKey = '0123456789abcdef'.repeat(4);
				const create = openDatabase({ path: rawPath, encryptionKey: rawKey, encryptionKeyFormat: 'raw', poolSize: 4 });
				try {
					await create.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
					await create.execute("INSERT INTO t VALUES (1,'raw')");
				} finally {
					await closeQuietly(create);
				}
				const t0 = clock.now();
				const re = openDatabase({ path: rawPath, encryptionKey: rawKey, encryptionKeyFormat: 'raw', poolSize: 4 });
				const opened = clock.now();
				try {
					const row = await re.get<{ v: string }>('SELECT v FROM t WHERE id = 1');
					const firstQuery = clock.now();
					timings.reopenOpenMs_rawkey_pool4 = round(opened - t0, 2);
					timings.reopenFirstQueryMs_rawkey_pool4 = round(firstQuery - opened, 2);
					assert(!!row && row.v === 'raw', `raw-key reopen returned ${JSON.stringify(row)}`);
					return { openMs: timings.reopenOpenMs_rawkey_pool4, firstQueryMs: timings.reopenFirstQueryMs_rawkey_pool4 };
				} finally {
					await closeQuietly(re);
					removeDatabaseFiles(rawPath);
				}
			});
		}

		await step('D.open.plain.pool4.baseline', async () => {
			const t0 = clock.now();
			const plain = openDatabase({ path: plainPath, poolSize: 4 });
			const opened = clock.now();
			try {
				await plain.get('PRAGMA journal_mode');
				const firstQuery = clock.now();
				timings.plainOpenMs_nokey_pool4 = round(opened - t0, 2);
				timings.plainFirstQueryMs_nokey_pool4 = round(firstQuery - opened, 2);
				return { openMs: timings.plainOpenMs_nokey_pool4, firstQueryMs: timings.plainFirstQueryMs_nokey_pool4 };
			} finally {
				await closeQuietly(plain);
			}
		});

		// ── E. The key is load-bearing ───────────────────────────────────────
		const rejectedOpen = async (opts: Record<string, unknown>, what: string) => {
			let openError: { message: string; code: unknown } | null = null;
			let queryError: { message: string; code: unknown } | null = null;
			let readBack: unknown = null;
			let bad: SQLiteDatabase | undefined;
			try {
				bad = openDatabase(opts as any);
			} catch (err) {
				openError = describeError(err);
			}
			if (bad) {
				try {
					readBack = await bad.get('SELECT count(*) AS n FROM big');
				} catch (err) {
					queryError = describeError(err);
				}
				await closeQuietly(bad);
			}
			// Failing at the first query instead of at the open was the old Android
			// behaviour; iOS has always failed at the open and Android now matches.
			assert(openError !== null, queryError !== null ? `${what} only failed at the first query, not at the open: ${queryError.message}` : `${what} was accepted and returned ${JSON.stringify(readBack)}`);
			return { openError, queryError, readBack };
		};

		if (keyed) {
			await step('E.reopen.wrongKey.mustFail', () => rejectedOpen({ path: dbPath, encryptionKey: 'wrong-key-9000', poolSize: 1 }, 'a wrong key'));
			await step('E.reopen.noKey.mustFail', () => rejectedOpen({ path: dbPath, poolSize: 1 }, 'an unkeyed open'));
		}

		// ── F. Reverse direction: a database created by official SQLCipher ───
		if (keyed) {
			await step('F.readWriteHostSqlCipherDb', async () => {
				if (!File.exists(scPath)) {
					return { skipped: `no ${scPath} on device` };
				}
				const t0 = clock.now();
				const host = openDatabase({ path: scPath, encryptionKey: KEY, poolSize: 2 });
				const opened = clock.now();
				try {
					const t = await host.select<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id');
					const fts = await host.select<{ body: string }>("SELECT body FROM f WHERE f MATCH 'encrypted'");
					const jm = await host.get<{ journal_mode: string }>('PRAGMA journal_mode');
					assert(t.length === 2 && t[0].v === 'hello' && t[1].v === 'ünïcödé', `host db table t reads as ${JSON.stringify(t)}`);
					assert(fts.length === 1 && fts[0].body === 'encrypted full text', `host db fts5 reads as ${JSON.stringify(fts)}`);
					assert(String(jm.journal_mode).toLowerCase() === 'wal', `host db journal_mode is ${jm.journal_mode}, expected wal`);
					await host.execute("INSERT INTO t VALUES (3, 'written-on-device')");
					const after = await host.select<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id');
					assert(after.length === 3, `host db has ${after.length} rows after the insert`);
					timings.hostDbOpenMs_key_pool2 = round(opened - t0, 2);
					return { before: t, fts, journalMode: jm.journal_mode, after, openMs: timings.hostDbOpenMs_key_pool2 };
				} finally {
					await closeQuietly(host);
				}
			});
		}

		await step('F.hostDbFilesAfterClose', () => ({
			dbExists: File.exists(scPath),
			walExists: File.exists(`${scPath}-wal`),
			walSize: File.exists(`${scPath}-wal`) ? File.fromPath(`${scPath}-wal`).size : 0,
			shmExists: File.exists(`${scPath}-shm`),
		}));

		await closeQuietly(db);
	} catch (err) {
		const described = describeError(err);
		failures.push(`harness: ${described.message}`);
		steps.push({ step: 'harness', ok: false, ms: 0, error: described.message, code: described.code, stack: described.stack });
	}

	const result: EncryptedWalResult = {
		schema: 1,
		label,
		startedAt,
		durationMs: round(clock.now() - suiteStart, 2),
		codecMode,
		passed: failures.length === 0,
		failures,
		steps,
		timings,
	};

	const json = JSON.stringify(result);
	const filePath = `${knownFolders.documents().path}/nscsqlite-encwal-${label}.json`;
	try {
		await File.fromPath(filePath).writeText(json);
	} catch (writeErr) {
		console.log(`[NSCENCWAL_ERROR] could not write ${filePath}: ${describeError(writeErr).message}`);
	}

	const total = Math.max(1, Math.ceil(json.length / LOG_CHUNK));
	for (let i = 0; i < total; i++) {
		console.log(`[NSCENCWAL_JSON ${i + 1}/${total}] ${json.substring(i * LOG_CHUNK, (i + 1) * LOG_CHUNK)}`);
	}
	console.log(`[NSCENCWAL] ${result.passed ? 'PASSED' : 'FAILED'} codec=${codecMode} failures=${failures.length}`);
	console.log(`[NSCENCWAL_DONE] ${filePath}`);

	return result;
}
