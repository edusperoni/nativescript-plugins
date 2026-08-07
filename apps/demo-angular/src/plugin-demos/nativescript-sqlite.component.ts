import { Component, NgZone } from '@angular/core';
import { DemoSharedNativescriptSqlite } from '@demo/shared';
import {} from '@edusperoni/nativescript-sqlite';

@Component({
	selector: 'demo-nativescript-sqlite',
	templateUrl: 'nativescript-sqlite.component.html',
})
export class NativescriptSqliteComponent {
	demoShared: DemoSharedNativescriptSqlite;

	constructor(private _ngZone: NgZone) {}

	ngOnInit() {
		this.demoShared = new DemoSharedNativescriptSqlite();
	}
}
