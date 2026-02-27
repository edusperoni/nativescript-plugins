import { Component, NgZone } from '@angular/core';
import { DemoSharedNativescriptSupabase } from '@demo/shared';
import {} from '@edusperoni/nativescript-supabase';

@Component({
	selector: 'demo-nativescript-supabase',
	templateUrl: 'nativescript-supabase.component.html',
	standalone: false,
})
export class NativescriptSupabaseComponent {
	demoShared: DemoSharedNativescriptSupabase;

	constructor(private _ngZone: NgZone) {}

	ngOnInit() {
		this.demoShared = new DemoSharedNativescriptSupabase();
	}
}
