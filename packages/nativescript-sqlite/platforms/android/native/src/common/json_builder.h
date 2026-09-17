#pragma once

// ---------------------------------------------------------------------------
// JSONBuilder — fast, allocation-minimal JSON string construction.
//
// Ported from the iOS NSSQLiteDatabase implementation.  Runs on worker
// threads (pure C++, no V8, no JNI).  Builds UTF-8 JSON into a
// pre-allocated string buffer, escaping only the characters that JSON
// requires.
//
// Two wire formats:
//   Objects  (select / get)       → "[{\"col\":val,...},{...},...]"
//   Columnar (selectArray)        → "{\"columns\":[...],\"rows\":[[...],...]}"
//
// Blobs are passed out-of-band: a placeholder object {"__blob__":N} is
// written into the JSON, where N is the 0-based index into the companion
// blob vector.  The JS / V8 side replaces these after JSON.parse().
// ---------------------------------------------------------------------------

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace NSCSQLite {

class JSONBuilder {
    std::string buf_;
public:
    explicit JSONBuilder(std::size_t reserveBytes = 4096) {
        buf_.reserve(reserveBytes);
    }

    void reset() { buf_.clear(); }
    const std::string& str() const { return buf_; }
    std::string        take()       { return std::move(buf_); }

    // ── Raw append ──────────────────────────────────────────────────────────

    void raw(char c)              { buf_.push_back(c); }
    void raw(const char* s, std::size_t n) { buf_.append(s, n); }
    void raw(const char* s)       { buf_.append(s); }

    // ── Typed scalars ────────────────────────────────────────────────────────

    void appendNull()  { raw("null", 4); }
    void appendTrue()  { raw("true", 4); }
    void appendFalse() { raw("false", 5); }

    void appendInt(int64_t v) {
        char tmp[24];
        int n = snprintf(tmp, sizeof(tmp), "%lld", static_cast<long long>(v));
        raw(tmp, static_cast<std::size_t>(n));
    }

    void appendDouble(double v) {
        char tmp[64];
        int n = snprintf(tmp, sizeof(tmp), "%.17g", v);
        raw(tmp, static_cast<std::size_t>(n));
    }

    // ── String (with JSON escaping) ──────────────────────────────────────────

    void appendString(const char* s, int len) {
        raw('"');
        const char* end = s + len;
        while (s < end) {
            unsigned char c = static_cast<unsigned char>(*s);
            switch (c) {
                case '"':  raw("\\\"", 2); break;
                case '\\': raw("\\\\", 2); break;
                case '\b': raw("\\b",  2); break;
                case '\f': raw("\\f",  2); break;
                case '\n': raw("\\n",  2); break;
                case '\r': raw("\\r",  2); break;
                case '\t': raw("\\t",  2); break;
                default:
                    if (c < 0x20) {
                        char esc[8];
                        snprintf(esc, sizeof(esc), "\\u%04x", c);
                        raw(esc, 6);
                    } else {
                        raw(static_cast<char>(c));
                    }
                    break;
            }
            ++s;
        }
        raw('"');
    }

    void appendString(const std::string& s) {
        appendString(s.c_str(), static_cast<int>(s.size()));
    }

    // ── Blob placeholder ─────────────────────────────────────────────────────
    // Writes {"__blob__":N} so the JS side can hydrate it with the real buffer.

    void appendBlobPlaceholder(int index) {
        raw("{\"__blob__\":", 12);
        appendInt(static_cast<int64_t>(index));
        raw('}');
    }
};

} // namespace NSCSQLite
