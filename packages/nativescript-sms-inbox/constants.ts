export enum SmsConstants {
	CONTENT_SMS_URI = 'content://sms',
	CONTENT_SMS_INBOX_URI = 'content://sms/inbox',

	SMS_ID_COLUMN = '_id',
	SMS_THREAD_ID_COLUMN = 'thread_id',
	SMS_ADDRESS_COLUMN = 'address',
	SMS_BODY_COLUMN = 'body',
	SMS_DATE_COLUMN = 'date',
	SMS_DATE_SENT_COLUMN = 'date_sent',
	SMS_TYPE_COLUMN = 'type',

	DEFAULT_SORT_PROP = 'date',
	DEFAULT_SORT_ORDER = 'DESC',
	READ_ALL_SMS = -1,
}
