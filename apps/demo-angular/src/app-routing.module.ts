import { NgModule } from '@angular/core';
import { Routes } from '@angular/router';
import { NativeScriptRouterModule } from '@nativescript/angular';

import { HomeComponent } from './home.component';

const routes: Routes = [
   { path: '', redirectTo: '/home', pathMatch: 'full' },
   { path: 'home', component: HomeComponent },
	{ path: 'nativescript-mqtt', loadChildren: () => import('./plugin-demos/nativescript-mqtt.module').then(m => m.NativescriptMqttModule) },
	{ path: 'nativescript-sms-inbox', loadChildren: () => import('./plugin-demos/nativescript-sms-inbox.module').then(m => m.NativescriptSmsInboxModule) }
];

@NgModule({
	imports: [NativeScriptRouterModule.forRoot(routes)],
	exports: [NativeScriptRouterModule],
})
export class AppRoutingModule {}
