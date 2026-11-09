# Artifact provenance verifier

Verify supplied artifact bytes using SHA-256, Ed25519, a pinned public-key fingerprint and expected identity. Local envelope v1 only, not Sigstore/SLSA.

Self-contained native Sara plugin1.0.0; Sara >=2.68.0 <3.0.0; Node24+. Tool: analyze. Disabled until reviewed and explicitly enabled for a companion; defaults Ask.

No model, network, shell, subprocess, workspace-read, persistence or independent card-post permission. Input is explicit bounded data. Native invocation-scoped result.card is attached by the host; cards:false deliberately forbids independent broker posts. All nested tool schemas are closed and repeated at the handler boundary.

## Detached envelope format sara-artifact-v1

Verifies actual supplied artifact bytes, SHA256 digest, Ed25519 signature, exact expected identity, and independently pinned public-key fingerprint. All checks must succeed; tamper, wrong key, fingerprint or identity returns verified:false with individual booleans. Malformed inputs are refused with value-free localized errors. No arbitrary algorithm selection, private-key input, network, certificate trust, Sigstore, DSSE, SLSA compliance or transparency-log verification.

The signed bytes are exactly UTF8 of the string sara-artifact-v1 followed by one LF, followed by JSON.stringify([identity,sha256]) without trailing LF. The digest is lowercase hexadecimal SHA256 of decoded artifact bytes. signatureBase64 is a canonical base64 encoding of a64-byte Ed25519 signature. publicKeyPem is an Ed25519 PUBLIC KEY SPKI PEM, not a certificate. expectedKeySha256 is lowercase SHA256 of the public key exported as SPKI DER (NOT PEM). algorithm must be ed25519. expectedIdentity and expectedKeySha256 must be independently obtained; accepting attacker-provided expected values does not establish trust.

Required analyze fields:algorithm,artifactBase64,sha256,identity,expectedIdentity,publicKeyPem,expectedKeySha256,signatureBase64. Identity permits only ASCII letters/digits and ._/@:+- (1–160 characters), public PEM up to1024 characters, canonical base64 artifact up to43692 characters (32769 decoded bytes). Empty artifact bytes are valid. No artifact bytes, signature, identity or key material are returned. Tests generate synthetic keys in memory and never persist private keys.

This establishes integrity and possession of the selected Ed25519 key for this local envelope. It does not establish who controls the key or how an artifact was built.

## Results, languages and limits

content is JSON with machine status plus localized message/scope; card contains localized title/summary. English, Spanish, French, German, Brazilian Portuguese and Italian are covered in actual ready descriptions, successful output/card and refusal tests. Source identifiers, SPDX expressions, crypto/format identifiers and machine status codes remain literal. Unknown locale falls back to English. Input errors never echo user values. Successful content is limited to48000 UTF8 bytes and the serialized channel envelope to60000 bytes; oversize requests are refused, not silently clipped.

shots/1.png is a clearly labelled SYNTHETIC FIXTURE PREVIEW generated from an actual fixture handler result; it is not an app screenshot. Qualification: test/developer-security*.test.ts and docs/ops/DEVELOPER_SECURITY_QUALIFICATION.md. Windows node-only is NOT an OS sandbox; manager/registered-tool qualification is not ordinary chat-approval or paid-provider proof. Unsigned local packages are not signed/published store releases.
