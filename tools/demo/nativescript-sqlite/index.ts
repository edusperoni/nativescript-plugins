import { DemoSharedBase } from '../utils';
import { runBenchmarks } from './benchmark';

export { runBenchmarks } from './benchmark';
export type { RunBenchmarksOptions } from './benchmark';

export class DemoSharedNativescriptSqlite extends DemoSharedBase {
	async benchmarkAll() {
		await runBenchmarks();
	}

	async benchmarkQuick() {
		await runBenchmarks({ quick: true });
	}
}
