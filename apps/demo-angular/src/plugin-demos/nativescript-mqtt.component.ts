import { Component, NgZone } from '@angular/core';
import { DemoSharedNativescriptMqtt } from '@demo/shared';
import {} from '@edusperoni/nativescript-mqtt';

@Component({
	selector: 'demo-nativescript-mqtt',
	standalone: false,
	templateUrl: 'nativescript-mqtt.component.html',
})
export class NativescriptMqttComponent {
	demoShared: DemoSharedNativescriptMqtt;

	constructor(private _ngZone: NgZone) {}

	ngOnInit() {
		this.demoShared = new DemoSharedNativescriptMqtt();
	}
}
