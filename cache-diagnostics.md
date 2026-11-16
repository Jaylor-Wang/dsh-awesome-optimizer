# HTTP cache diagnostics

Set `telemetry.cacheDiagnosticsPath` to an absolute JSONL filename and reload the plugin or restart DSH. Omit the setting to disable. The observer uses AsyncLocalStorage around LLM stream iteration and a shared, reference-counted global fetch wrapper; calls outside an enabled session scope are untouched. No installed DSH files are modified.

Supported capture: OpenAI-compatible `/chat/completions` requests with a string JSON body using global fetch. Other protocols, custom transports, Request-object bodies and requests without session IDs are not captured. Absence of a log record is not evidence of cache stability.

Request records contain SHA-256 digests for each serialized message, tools, cache key, the remaining request configuration and endpoint; session IDs are hashed. The previous request link and first differing message index compare the same session/endpoint/model across turns. The first request has unknown stability. Message-level equality does not prove the provider's internal token prefix or caching policy. Configuration comparison includes stream/generation settings, so a change is evidence to inspect, not necessarily a cache cause.

Response records contain status and allowlisted request IDs. Usage records contain only allowlisted numeric upstream counters and constrained response/model/system-fingerprint identifiers. A missing cached_tokens field remains missing; zero remains zero. Prompt text, generated text, image bytes, credentials and arbitrary headers are never logged. Original response chunks pass through a bounded TransformStream without a cloned-response buffer. Cancellation and transport errors propagate. Do not treat an incomplete/unsupported capture as zero cache usage.

Limits: 8 MiB per log file, a 256 KiB asynchronous write queue, 128 previous session/route entries, and 1 MiB per buffered SSE event or JSON response. Reaching either log/queue limit stops capture and emits one host warning; use a new log path and reload to resume. Queued writes drain on disposal. Write failure stops capture with one warning; initialization failure disables diagnostics while preserving telemetry. Oversized events emit capture-gap and stop parsing that response. Response URL, redirected/type metadata and clone metadata are preserved. No automatic retry or inference warmup occurs. A restart/reload is required after source changes; configuration on disk alone does not prove the running process loaded the observer.

Interpretation:
- prefixStable=false: inspect the first changed message and request conversion.
- Stable messages/config plus absent cache counters: investigate gateway usage reporting.
- Stable messages/config plus explicit zero: investigate provider routing, retention and eviction; this alone does not prove a provider defect.
- Model/endpoint changes start a new comparison baseline.

The current Web profile is linked to this checkout. Local diagnostics should be stored outside the repository, e.g. `C:/Users/29507/.dsh/diagnostics/cache-http.jsonl`. After restart, verify a request/response/usage sequence during normal usage before relying on the capture. No paid inference requests are needed for unit verification.
