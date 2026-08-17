# Restricted container

The official container is published as `ghcr.io/avafloww/elpis:latest`. It is a deliberately narrower deployment profile than the dedicated-host installer.

The image runs as uid/gid `10001`, keeps the harness and dependencies root-owned under `/opt/elpis`, and carries a root-owned `/etc/elpis/restricted` sentinel. That sentinel wins over environment configuration: the sandbox omits `elpis.sudo`, `elpis.restart`, and `elpis.deploy`, and the prompt does not claim host ownership or self-deployment authority. The image does not include a desktop, browser runtime, or coding-agent fleet.

## Prepare data

```bash
mkdir -p elpis-data
cp config.example.yaml elpis-data/config.yaml
# edit config.yaml; its paths.data_directory should be /data
sudo chown -R 10001:10001 elpis-data
sudo chmod 0700 elpis-data
sudo chmod 0600 elpis-data/config.yaml
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
  -v "$PWD/elpis-data:/data" \
  ghcr.io/avafloww/elpis:latest
```

`/data` is the only persistent writable home. The entrypoint refuses to start without a readable `/data/config.yaml`, a writable `/data`, or the baked restriction sentinel. `ELPIS_CONFIG` defaults to `/data/config.yaml` and may point to another file inside a writable mount.

The restriction profile is defense in depth, not a substitute for the container boundary. Do not run the image privileged, mount the Docker socket, mount host credentials, or bind writable host source into `/opt/elpis`. Keep the root filesystem read-only and grant only the network and volumes the inhabitant actually needs.

The host-native installer remains the supported full-capability shape for an inhabitant who owns and maintains the whole machine.
