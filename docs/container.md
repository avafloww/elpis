# Restricted container

The official container is published as `ghcr.io/avafloww/elpis:latest`. It is a deliberately narrower deployment profile than the dedicated-host installer.

The image runs as uid/gid `10001`, keeps the harness and dependencies root-owned under `/opt/elpis`, and carries a root-owned `/etc/elpis/restricted` sentinel. That sentinel wins over environment configuration: the sandbox omits `elpis.sudo`, `elpis.restart`, and `elpis.deploy`, and the prompt does not claim host ownership or self-deployment authority. The inhabitant still gets Bash and a practical non-root workbench (`git`, SSH, `curl`, `wget`, `jq`, Python with pip/venv, ripgrep, `file`, `less`, and `procps`). The image does not include a desktop, browser runtime, or coding-agent fleet.

## Prepare data

```bash
mkdir -p elpis-data
cp config.example.yaml config.yaml
# edit config.yaml; its paths.data_directory should be /data
sudo chown -R 10001:10001 elpis-data
sudo chmod 0700 elpis-data
# uid 10001 must be able to read the bind-mounted config; Docker makes it read-only
sudo chown 10001:10001 config.yaml
sudo chmod 0400 config.yaml
```

Use an allowlist for the container's intended optional integrations:

```yaml
modules:
  enabled: [kagi, bsky]
```

A selected integration without credentials remains deliberately discoverable through a precise rejecting stub, but is omitted from the system prompt. An integration outside the allowlist is absent from the sandbox. `browser`, `computer`, `motor`, and `fleet` are unavailable in the official restricted image even if selected.

## Run

```bash
docker run -d --name elpis \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -v "$PWD/config.yaml:/config.yaml:ro" \
  -v "$PWD/elpis-data:/data" \
  ghcr.io/avafloww/elpis:latest
```

`/data` is the only persistent writable home. Configuration is a separate read-only bind at `/config.yaml`; it does not live inside the agent-writable data volume. The entrypoint refuses to start without a readable config, a writable `/data`, or the baked restriction sentinel. `ELPIS_CONFIG` defaults to `/config.yaml`.

The restriction profile is defense in depth, not a substitute for the container boundary. Do not run the image privileged, mount the Docker socket, or bind writable host source into `/opt/elpis`. Keep configuration mounted read-only and do not place it inside `/data`. Keep the root filesystem read-only and grant only the network and volumes the inhabitant actually needs.

The host-native installer remains the supported full-capability shape for an inhabitant who owns and maintains the whole machine.
