const npsUtils = require('nps-utils');

module.exports = {
	message: 'NativeScript Plugins ~ made with โค๏ธ  Choose a command to start...',
	pageSize: 32,
	scripts: {
		default: 'nps-i',
		nx: {
			script: 'nx',
			description: 'Execute any command with the @nrwl/cli',
		},
		format: {
			script: 'nx format:write',
			description: 'Format source code of the entire workspace (auto-run on precommit hook)',
		},
		'๐ง': {
			script: `npx cowsay "NativeScript plugin demos make developers ๐"`,
			description: '_____________  Apps to demo plugins with  _____________',
		},
		// demos
		apps: {
			'...Vanilla...': {
				script: `npx cowsay "Nothing wrong with vanilla ๐ฆ"`,
				description: ` ๐ป Vanilla`,
			},
			demo: {
				clean: {
					script: 'nx run demo:clean',
					description: 'โ  Clean  ๐งน',
				},
				ios: {
					script: 'nx run demo:ios',
					description: 'โ  Run iOS  ๏ฃฟ',
				},
				android: {
					script: 'nx run demo:android',
					description: 'โ  Run Android  ๐ค',
				},
			},
			'...Angular...': {
				script: `npx cowsay "Test all the Angles!"`,
				description: ` ๐ป Angular`,
			},
			'demo-angular': {
				clean: {
					script: 'nx run demo-angular:clean',
					description: 'โ  Clean  ๐งน',
				},
				ios: {
					script: 'nx run demo-angular:ios',
					description: 'โ  Run iOS  ๏ฃฟ',
				},
				android: {
					script: 'nx run demo-angular:android',
					description: 'โ  Run Android  ๐ค',
				},
			},
		},
		'โ๏ธ': {
			script: `npx cowsay "@edusperoni/* packages will keep your โ๏ธ cranking"`,
			description: '_____________  @edusperoni/*  _____________',
		},
		// packages
		// build output is always in dist/packages
		'@edusperoni': {
			// @edusperoni/nativescript-sms-inbox
			'nativescript-sms-inbox': {
				build: {
					script: 'nx run nativescript-sms-inbox:build.all',
					description: '@edusperoni/nativescript-sms-inbox: Build',
				},
			},
			// @edusperoni/nativescript-mqtt
			'nativescript-mqtt': {
				build: {
					script: 'nx run nativescript-mqtt:build.all',
					description: '@edusperoni/nativescript-mqtt: Build',
				},
			},
			// @edusperoni/nativescript-ripple
			'nativescript-ripple': {
				build: {
					script: 'nx run nativescript-ripple:build.all',
					description: '@edusperoni/nativescript-ripple: Build',
				},
			},
			'build-all': {
				script: 'nx run-many --all --target=build.all',
				description: 'Build all packages',
			},
		},
		'โก': {
			script: `npx cowsay "Focus only on source you care about for efficiency โก"`,
			description: '_____________  Focus (VS Code supported)  _____________',
		},
		focus: {
			'nativescript-sms-inbox': {
				script: 'nx run nativescript-sms-inbox:focus',
				description: 'Focus on @edusperoni/nativescript-sms-inbox',
			},
			'nativescript-mqtt': {
				script: 'nx run nativescript-mqtt:focus',
				description: 'Focus on @edusperoni/nativescript-mqtt',
			},
			'nativescript-ripple': {
				script: 'nx run nativescript-ripple:focus',
				description: 'Focus on @edusperoni/nativescript-ripple',
			},
			reset: {
				script: 'nx g @nativescript/plugin-tools:focus-packages',
				description: 'Reset Focus',
			}
		},
		'.....................': {
			script: `npx cowsay "That's all for now folks ~"`,
			description: '.....................',
		},
	},
};
