import { File, knownFolders } from '@nativescript/core';
import { openDatabase, SQLiteDatabase } from '@edusperoni/nativescript-sqlite';
import { DemoSharedNativescriptSqlite } from '../index';
import { getClock } from '../benchmark/harness';

// logcat drops the tail of long lines, so the JSON is emitted in chunks well under that limit.
const LOG_CHUNK = 3000;

const SQLCIPHER_COMPILE_OPTION = 'EXTRA_INIT=sqlcipher_extra_init';

export interface RunCorrectnessTestsOptions {
	label?: string;
}

export interface TestCaseResult {
	name: string;
	status: 'passed' | 'failed' | 'skipped';
	passed: boolean;
	durationMs: number;
	error?: string;
	stack?: string;
}

export interface TestFailure {
	name: string;
	error: string;
	stack?: string;
}

export interface TestSuiteResult {
	schema: 1;
	label: string;
	startedAt: string;
	durationMs: number;
	sqlcipher: boolean;
	passed: boolean;
	failures: TestFailure[];
	cases: TestCaseResult[];
	log: string[];
}

interface TestEntry {
	name: string;
	requiresSQLCipher?: boolean;
	run(): Promise<void>;
}

function sanitizeLabel(label: string): string {
	const cleaned = label.replace(/[^A-Za-z0-9._-]/g, '-');
	return cleaned.length > 0 ? cleaned : 'run';
}

function describeError(err: unknown): { message: string; stack: string } {
	return {
		message: err && (err as Error).message ? (err as Error).message : String(err),
		stack: err && (err as Error).stack ? (err as Error).stack : '',
	};
}

function round(value: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

function formatLogArg(arg: unknown): string {
	if (typeof arg === 'string') return arg;
	if (arg === null || typeof arg !== 'object') return String(arg);
	try {
		return JSON.stringify(arg);
	} catch (err) {
		return String(arg);
	}
}

function buildTests(demo: DemoSharedNativescriptSqlite): TestEntry[] {
	return [
		{ name: 'testCRUD', run: () => demo.testCRUD() },
		{ name: 'testDataTypes', run: () => demo.testDataTypes() },
		{ name: 'testParams', run: () => demo.testParams() },
		{ name: 'testSelectArray', run: () => demo.testSelectArray() },
		{ name: 'testTransactions', run: () => demo.testTransactions() },
		{ name: 'testPreparedStatements', run: () => demo.testPreparedStatements() },
		{ name: 'testSyncAPI', run: () => demo.testSyncAPI() },
		{ name: 'testErrorHandling', run: () => demo.testErrorHandling() },
		{ name: 'testRuntimeInfo', run: () => demo.testRuntimeInfo() },
		{ name: 'testInMemoryDB', run: () => demo.testInMemoryDB() },
		{ name: 'testLowLevelTransactions', run: () => demo.testLowLevelTransactions() },
		{ name: 'testSQLCipher', requiresSQLCipher: true, run: () => demo.testSQLCipher() },
	];
}

// A plain SQLite build silently ignores `PRAGMA key`, so the encryption test would pass without encrypting anything.
async function detectSQLCipher(): Promise<boolean> {
	let probe: SQLiteDatabase;
	try {
		probe = openDatabase({ path: ':memory:' });
	} catch (err) {
		return false;
	}
	try {
		return probe.getRuntimeInfo().compileOptions.includes(SQLCIPHER_COMPILE_OPTION);
	} catch (err) {
		return false;
	} finally {
		try {
			await probe.close();
		} catch (closeErr) {
			/* the probe database is disposable */
		}
	}
}

export async function runCorrectnessTests(opts?: RunCorrectnessTestsOptions): Promise<TestSuiteResult> {
	const options = opts || {};
	const label = sanitizeLabel(options.label || 'tests');

	try {
		const clock = getClock();
		const startedAt = new Date().toISOString();
		const sqlcipher = await detectSQLCipher();

		const demo = new DemoSharedNativescriptSqlite();
		const tests = buildTests(demo);
		console.log(`[NSCTEST] start label=${label} tests=${tests.length} sqlcipher=${sqlcipher}`);

		const log: string[] = [];
		const cases: TestCaseResult[] = [];
		const prevVerbose = demo.verbose;
		const originalLog = console.log;
		const suiteStart = clock.now();

		demo.verbose = false;
		console.log = function (...args: unknown[]) {
			log.push(args.map(formatLogArg).join(' '));
			originalLog.apply(console, args);
		};
		try {
			for (let i = 0; i < tests.length; i++) {
				const test = tests[i];
				if (test.requiresSQLCipher && !sqlcipher) {
					cases.push({ name: test.name, status: 'skipped', passed: false, durationMs: 0 });
					originalLog(`[NSCTEST] ${test.name} skipped`);
					continue;
				}

				const start = clock.now();
				try {
					await test.run();
					const durationMs = round(clock.now() - start, 3);
					cases.push({ name: test.name, status: 'passed', passed: true, durationMs });
					originalLog(`[NSCTEST] ${test.name} passed ${durationMs}ms`);
				} catch (err) {
					const durationMs = round(clock.now() - start, 3);
					const described = describeError(err);
					cases.push({ name: test.name, status: 'failed', passed: false, durationMs, error: described.message, stack: described.stack });
					originalLog(`[NSCTEST] ${test.name} FAILED ${described.message}`);
				}
			}
		} finally {
			console.log = originalLog;
			demo.verbose = prevVerbose;
		}

		const failures: TestFailure[] = cases.filter((c) => c.status === 'failed').map((c) => ({ name: c.name, error: c.error || '', stack: c.stack }));
		const result: TestSuiteResult = {
			schema: 1,
			label,
			startedAt,
			durationMs: round(clock.now() - suiteStart, 3),
			sqlcipher,
			passed: failures.length === 0,
			failures,
			cases,
			log,
		};
		const json = JSON.stringify(result);

		const filePath = knownFolders.documents().path + '/nscsqlite-test-' + label + '.json';
		await File.fromPath(filePath).writeText(json);

		const total = Math.max(1, Math.ceil(json.length / LOG_CHUNK));
		for (let i = 0; i < total; i++) {
			console.log(`[NSCTEST_JSON ${i + 1}/${total}] ${json.substring(i * LOG_CHUNK, (i + 1) * LOG_CHUNK)}`);
		}
		console.log(`[NSCTEST] ${result.passed ? 'PASSED' : 'FAILED'} failures=${failures.length} of ${cases.length}`);
		console.log(`[NSCTEST_DONE] ${filePath}`);

		return result;
	} catch (err) {
		const { message, stack } = describeError(err);
		console.log(`[NSCTEST_ERROR] ${message}\n${stack}`);
		// Release builds drop console output, so the failure also has to be observable as a file.
		try {
			File.fromPath(knownFolders.documents().path + '/nscsqlite-test-' + label + '.error.txt').writeTextSync(`${message}\n${stack}`);
		} catch (writeErr) {
			/* nothing else to report through */
		}
		throw err;
	}
}
