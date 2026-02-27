import { DemoSharedBase } from '../utils';
import { SupabaseClient } from '@supabase/supabase-js';
const s = new SupabaseClient('', '');
console.log(s.storage.analytics);

export class DemoSharedNativescriptSupabase extends DemoSharedBase {
	testIt() {
		console.log('test nativescript-supabase!');
	}
}
