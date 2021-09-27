import { NgModule, NO_ERRORS_SCHEMA } from '@angular/core';
import { NativeScriptCommonModule, NativeScriptRouterModule } from '@nativescript/angular';
import { NativescriptSmsInboxComponent } from './nativescript-sms-inbox.component';

@NgModule({
	imports: [NativeScriptCommonModule, NativeScriptRouterModule.forChild([{ path: '', component: NativescriptSmsInboxComponent }])],
  declarations: [NativescriptSmsInboxComponent],
  schemas: [ NO_ERRORS_SCHEMA]
})
export class NativescriptSmsInboxModule {}
