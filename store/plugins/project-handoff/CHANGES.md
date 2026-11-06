# 1.0.0

- Review hardening: refuse serialized output above 60000 characters or UTF-8 bytes; no host-truncated JSON.
- Validate model-generated Unicode/controls; translate explicit no-observations results without saving them.
- Publish nested ready schemas with field/array limits, source roles and operation requirements; notebook does not advertise refine.

- First local candidate: manual supplied-context workflow with exact source references.
- Explicit optional background-model use, capped input/output, quote checks and unverified proposal labels.
- No account access, hooks, schedules or external actions; publication pending.
