import { Application } from '@nativescript/core';
import { runBenchmarks, RunBenchmarksOptions } from '../../../tools/demo/nativescript-sqlite/benchmark';
import { runCorrectnessTests, RunCorrectnessTestsOptions } from '../../../tools/demo/nativescript-sqlite/test-suite';

const BENCH_START_DELAY_MS = 1500;
const BENCH_LAUNCH_FALLBACK_MS = 6000;

type BenchRequest = { mode: 'full' | 'quick'; options: RunBenchmarksOptions } | { mode: 'test'; options: RunCorrectnessTestsOptions };

function readBenchRequest(): BenchRequest | null {
	try {
		const androidApp = Application.android;
		if (!androidApp) return null;
		const activity = androidApp.foregroundActivity || androidApp.startActivity;
		const intent = activity && activity.getIntent();
		if (!intent) return null;
		const mode = intent.getStringExtra('nscbench');
		if (mode !== 'full' && mode !== 'quick' && mode !== 'test') return null;
		const label = intent.getStringExtra('nscbenchLabel') || undefined;
		if (mode === 'test') return { mode, options: { label } };
		return {
			mode,
			options: {
				quick: mode === 'quick',
				label,
				filter: intent.getStringExtra('nscbenchFilter') || undefined,
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
		const run: Promise<unknown> = request.mode === 'test' ? runCorrectnessTests(request.options) : runBenchmarks(request.options);
		run.catch(() => {
			/* the runner already logged its [NSCBENCH_ERROR]/[NSCTEST_ERROR] line */
		});
	}, BENCH_START_DELAY_MS);
}

Application.on(Application.displayedEvent, scheduleBench);
// Not every root view emits `displayed`; without this fallback an adb-triggered run could never start.
Application.on(Application.launchEvent, () => setTimeout(scheduleBench, BENCH_LAUNCH_FALLBACK_MS));

Application.run({ moduleName: 'app-root' });
