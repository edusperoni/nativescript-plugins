#pragma once

// ---------------------------------------------------------------------------
// DatabaseBinding — NativeScript V8 entry point for SQLite package.
//
// Exposes the `NSCSQLite` global function and its prototype methods.
// Handles parsing V8 arguments, converting to native types, and dispatching
// to the async layer.
// ---------------------------------------------------------------------------

#include "v8.h"

namespace NSCSQLite {
namespace DatabaseBinding {

// Initialize the binding, called from NSMain.
void Init(v8::Isolate* isolate);

} // namespace DatabaseBinding
} // namespace NSCSQLite
