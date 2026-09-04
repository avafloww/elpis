# Elpis Gateway

Elpis Gateway is an optional control plane for several independent Elpis residents. It presents the existing Console dashboard for one selected resident at a time. Gateway is not a resident: it has no agent loop, SOUL, memory, transcripts, Mind database, worker runtime, scheduler, or access to resident data directories. It can custody provider credentials for explicit model routes without acquiring a resident's history or agency.

Each resident remains independently operable through its local Console. Residents dial Gateway outbound over WSS; browsers never connect directly to residents. Selecting a resident opens one bounded remote viewer, requests a fresh ordinary Console snapshot, and withholds later deltas until that snapshot completes. Switching closes the old viewer before opening the new one. Media requests are scoped to the selected resident and checked for route, size, canonical base64, and SHA-256.

## Build and Kubernetes deployment

Gateway has a separate published image at `ghcr.io/avafloww/elpis-gateway`. Release CI builds and boots it independently from the resident image, then publishes the release, minor, source-SHA, and `latest` tags and verifies that the release manifest is anonymously readable. Prefer a release tag or manifest digest; `latest` is convenient but not immutable. The similarly named `ghcr.io/avafloww/elpis` image is a resident and must not be deployed as Gateway.

GHCR package visibility is separate from repository access. Release CI deliberately remains red unless an anonymous manifest fetch succeeds. If a first publication remains private, a package owner must change `elpis-gateway` to **Public** in GitHub's package settings and rerun the failed workflow. Once public, GitHub does not allow the package to become private again.

To build locally instead:

```bash
docker build -f Dockerfile.gateway -t elpis-gateway:local .
```

`deploy/kubernetes/gateway/gateway.yaml` installs a restricted single-replica StatefulSet, Service, PVC, and default-deny NetworkPolicy. The checked-in manifest uses `elpis-gateway:local` with `imagePullPolicy: Never` for an image imported into the node runtime. For a registry deployment, render those two fields with an immutable Gateway image before applying it:

```bash
gateway_image='ghcr.io/avafloww/elpis-gateway@sha256:<manifest-digest>'
sed \
  -e "s#image: elpis-gateway:local#image: $gateway_image#" \
  -e 's#imagePullPolicy: Never#imagePullPolicy: IfNotPresent#' \
  deploy/kubernetes/gateway/gateway.yaml | kubectl apply -f -
kubectl -n elpis-gateway wait --for=condition=Ready pod/elpis-gateway-0 --timeout=180s
```

The container runs as uid/gid `10001`, has a read-only root filesystem, receives no ServiceAccount token, and writes only `/data` and bounded tmpfs `/tmp`. `ELPIS_GATEWAY_DATA_DIR`, `ELPIS_GATEWAY_LISTEN_HOST`, and `ELPIS_GATEWAY_LISTEN_PORT` select the data directory and listener. The defaults are `./gateway-data`, `127.0.0.1`, and `8790`; the Kubernetes manifest uses `/data/state`, `0.0.0.0`, and `8790`.

The shipped NetworkPolicy is defense in depth, not proof that host- or node-origin traffic is blocked: that behavior depends on the cluster CNI. Restrict the Service at the ingress, firewall, and network topology as well.

## Reverse proxy and authentication

Gateway serves plain HTTP and expects an authenticated TLS reverse proxy in front of it.

The proxy owns human authentication for browser routes, including `/`, `/api/v1/*` browser APIs, and `/api/v1/browser/relay`. Gateway has no application users, passwords, sessions, passkeys, or RBAC. Do not expose those routes around the authenticated proxy. Preserve Gateway's exact Origin and CSRF checks.

Four resident routes bypass human login because residents cannot answer a browser authentication challenge:

- `POST /api/v1/resident/enrollment`
- `POST /api/v1/resident/rotation`
- `POST /api/v1/resident/rotation/activate`
- `GET /api/v1/resident/link` (WebSocket upgrade)

Expose those routes only through TLS. Preserve their request `Authorization` header without logging it; Gateway still requires the one-use enrollment grant or per-resident bearer credential. Clear the proxy's own browser-authentication header before forwarding ordinary browser routes.

Set Gateway's canonical public URL to the exact external HTTPS origin. Browser Origin checks and the resident WSS target derive from that value; path, query, fragment, embedded credentials, and noncanonical forms are rejected.

## Setup and resident enrollment

Open Gateway through the authenticated proxy. The first setup screen records the canonical public HTTPS origin. **Add Instance** creates a ten-minute, one-use enrollment grant and shows its bootstrap YAML once. Copy it directly into the target resident's private `config.yaml`:

```yaml
dashboard:
  local:
    enabled: true
    mcp_enabled: false
    host: 127.0.0.1
    port: 8787
  remote:
    url: https://gateway.example
    enrollment_token: ege1.<id>.<secret>
```

The resident stores its installation identity and active node credential in its own `elpis-data/elpis.db`. Gateway stores only the public credential ID and a SHA-256 verifier bound to that instance. An exact lost enrollment response can be replayed; a used, expired, mismatched, or revoked grant cannot enroll another instance. After successful enrollment the resident no longer needs the one-use token, although removing it from `config.yaml` reduces secret copies.

A configured but unavailable Gateway never blocks resident boot or the local Console. The resident reconnects with bounded backoff. Credential rotation keeps the old credential active until Gateway proves possession of the pending replacement, then revokes the old credential atomically.

## State, backup, and restore

Gateway keeps configuration, instance identity, credential verifiers, provider API keys and OAuth credentials, immutable provider target history, instance grants, and audit receipts in `gateway.db` under its data directory. Provider credential install and OAuth refresh return secret-free receipts; refresh uses an exact secret revision, and there is no general credential readback API. The live database, WAL, and SHM files are mode `0600`; the parent directory is mode `0700`.

Each model head identifies one immutable target generation. Reapplying the same canonical target is a no-op; changing its credential identity, base URL, provider model, allowed routes, wire grammar, or declared capabilities creates a new generation and removes every prior instance grant for that model. Disabling a model also removes its grants, and enabling it again requires another generation. An instance catalog contains only its exact current grants, sorted and validated by the shared Gateway LLM protocol. Grants never carry forward implicitly.

Back up a running Gateway with SQLite's online backup API and verify the resulting standalone database with `PRAGMA quick_check`, application ID, schema version, migration prefix, and foreign keys in a separate process. Do not copy a live database file and its sidecars and call that a backup. An offline copy is valid only after Gateway has stopped cleanly and the database has been reopened and verified. Keep backups private: they contain provider secrets, credential verifiers, target history, grants, and control-plane audit data.

A single restored `gateway.db` restores Gateway identity and control-plane state. Residents keep their own usable credentials; Gateway never stores resident bearer secrets.

## Current limits

- Gateway is single-replica and uses one RWO PVC. It does not provide active/active failover.
- The instance picker shows bounded public identity and connection state. Inactive residents do not stream full Console state.
- Gateway does not centralize resident databases, filesystems, transcripts, or resident bearer secrets. Provider credentials are a separate, explicit centralized custody surface.
- Human multi-user authorization and RBAC are not implemented; the reverse proxy's authenticated audience shares one operator surface.
- TLS termination, browser authentication, DNS, certificates, firewall rules, image distribution, and backup scheduling remain operator responsibilities.
