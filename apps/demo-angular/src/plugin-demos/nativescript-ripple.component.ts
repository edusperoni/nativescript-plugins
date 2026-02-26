import { Component, NgZone } from '@angular/core';
import { DemoSharedNativescriptRipple } from '@demo/shared';

@Component({
	selector: 'demo-nativescript-ripple',
	standalone: false,
	templateUrl: 'nativescript-ripple.component.html',
})
export class NativescriptRippleComponent {
	demoShared: DemoSharedNativescriptRipple;

	isGreen = true;

	constructor(private _ngZone: NgZone) {}

	ngOnInit() {
		this.demoShared = new DemoSharedNativescriptRipple();
	}

	dummy(): void {
		// dummy function
	}

	switchStyle() {
		this.isGreen = !this.isGreen;
	}
	tapEvent() {
		alert('Tap Event Works too');
	}
}
