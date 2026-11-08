- [@edusperoni/nativescript-mqtt](packages/nativescript-mqtt/README.md)
- [nativescript-ripple](packages/nativescript-ripple/README.md)
- [@edusperoni/nativescript-sms-inbox](packages/nativescript-sms-inbox/README.md)
- [@edusperoni/nativescript-sqlite](packages/nativescript-sqlite/README.md)
- [@edusperoni/nativescript-supabase](packages/nativescript-supabase/README.md)

# How to use?

This workspace manages the suite of plugins listed above.

In general, when in doubt with what to do, just `npm start`.

## How to add a new package to workspace?

```
npm run add
```

At the prompt, enter the name of the new package.

- This adds a plugin harness in `packages` with the necessary boilerplate to just start developing
- Updates all demo app flavors to support demoing the new package
- Adds shared code in `tools/demo` where you can write demo code **once** and share across all demo flavors
- Updates build tooling to support the new package
- Updates the `npm start` interactive display
- Updates the README here to list the new package

## How to add Angular compatibility to a package

```
npm run add-angular
```

At the prompt, enter the name of the package to add an `angular` folder to it with the necessary boilerplate to provide Angular support to the package.

## How to focus on just 1 package to develop in isolation

```
npm start
```

- Choose the focus commands for the package you wish to focus on and hit enter.
- All the demo app's will be updated to isolate that 1 package and for supported IDE's (currently VS Code), the source code will also become isolated in the workspace.

Note: _good to always clean the demo you plan to run after focusing. (You can clean any demo from `npm start` as well)_

## How to publish packages?

Packages are versioned independently with `nx release` and published from CI using npm trusted publishing.

Run the **Release** workflow (Actions → Release → Run workflow) and pick:

- **project**: the package to release.
- **bump** (`patch`, `minor`, `prerelease`, ...) or an exact **version**. Prereleases use **preid** (default `rc`).
- **dry-run** (on by default): shows the version bump, changelog, and npm tarball without changing anything.

A release bumps `packages/<name>/package.json`, updates `packages/<name>/CHANGELOG.md`, commits and tags `<name>@<version>` on `main`, creates a GitHub release, and publishes to npm. Prereleases are published under their preid as the dist-tag (e.g. `1.0.0-rc.1` → `rc`). If publishing fails after the tag was pushed, re-run with **publish-only**.

The same flow runs locally (without trusted publishing, so `npm login` first):

```
node tools/scripts/release.js --project nativescript-sqlite --specifier patch --dry-run
```

When adding a new package, add it to the `project` options in `.github/workflows/release.yml` and configure a trusted publisher for it on npmjs.com (workflow `release.yml`, environment `npm`). Trusted publishers can only be added to packages that already exist on npm, so publish the first version locally.

<h3 align="center">Made with ❤️</h3>
