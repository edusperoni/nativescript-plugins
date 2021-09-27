import { Component, NgZone } from '@angular/core';
import { DemoSharedNativescriptSmsInbox } from '@demo/shared';
import { } from '@edusperoni/nativescript-sms-inbox';

@Component({
	selector: 'demo-nativescript-sms-inbox',
	templateUrl: 'nativescript-sms-inbox.component.html',
})
export class NativescriptSmsInboxComponent {
  
  demoShared: DemoSharedNativescriptSmsInbox;
  
	constructor(private _ngZone: NgZone) {}

  ngOnInit() {
    this.demoShared = new DemoSharedNativescriptSmsInbox();
  }

}