import { DatabaseOptions, RuntimeInfo, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, ReadTransaction, Transaction, PreparedStatement, SQLiteDatabase } from './common';

export { DatabaseOptions, RuntimeInfo, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue, ReadTransaction, Transaction, PreparedStatement, SQLiteDatabase };
export { SQLITE_OK, SQLITE_ERROR, SQLITE_BUSY, SQLITE_CONSTRAINT, SQLITE_MISMATCH, SQLITE_MISUSE, SQLITE_RANGE, SQLITE_ROW, SQLITE_DONE, SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE, SQLITE_OPEN_MEMORY, SQLITE_OPEN_URI, SQLITE_OPEN_NOMUTEX, SQLITE_OPEN_FULLMUTEX, SQLITE_INTEGER, SQLITE_FLOAT, SQLITE_TEXT, SQLITE_BLOB, SQLITE_NULL } from './common';

export function openDatabase(options: DatabaseOptions): SQLiteDatabase;
