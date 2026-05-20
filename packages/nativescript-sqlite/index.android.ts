export * from './common';

export function openDatabase(): never {
	throw new Error('nativescript-sqlite: Android is not yet implemented');
}
