# 1.0.1

Security update only: the bundled libraries are rebuilt from protobufjs 7.6.6 and Ajv 8.18.0 (were 7.5.4 and 8.17.1). protobufjs before 7.5.5 could run code taken from a crafted schema (CVE-2026-41242) and before 7.6.5 could hang on a truncated `.proto` option; Ajv before 8.18.0 had a `$data` pattern ReDoS. Behaviour, limits and permissions are unchanged.

# 1.0.0

Initial bounded offline workflow; synthetic inputs only, six locales and invocation-scoped cards.
