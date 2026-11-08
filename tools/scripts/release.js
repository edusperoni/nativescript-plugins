// Releases a single package: version -> build -> changelog/commit/tag/push/GitHub release -> npm publish.
//
// `nx release --projects=<p>` can't be used directly: when filtering by project, nx skips task
// dependencies of nx-release-publish, so nothing would build, and the tag would already be pushed
// before we know the build works.
//
// Usage:
//   node tools/scripts/release.js --project nativescript-sqlite --specifier patch [--preid rc] [--tag next] [--dry-run]
//   node tools/scripts/release.js --project nativescript-sqlite --publish-only   # retry a failed npm publish
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { releaseVersion, releaseChangelog, releasePublish } = require('nx/release');

const { values: args } = parseArgs({
	options: {
		project: { type: 'string' },
		specifier: { type: 'string' },
		preid: { type: 'string' },
		tag: { type: 'string' },
		'dry-run': { type: 'boolean', default: false },
		'publish-only': { type: 'boolean', default: false },
		verbose: { type: 'boolean', default: false },
	},
});

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function build(project) {
	execFileSync('npx', ['nx', 'run', `${project}:build.all`], { stdio: 'inherit' });
}

function distTagFor(version) {
	if (args.tag) return args.tag;
	const pre = semver.prerelease(version);
	if (!pre) return 'latest';
	// 1.0.0-rc.1 -> "rc"; 1.0.0-0 -> "next"
	return typeof pre[0] === 'string' ? pre[0] : 'next';
}

(async () => {
	const project = args.project;
	const dryRun = args['dry-run'];
	const verbose = args.verbose;
	if (!project) fail('--project is required');
	if (!args['publish-only'] && !args.specifier) fail('--specifier is required (patch, minor, major, prerelease, ... or an exact version)');

	let version;

	if (args['publish-only']) {
		build(project);
	} else {
		const { projectsVersionData } = await releaseVersion({
			projects: [project],
			specifier: args.specifier,
			preid: args.preid,
			dryRun,
			verbose,
			stageChanges: true,
			gitCommit: false,
			gitTag: false,
		});
		version = projectsVersionData[project]?.newVersion;
		if (!version) fail(`no new version was resolved for ${project}`);

		build(project);

		await releaseChangelog({
			projects: [project],
			versionData: projectsVersionData,
			dryRun,
			verbose,
			gitCommit: true,
			gitTag: true,
		});
	}

	const distPackageJsonPath = path.join('dist', 'packages', project, 'package.json');
	const distPackageJson = JSON.parse(fs.readFileSync(distPackageJsonPath, 'utf8'));
	if (version && dryRun) {
		// --dry-run never writes the new version, and npm refuses to dry-run publish a version that already exists.
		distPackageJson.version = version;
		fs.writeFileSync(distPackageJsonPath, JSON.stringify(distPackageJson, null, 2) + '\n');
	}
	version ??= distPackageJson.version;
	const tag = distTagFor(version);
	console.log(`Publishing ${project}@${version} with dist-tag "${tag}"`);

	const results = await releasePublish({ projects: [project], dryRun, verbose, tag });
	const failed = Object.entries(results).filter(([, r]) => r.code !== 0);
	if (failed.length) fail(`publish failed for ${failed.map(([p]) => p).join(', ')}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
