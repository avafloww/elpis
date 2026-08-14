# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. Until tagged releases begin, no older snapshot is guaranteed to receive backports.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting for `avafloww/elpis`. If that surface is unavailable, contact the repository owner through the contact information on their GitHub profile.

Do not open a public issue containing credentials, transcript excerpts, exploit payloads, private host details, or other user data.

A useful report includes:

- affected commit or version;
- threat model and prerequisites;
- minimal reproduction;
- expected and observed behavior;
- whether credentials or durable state may have been exposed;
- suggested mitigation, if known.

## Threat model

Elpis is intended for one trusted agent on a dedicated machine or VM. It is **not** a multi-tenant sandbox.

The inhabitant can intentionally:

- execute JavaScript and subprocesses;
- read and write its data directory;
- access configured network services;
- use passwordless sudo when the installer enables it;
- edit, rebuild, and restart the harness.

`node:vm`, command timeouts, key whitelists, and other bounds reduce accidental damage and constrain particular tools. They do not defend the host from a malicious inhabitant or malicious operator.

Security boundaries that *are* expected to hold include:

- Discord authorization and server separation;
- secret redaction from model-visible errors and logs;
- canonical OAuth token destinations;
- private file permissions for transcripts and credentials;
- replay provenance for opaque reasoning;
- path containment for data-directory helpers;
- browser/desktop control remaining local unless deliberately exposed;
- no silent publication of runtime data.

## Operational guidance

- Deploy on a dedicated host.
- Keep `config.yaml`, `agent.db`, transcripts, browser profiles, and private diagnostic bundles out of Git.
- Bind the console to loopback and place authenticated TLS termination in front of it if remote access is required.
- Rotate provider and Discord credentials after suspected exposure.
- Back up the data directory encrypted and test restoration.
- Review subscription-provider terms before enabling product-specific OAuth adapters.
