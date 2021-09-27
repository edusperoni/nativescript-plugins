import { Observable, EventData, Page } from '@nativescript/core';
import { DemoSharedNativescriptSmsInbox } from '@demo/shared';
import { } from '@edusperoni/nativescript-sms-inbox';

export function navigatingTo(args: EventData) {
	const page = <Page>args.object;
	page.bindingContext = new DemoModel();
}

export class DemoModel extends DemoSharedNativescriptSmsInbox {
	
}
