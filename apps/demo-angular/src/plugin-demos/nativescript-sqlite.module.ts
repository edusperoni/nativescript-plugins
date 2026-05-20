import { NgModule, NO_ERRORS_SCHEMA } from '@angular/core';
import { NativeScriptCommonModule, NativeScriptRouterModule } from '@nativescript/angular';
import { NativescriptSqliteComponent } from './nativescript-sqlite.component';

@NgModule({
	imports: [NativeScriptCommonModule, NativeScriptRouterModule.forChild([{ path: '', component: NativescriptSqliteComponent }])],
	declarations: [NativescriptSqliteComponent],
	schemas: [NO_ERRORS_SCHEMA],
})
export class NativescriptSqliteModule {}
