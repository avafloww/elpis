# elpis-identity

Local executor identity, mTLS credential storage, and bounded pre-client-certificate enrollment.

## Security contract

- An Ed25519 PKCS#8 key is generated locally and remains behind `IdentityStore`; no
  public method returns key bytes or a key-bearing object.
- The state directory must be owned by the effective user and mode `0700`.
  State files are regular, singly linked, mode `0600`, opened with
  `O_NOFOLLOW`, and replaced through fsynced atomic renames.
- `executor_id` is `elpis-executor-v1-<sha256(public-key)>`. PKCS#10 output is
  deterministic for the stored key and size bounded.
- Credential activation is a manifest commit over separately persisted leaf and
  chain blobs. Hashes prevent mixed generations after a crash.
- Every metadata/config read revalidates canonical DER, local Ed25519 SPKI algorithm and key binding,
  clientAuth EKU, configured root and server-name metadata, chain signatures,
  validity/lifetime, and fresh explicit good revocation evidence.
- TLS callers receive only an internally assembled `Arc<rustls::ClientConfig>`.
- Explicit credential invalidation fsyncs removal of the active manifest without rotating
  or exporting the device key.

Revocation evidence is supplied by the enrollment boundary and has an explicit
freshness deadline. `Revoked`, `Unknown`, stale, future-dated, or absent evidence
is rejected; this local crate does not fetch OCSP or CRLs.

Pre-client-certificate enrollment uses a consuming client and one-shot zeroizing token.
The endpoint must be HTTPS on the configured DNS name. The client uses rustls with one
specific configured root, SNI and verification enabled, no proxy, no redirects, and
bounded stage, header, request, and response sizes. Transport errors are redacted. Only
credentials accepted by the local store are atomically activated; the token is never
persisted.
