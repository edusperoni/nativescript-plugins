import { Application } from '@nativescript/core';
import { runBenchmarks, RunBenchmarksOptions } from '../../../tools/demo/nativescript-sqlite/benchmark';

const BENCH_START_DELAY_MS = 1500;
const BENCH_LAUNCH_FALLBACK_MS = 6000;

function readBenchRequest(): RunBenchmarksOptions | null {
	try {
		const androidApp = Application.android;
		if (!androidApp) return null;
		const activity = androidApp.foregroundActivity || androidApp.startActivity;
		const intent = activity && activity.getIntent();
		if (!intent) return null;
		const mode = intent.getStringExtra('nscbench');
		if (mode !== 'full' && mode !== 'quick') return null;
		return {
			quick: mode === 'quick',
			label: intent.getStringExtra('nscbenchLabel') || undefined,
			filter: intent.getStringExtra('nscbenchFilter') || undefined,
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
		runBenchmarks(request).catch(() => {
			/* runBenchmarks already logged [NSCBENCH_ERROR] */
		});
	}, BENCH_START_DELAY_MS);
}

Application.on(Application.displayedEvent, scheduleBench);
// Not every root view emits `displayed`; without this fallback an adb-triggered run could never start.
Application.on(Application.launchEvent, () => setTimeout(scheduleBench, BENCH_LAUNCH_FALLBACK_MS));

Application.run({ moduleName: 'app-root' });
