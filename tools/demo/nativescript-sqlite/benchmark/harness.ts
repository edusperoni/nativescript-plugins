declare const global: any;

export interface BenchClock {
	name: string;
	now(): number;
}

export interface BenchOptions {
	group: string;
	opsPerSample: number;
	warmup: number;
	samples: number;
	setup?(): void | Promise<void>;
	beforeEach?(): void | Promise<void>;
	fn(): void | Promise<void>;
	afterEach?(): void | Promise<void>;
	teardown?(): void | Promise<void>;
}

export interface BenchCase extends BenchOptions {
	name: string;
}

export interface CaseResult {
	name: string;
	group: string;
	opsPerSample: number;
	warmup: number;
	samples: number[];
	min: number;
	max: number;
	mean: number;
	median: number;
	p95: number;
	stddev: number;
	opsPerSec: number;
}

export interface BenchResult {
	schema: 1;
	label: string;
	startedAt: string;
	clock: string;
	meta: Record<string, unknown>;
	cases: CaseResult[];
}

let resolvedClock: BenchClock | null = null;

export function getClock(): BenchClock {
	if (resolvedClock) return resolvedClock;
	const g = global;
	if (g.performance && typeof g.performance.now === 'function') {
		const perf = g.performance;
		resolvedClock = { name: 'performance.now', now: () => perf.now() };
	} else if (typeof g.__time === 'function') {
		resolvedClock = { name: 'global.__time', now: () => g.__time() };
	} else if (g.java && g.java.lang && g.java.lang.System && typeof g.java.lang.System.nanoTime === 'function') {
		const system = g.java.lang.System;
		resolvedClock = { name: 'java.lang.System.nanoTime', now: () => system.nanoTime() / 1e6 };
	} else {
		resolvedClock = { name: 'Date.now', now: () => Date.now() };
	}
	return resolvedClock;
}

function yieldToLoop(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function collectGarbage() {
	if (typeof global.gc === 'function') global.gc();
}

function round(value: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], fraction: number): number {
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarize(name: string, options: BenchOptions, durations: number[]): CaseResult {
	const sorted = durations.slice().sort((a, b) => a - b);
	const count = sorted.length;
	let sum = 0;
	for (let i = 0; i < count; i++) sum += sorted[i];
	const mean = count > 0 ? sum / count : 0;
	const median = count === 0 ? 0 : count % 2 === 1 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
	let variance = 0;
	if (count > 1) {
		let squares = 0;
		for (let i = 0; i < count; i++) squares += (sorted[i] - mean) * (sorted[i] - mean);
		variance = squares / (count - 1);
	}

	return {
		name,
		group: options.group,
		opsPerSample: options.opsPerSample,
		warmup: options.warmup,
		samples: durations.map((d) => round(d, 3)),
		min: count > 0 ? round(sorted[0], 3) : 0,
		max: count > 0 ? round(sorted[count - 1], 3) : 0,
		mean: round(mean, 3),
		median: round(median, 3),
		p95: count > 0 ? round(percentile(sorted, 0.95), 3) : 0,
		stddev: round(Math.sqrt(variance), 3),
		opsPerSec: median > 0 ? round((options.opsPerSample * 1000) / median, 2) : 0,
	};
}

export async function bench(name: string, options: BenchOptions): Promise<CaseResult> {
	const clock = getClock();
	const durations: number[] = [];

	if (options.setup) await options.setup();
	try {
		for (let i = 0; i < options.warmup; i++) {
			if (options.beforeEach) await options.beforeEach();
			await options.fn();
			if (options.afterEach) await options.afterEach();
		}
		for (let i = 0; i < options.samples; i++) {
			if (options.beforeEach) await options.beforeEach();
			collectGarbage();
			const start = clock.now();
			await options.fn();
			durations.push(clock.now() - start);
			if (options.afterEach) await options.afterEach();
			await yieldToLoop();
		}
	} finally {
		if (options.teardown) await options.teardown();
	}

	return summarize(name, options, durations);
}
