import { EventData, Page } from '@nativescript/core';
import { DemoSharedNativescriptRipple } from '@demo/shared';

export function navigatingTo(args: EventData) {
	const page = <Page>args.object;
	page.bindingContext = new DemoModel();
}

export class DemoModel extends DemoSharedNativescriptRipple {
	
}

export function dummy() {
    //
}

export function tapEvent() {
    alert("Tap event works");
}
