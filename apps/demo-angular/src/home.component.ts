import { Component } from '@angular/core';

@Component({
	selector: 'demo-home',
	templateUrl: 'home.component.html',
})
export class HomeComponent {
	demos = [
	{
		name: 'nativescript-mqtt'
	},
	{
		name: 'nativescript-ripple'
	},
	{
		name: 'nativescript-sms-inbox'
	}
];
}