import { SmsConstants } from './constants';

export class Sms {
	id: number;
	threadId: number;
	fromNumber: string;
	message: string;
	date: string;
	sentDate: string;
	type: number;
	uuid: string;

	parseFromNative(cursor: android.database.Cursor): void {
		this.id = cursor.getInt(cursor.getColumnIndex(SmsConstants.SMS_ID_COLUMN));
		this.threadId = cursor.getInt(cursor.getColumnIndex(SmsConstants.SMS_THREAD_ID_COLUMN));
		this.fromNumber = cursor.getString(cursor.getColumnIndex(SmsConstants.SMS_ADDRESS_COLUMN));
		this.message = cursor.getString(cursor.getColumnIndex(SmsConstants.SMS_BODY_COLUMN));
		this.date = cursor.getString(cursor.getColumnIndex(SmsConstants.SMS_DATE_COLUMN));
		this.sentDate = cursor.getString(cursor.getColumnIndex(SmsConstants.SMS_DATE_SENT_COLUMN));
		this.type = cursor.getInt(cursor.getColumnIndex(SmsConstants.SMS_TYPE_COLUMN));
		this.uuid = `SMS${this.id}-${this.date}-${this.fromNumber}`;
	}
}
