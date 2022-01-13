import { NgModule, NO_ERRORS_SCHEMA } from '@angular/core';
import { NativeScriptCommonModule, NativeScriptRouterModule } from '@nativescript/angular';
import { NativescriptRippleComponent } from './nativescript-ripple.component';
import { NgRippleModule } from '@edusperoni/nativescript-ripple/angular'

@NgModule({
	imports: [NativeScriptCommonModule, NativeScriptRouterModule.forChild([{ path: '', component: NativescriptRippleComponent }]), NgRippleModule],
  declarations: [NativescriptRippleComponent],
  schemas: [ NO_ERRORS_SCHEMA]
})
export class NativescriptRippleModule {}
