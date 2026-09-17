import { Device, File, knownFolders } from '@nativescript/core';
import { openDatabase } from '@edusperoni/nativescript-sqlite';
import { bench, BenchCase, BenchResult, CaseResult, getClock } from './harness';
import { buildCases, CONCURRENCY_POOL_SIZE } from './cases';

declare const global: any;

// logcat drops the tail of long lines, so the JSON is emitted in chunks well under that limit.
const LOG_CHUNK = 3000;

export { bench, buildCases };
export type { BenchCase, BenchResult, CaseResult };

export interface RunBenchmarksOptions {
	label?: string;
	quick?: boolean;
	filter?: string;
}

function sanitizeLabel(label: string): string {
	const cleaned = label.replace(/[^A-Za-z0-9._-]/g, '-');
	return cleaned.length > 0 ? cleaned : 'run';
}

async function collectMeta(quick: boolean, filter?: string): Promise<Record<string, unknown>> {
	const meta: Record<string, unknown> = {
		quick,
		filter: filter || null,
		clock: getClock().name,
		gcAvailable: typeof global.gc === 'function',
		runtimeVersion: typeof global.__runtimeVersion === 'string' ? global.__runtimeVersion : null,
		poolSizes: { default: 1, concurrency: CONCURRENCY_POOL_SIZE },
	};

	try {
		meta.platform = Device.os;
		meta.deviceModel = Device.model;
		meta.deviceManufacturer = Device.manufacturer;
		meta.osVersion = Device.osVersion;
		meta.sdkVersion = Device.sdkVersion;
	} catch (err) {
		meta.deviceError = String(err);
	}

	const probe = openDatabase({ path: ':memory:' });
	try {
		const info = probe.getRuntimeInfo();
		meta.sqliteVersion = info.version;
		meta.sqliteSourceId = info.sourceId;
		meta.sqliteCompileOptions = info.compileOptions;
	} finally {
		await probe.close();
	}

	return meta;
}

export async function runBenchmarks(opts?: RunBenchmarksOptions): Promise<BenchResult> {
	const options = opts || {};
	const quick = options.quick === true;
	const label = sanitizeLabel(options.label || (quick ? 'quick' : 'full'));

	try {
		const clock = getClock();
		const startedAt = new Date().toISOString();
		const meta = await collectMeta(quick, options.filter);

		const all = buildCases(quick);
		const filter = options.filter;
		const selected = filter ? all.filter((c) => c.name.indexOf(filter) !== -1 || c.group.indexOf(filter) !== -1) : all;

		console.log(`[NSCBENCH] start label=${label} quick=${quick} cases=${selected.length} clock=${clock.name} sqlite=${meta.sqliteVersion}`);

		const cases: CaseResult[] = [];
		for (let i = 0; i < selected.length; i++) {
			const result = await bench(selected[i].name, selected[i]);
			cases.push(result);
			console.log(`[NSCBENCH] ${result.name} median=${result.median}ms p95=${result.p95}ms ops/s=${result.opsPerSec}`);
		}

		const result: BenchResult = { schema: 1, label, startedAt, clock: clock.name, meta, cases };
		const json = JSON.stringify(result);

		const filePath = knownFolders.documents().path + '/nscsqlite-bench-' + label + '.json';
		await File.fromPath(filePath).writeText(json);

		const total = Math.max(1, Math.ceil(json.length / LOG_CHUNK));
		for (let i = 0; i < total; i++) {
			console.log(`[NSCBENCH_JSON ${i + 1}/${total}] ${json.substring(i * LOG_CHUNK, (i + 1) * LOG_CHUNK)}`);
		}
		console.log(`[NSCBENCH_DONE] ${filePath}`);

		return result;
	} catch (err) {
		const message = err && (err as Error).message ? (err as Error).message : String(err);
		const stack = err && (err as Error).stack ? (err as Error).stack : '';
		console.log(`[NSCBENCH_ERROR] ${message}\n${stack}`);
		// Release builds drop console output, so the failure also has to be observable as a file.
		try {
			File.fromPath(knownFolders.documents().path + '/nscsqlite-bench-' + label + '.error.txt').writeTextSync(`${message}\n${stack}`);
		} catch (writeErr) {
			/* nothing else to report through */
		}
		throw err;
	}
}
