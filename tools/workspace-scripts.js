module.exports = {
	message: 'NativeScript Plugins ~ made with ❤️  Choose a command to start...',
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
		'🔧': {
			script: `npx cowsay "NativeScript plugin demos make developers 😊"`,
			description: '_____________  Apps to demo plugins with  _____________',
		},
		// demos
		apps: {
			'...Vanilla...': {
				script: `npx cowsay "Nothing wrong with vanilla 🍦"`,
				description: ` 🔻 Vanilla`,
			},
			demo: {
				clean: {
					script: 'nx clean demo',
					description: '⚆  Clean  🧹',
				},
				ios: {
					script: 'nx debug demo ios',
					description: '⚆  Run iOS  ',
				},
				android: {
					script: 'nx debug demo android',
					description: '⚆  Run Android  🤖',
				},
			},
			'...Angular...': {
				script: `npx cowsay "Test all the Angles!"`,
				description: ` 🔻 Angular`,
			},
			'demo-angular': {
				clean: {
					script: 'nx clean demo-angular',
					description: '⚆  Clean  🧹',
				},
				ios: {
					script: 'nx debug demo-angular ios',
					description: '⚆  Run iOS  ',
				},
				android: {
					script: 'nx debug demo-angular android',
					description: '⚆  Run Android  🤖',
				},
			},
		},
		'⚙️': {
			script: `npx cowsay "@edusperoni/* packages will keep your ⚙️ cranking"`,
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
			// nativescript-ripple
			'nativescript-ripple': {
				build: {
					script: 'nx run nativescript-ripple:build.all',
					description: 'nativescript-ripple: Build',
				},
			},
			// @edusperoni/nativescript-supabase
			'nativescript-supabase': {
				build: {
					script: 'nx run nativescript-supabase:build.all',
					description: '@edusperoni/nativescript-supabase: Build',
				},
			},
			// @edusperoni/nativescript-sqlite
			'nativescript-sqlite': {
				build: {
					script: 'nx run nativescript-sqlite:build.all',
					description: '@edusperoni/nativescript-sqlite: Build',
				},
			},
			'build-all': {
				script: 'nx run-many --all --target=build.all',
				description: 'Build all packages',
			},
		},
		'⚡': {
			script: `npx cowsay "Focus only on source you care about for efficiency ⚡"`,
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
				description: 'Focus on nativescript-ripple',
			},
			'nativescript-supabase': {
				script: 'nx run nativescript-supabase:focus',
				description: 'Focus on @edusperoni/nativescript-supabase',
			},
			'nativescript-sqlite': {
				script: 'nx run nativescript-sqlite:focus',
				description: 'Focus on @edusperoni/nativescript-sqlite',
			},
			reset: {
				script: 'nx g @nativescript/plugin-tools:focus-packages',
				description: 'Reset Focus',
			},
		},
		'.....................': {
			script: `npx cowsay "That's all for now folks ~"`,
			description: '.....................',
		},
	},
};
