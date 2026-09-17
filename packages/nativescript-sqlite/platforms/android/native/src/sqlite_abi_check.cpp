#include <sqlite3.h>

// sqlite3_close_v2 (3.7.14) is the newest API the binding calls; FTS5, which
// the binding's default options assume, needs 3.9.0.
#if SQLITE_VERSION_NUMBER < 3009000
#error "nscsqlite requires SQLite 3.9.0 or newer (sqlite3.h reports an older SQLITE_VERSION_NUMBER)"
#endif
