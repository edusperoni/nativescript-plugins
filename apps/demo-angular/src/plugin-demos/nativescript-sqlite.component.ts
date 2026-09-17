import { Component, ElementRef, NgZone, ViewChild, OnInit, OnDestroy } from '@angular/core';
import { DemoSharedNativescriptSqlite } from '@demo/shared';
import {} from '@edusperoni/nativescript-sqlite';
import { StackLayout } from '@nativescript/core';

@Component({
	selector: 'demo-nativescript-sqlite',
	standalone: false,
	templateUrl: 'nativescript-sqlite.component.html',
})
export class NativescriptSqliteComponent implements OnInit, OnDestroy {
	demoShared: DemoSharedNativescriptSqlite;
	@ViewChild('spinner', { static: false }) spinnerRef: ElementRef;

	private _spinning = true;

	constructor(private _ngZone: NgZone) {}

	ngOnInit() {
		this.demoShared = new DemoSharedNativescriptSqlite();
	}

	ngAfterViewInit() {
		this._spin();
	}

	ngOnDestroy() {
		this._spinning = false;
	}

	private _spin() {
		if (!this._spinning) return;
		const view: StackLayout = this.spinnerRef?.nativeElement;
		if (!view) return;
		let last: number | null = null;
		const step = (ts: number) => {
			if (!this._spinning) return;
			if (last !== null) {
				const delta = ts - last;
				view.rotate = (view.rotate + (delta / 800) * 360) % 360;
			}
			last = ts;
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}
}
