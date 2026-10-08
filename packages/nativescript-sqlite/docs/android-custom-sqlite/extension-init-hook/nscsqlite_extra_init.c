/* SQLITE_EXTRA_INIT hook: SQLite calls this once, from inside
 * sqlite3_initialize(), before any connection exists.
 *
 * If the engine you are building already names something here — SQLCipher sets
 * SQLITE_EXTRA_INIT=sqlcipher_extra_init to register its crypto provider — call
 * that function first and return its result on failure, rather than replacing
 * it. SQLCipher's guard is `#if !defined(SQLITE_EXTRA_INIT)`: it checks that the
 * macro exists, not what it names, so an unchained hook compiles cleanly and
 * leaves the provider unregistered.
 *
 * SQLite3MC, used by this example, calls sqlite3mc_initialize() from a
 * hardcoded call site of its own and so needs no chaining.
 */

#include "sqlite3.h"
#include "sqlite-vec.h"

int nscsqlite_extra_init(const char *unused) {
  (void)unused;

  /* Registered as an auto-extension so every connection the plugin opens —
   * writer, readers and the sync connection — gets it. */
  return sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
}
