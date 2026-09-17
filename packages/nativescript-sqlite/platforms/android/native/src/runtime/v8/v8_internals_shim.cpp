#include "v8.h"

// v8::Object::GetInternalField() has an inline fast path that calls this
// helper, but libNativeScript.so exports no v8::internal:: symbol, so the
// plugin has to supply it.  V8 documents it as "v8::Isolate::Current() without
// including v8-isolate.h", which is what the public entry point below returns.
// Delete this file once the runtime exports the symbol itself.
namespace v8 {
namespace internal {

v8::Isolate* Internals::GetCurrentIsolate() { return v8::Isolate::GetCurrent(); }

} // namespace internal
} // namespace v8
