# Changes

## 1.0.0

Initial brokered loopback HTTP request, explicit single replay, bounded JSON observations and sensitive-field redaction. Six localized tool descriptions and cards. No automatic enablement.

Pre-release corrections: shared 20-second monotonic invocation budget including connections and replay, late-open closure without writing, visible refusal on redacted-key collisions, framing-independent 8192-byte actual-body bound, strict UTF-8 response decoding and explicit informational-response refusal. No added HTTP profiles or automatic retries.
