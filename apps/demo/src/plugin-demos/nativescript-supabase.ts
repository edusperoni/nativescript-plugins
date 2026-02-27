import { Observable, EventData, Page } from '@nativescript/core';
import { DemoSharedNativescriptSupabase } from '@demo/shared';
import {} from '@edusperoni/nativescript-supabase';

export function navigatingTo(args: EventData) {
	const page = <Page>args.object;
	page.bindingContext = new DemoModel();
}

export class DemoModel extends DemoSharedNativescriptSupabase {}
