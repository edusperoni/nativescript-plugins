import { DemoSharedNativescriptSqlite } from '@demo/shared';

describe('nativescript-sqlite parameter binding', function () {
	const demo = new DemoSharedNativescriptSqlite();
	demo.verbose = false;

	it('binds buffers and views as BLOBs and rejects unsupported values', async function () {
		await demo.testBlobParams();
	}, 60000);
});
