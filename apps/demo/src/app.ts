import { Application } from '@nativescript/core';
import { runBenchmarks, RunBenchmarksOptions } from '../../../tools/demo/nativescript-sqlite/benchmark';
import { runCorrectnessTests, RunCorrectnessTestsOptions } from '../../../tools/demo/nativescript-sqlite/test-suite';
import { runEncryptedWalTest, RunEncryptedWalOptions } from '../../../tools/demo/nativescript-sqlite/encrypted-wal';

const BENCH_START_DELAY_MS = 1500;
const BENCH_LAUNCH_FALLBACK_MS = 6000;

type BenchRequest = { mode: 'full' | 'quick'; options: RunBenchmarksOptions } | { mode: 'test'; options: RunCorrectnessTestsOptions } | { mode: 'encwal'; options: RunEncryptedWalOptions };

/** The three values each platform carries, before they are checked. */
interface BenchArgs {
	mode: string | null;
	label?: string;
	filter?: string;
}

function readAndroidArgs(): BenchArgs | null {
	const androidApp = Application.android;
	const activity = androidApp.foregroundActivity || androidApp.startActivity;
	const intent = activity && activity.getIntent();
	if (!intent) return null;
	return {
		mode: intent.getStringExtra('nscbench'),
		label: intent.getStringExtra('nscbenchLabel') || undefined,
		filter: intent.getStringExtra('nscbenchFilter') || undefined,
	};
}

function readIOSArgs(): BenchArgs | null {
	if (typeof NSProcessInfo === 'undefined') return null;
	const argv = NSProcessInfo.processInfo.arguments;
	const flag = (name: string): string | undefined => {
		for (let i = 0; i + 1 < argv.count; i++) {
			if (argv.objectAtIndex(i) === name) return argv.objectAtIndex(i + 1) || undefined;
		}
		return undefined;
	};
	return {
		mode: flag('-nscbench') ?? null,
		label: flag('-nscbenchLabel'),
		filter: flag('-nscbenchFilter'),
	};
}

function readBenchRequest(): BenchRequest | null {
	try {
		const args = Application.android ? readAndroidArgs() : readIOSArgs();
		if (!args) return null;
		const mode = args.mode;
		if (mode !== 'full' && mode !== 'quick' && mode !== 'test' && mode !== 'encwal') return null;
		if (mode === 'test' || mode === 'encwal') return { mode, options: { label: args.label } };
		return {
			mode,
			options: {
				quick: mode === 'quick',
				label: args.label,
				filter: args.filter,
			},
		};
	} catch (err) {
		return null;
	}
}

let benchScheduled = false;
function scheduleBench() {
	if (benchScheduled) return;
	benchScheduled = true;
	setTimeout(() => {
		const request = readBenchRequest();
		if (!request) return;
		let run: Promise<unknown>;
		if (request.mode === 'test') run = runCorrectnessTests(request.options);
		else if (request.mode === 'encwal') run = runEncryptedWalTest(request.options);
		else run = runBenchmarks(request.options);
		run.catch(() => {
			/* the runner already logged its [NSCBENCH_ERROR]/[NSCTEST_ERROR]/[NSCENCWAL_ERROR] line */
		});
	}, BENCH_START_DELAY_MS);
}

Application.on(Application.displayedEvent, scheduleBench);
// Not every root view emits `displayed`; without this fallback an adb-triggered run could never start.
Application.on(Application.launchEvent, () => setTimeout(scheduleBench, BENCH_LAUNCH_FALLBACK_MS));

Application.run({ moduleName: 'app-root' });
