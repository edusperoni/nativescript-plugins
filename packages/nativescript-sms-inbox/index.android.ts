import { SmsConstants } from './constants';
import { Utils } from '@nativescript/core';
import { FilterOptions, Inbox } from './common';
import { Sms } from './sms';

export * from './sms';
export * from './constants';
export * from './common';

function getAppContext(): android.content.Context {
	return Utils.android.getApplicationContext();
}

export function getInboxes(options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, null, null, sortOrder);
		const count = cursor.getCount();

		const smsList: Sms[] = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function getInboxesAfterDate(timestamp: number, options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const filter = 'date>=' + timestamp;
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, filter, null, sortOrder);
		const count = cursor.getCount();

		const smsList = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function getInboxesBetweenDates(startTimestamp: number, endTimestamp: number, options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const filter = 'date>=' + startTimestamp + ' and date<=' + endTimestamp;
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, filter, null, sortOrder);
		const count = cursor.getCount();

		const smsList = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function getInboxesAfterSentDate(timestamp: number, options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const filter = 'date_sent>=' + timestamp;
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, filter, null, sortOrder);
		const count = cursor.getCount();

		const smsList = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function getInboxesBetweenSentDates(startTimestamp: number, endTimestamp: number, options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const filter = 'date_sent>=' + startTimestamp + ' and date_sent<=' + endTimestamp;
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, filter, null, sortOrder);
		const count = cursor.getCount();

		const smsList = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function getInboxesFromNumber(fromNumber: string, options: FilterOptions): Promise<Inbox> {
	const max = options.max || SmsConstants.READ_ALL_SMS,
		sort = options.sort || SmsConstants.DEFAULT_SORT_PROP,
		order = options.order || SmsConstants.DEFAULT_SORT_ORDER;
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		const sortOrder = sort + ' ' + order + (max == SmsConstants.READ_ALL_SMS ? '' : ' limit ' + max);
		const columns = ['_id', 'thread_id', 'address', 'date', 'date_sent', 'body', 'type'];
		const cursor = contentResolver.query(android.net.Uri.parse(SmsConstants.CONTENT_SMS_INBOX_URI), columns, 'address=?', [fromNumber], sortOrder);
		const count = cursor.getCount();

		const smsList = [];
		if (count > 0) {
			while (cursor.moveToNext()) {
				const smsModel = new Sms();
				smsModel.parseFromNative(cursor);
				smsList.push(smsModel);
			}
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		} else {
			cursor.close();
			resolve({ data: smsList, total: count, status: 'success' });
		}
	});
}

export function deleteSms(smsId: number): Promise<number> {
	return new Promise((resolve) => {
		const contentResolver = getAppContext().getContentResolver();
		resolve(contentResolver.delete(android.net.Uri.parse(SmsConstants.CONTENT_SMS_URI + smsId), null, null));
	});
}
