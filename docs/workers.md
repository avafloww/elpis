# Workers

Workers are bounded delegated Elpis episodes. They reuse the provider-neutral kernel without inheriting the resident inhabitant's SOUL, autobiographical MEMORY, people files, social ingress, or autonomous wake machinery.

## Mandate and identity

A worker always starts from an existing canonical Mind item. `mindId` is mandatory; there is no arbitrary prompt field. The server binds the item title, body, status, dependencies, and comments as the mandate and records provenance as `worker:<slug>`. One active worker may claim a Mind item at a time.

The parent-facing surface is `elpis.worker.start(mindId, { modelRef? })`, `send`, `list`, `status`, and `dismiss`. Steering crosses the durable mailbox or becomes a Mind comment; a worker cannot select another Mind root, model, slug, or mailbox direction.

## Execution and crash honesty

`src/kernel/turn.ts` is shared ordered model/tool-chain machinery. A worker receives a parent-bound `run(code, detail)` tool with no wake or sandbox selector. Its fsynced journal records initialization, guidance, prepared/completed tool effects, and prepared/completed finish delivery. A crash after preparation but before completion is ambiguous and must not be replayed automatically.

Worker authority is a strict allowlist for its own workspace: local file editing, shell, git, bounded reads/previews, and timing helpers. It has no resident memory, channels, inbound message, Scheduler, restart/deploy, sudo, SSH, background jobs, or unscoped Mind mutation.

## Isolation

Production workers run in fixed operator-owned restricted Pods. Callers may not supply images, commands, mounts, namespaces, service accounts, security contexts, resources, arbitrary environment, or alternate Mind roots. A worker Pod receives only its workspace/scratch and a short-lived control token for token-bound completion, Mind, and mailbox endpoints. Provider credentials, Discord credentials, resident DATA_DIR, and Kubernetes service-account tokens stay outside the Pod.

The broker resolves model, Mind root, runtime, worker provenance, and session from the token server-side. Completion is bounded to one in-flight call per worker plus the configured global cap. The HTTP server is disabled and loopback-bound by default.

`deploy/kubernetes/worker/podtemplate.yaml` is the operator starting point. Replace its image placeholder with an immutable digest, install it in the configured namespace, and apply separate namespace-level default-deny/allowlisted egress policy. Elpis fetches that one `PodTemplate`, validates the restricted shape before creating any credential, then clones it. Validation requires one non-privileged read-only-root container, no service-account token, sidecars, init containers, secret-bearing template environment, host mounts, or extra volumes; `/workspace`, `/data`, and `/tmp` are private `emptyDir` mounts and `activeDeadlineSeconds` bounds the episode.

Enable the token-bound server and fixed template together:

```yaml
workers:
  enabled: true
  max_concurrent: 4
  server:
    enabled: true
    host: 10.42.0.1
    port: 8790
  kubernetes:
    enabled: true
    namespace: elpis-workers
    template: elpis-worker
    container: worker
    broker_url: https://worker-broker.example.com
    kubectl_path: kubectl
    context: bounded-context
```

The broker URL is an origin, not a caller field. Kubernetes settings are boot configuration only. The worker executable is `node /opt/elpis/dist/worker-main.js`; it reads exactly its injected token, broker origin, and session ID, retrieves the bound Mind mandate, runs the worker-only sandbox, and posts one fsynced finish. It does not load resident config, the Elpis database, SOUL, MEMORY, people files, Discord, or Scheduler.

## Persistence

Schema v19 owns `worker_sessions` and `worker_mailbox_messages`. Published v17/v18 `fleet_*` migrations remain immutable historical records, but those rows are inert and never authenticate or execute as workers.
