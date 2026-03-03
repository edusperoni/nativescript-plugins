# @edusperoni/nativescript-supabase

```javascript
npm install @edusperoni/nativescript-supabase
```

## Usage

This plugin makes `@supabase/supabase-js` work in NativeScript.

It does two things for you:

- Adds NativeScript-compatible build replacements through `nativescript.webpack.js`.
- Polyfills browser APIs needed by Supabase when you import the plugin:
	- `localStorage` (backed by NativeScript `ApplicationSettings`)
	- `WebSocket` (via `@valor/nativescript-websockets`)

After that, just use the official Supabase JS client.

### 1) Install

```bash
npm install @edusperoni/nativescript-supabase @supabase/supabase-js
```

### 2) Import once at app startup

Import this package **before** creating your Supabase client.

```ts
import '@edusperoni/nativescript-supabase';
```

Place it in your app entry file (for example, `app.ts` / `main.ts`) so it runs once on startup.

### 3) Use Supabase normally

```ts
import '@edusperoni/nativescript-supabase';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://YOUR_PROJECT_ID.supabase.co';
const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function loadProfile() {
	const { data, error } = await supabase.from('profiles').select('*').limit(1);
	if (error) {
		console.error(error);
		return;
	}
	console.log(data);
}
```

## Notes

- No extra manual polyfill setup is required beyond importing `@edusperoni/nativescript-supabase`.
- `localStorage` persistence maps to NativeScript app settings storage.
- Supabase usage (auth, realtime, queries, storage client APIs) follows the standard `@supabase/supabase-js` documentation.

## License

Apache License Version 2.0
