import '@valor/nativescript-websockets';
import { ApplicationSettings } from '@nativescript/core';

export const SUPABASE = 1;

const globalScope = globalThis as typeof globalThis & {
	localStorage?: Storage;
};

if (!globalScope.localStorage) {
	const storage: Storage = {
		get length() {
			return ApplicationSettings.getAllKeys().length;
		},
		clear() {
			ApplicationSettings.clear();
		},
		getItem(key: string) {
			return ApplicationSettings.hasKey(key) ? ApplicationSettings.getString(key) : null;
		},
		key(index: number) {
			const keys = ApplicationSettings.getAllKeys();
			return index >= 0 && index < keys.length ? keys[index] : null;
		},
		removeItem(key: string) {
			ApplicationSettings.remove(key);
		},
		setItem(key: string, value: string) {
			ApplicationSettings.setString(key, String(value));
		},
	};

	Object.defineProperty(globalScope, 'localStorage', {
		value: storage,
		configurable: true,
		writable: false,
	});
}
