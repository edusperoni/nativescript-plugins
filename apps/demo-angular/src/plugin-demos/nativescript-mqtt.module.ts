import { NgModule, NO_ERRORS_SCHEMA } from '@angular/core';
import { NativeScriptCommonModule, NativeScriptRouterModule } from '@nativescript/angular';
import { NativescriptMqttComponent } from './nativescript-mqtt.component';

@NgModule({
	imports: [NativeScriptCommonModule, NativeScriptRouterModule.forChild([{ path: '', component: NativescriptMqttComponent }])],
  declarations: [NativescriptMqttComponent],
  schemas: [ NO_ERRORS_SCHEMA]
})
export class NativescriptMqttModule {}
