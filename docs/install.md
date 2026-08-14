# Installation

The supported production target is a fresh dedicated Debian 13 VM or machine. The installer provisions a powerful resident agent, including passwordless sudo; do not run it casually on a shared host.

## Automated install

```bash
git clone https://github.com/avafloww/elpis.git
cd elpis
sudo ./deploy/install.sh
```

With a TTY, the installer prompts for required values. For automation:

```bash
sudo ./deploy/install.sh --non-interactive \
  --agent-name Aster \
  --llm-base-url https://api.openai.com/v1 \
  --llm-api-key "$OPENAI_API_KEY" \
  --llm-model gpt-4o \
  --llm-context-size 128000 \
  --discord-token "$DISCORD_BOT_TOKEN" \
  --operator-id 111111111111111111 \
  --guild-id 222222222222222222 \
  --guild-slug home \
  --channel 333333333333333333:direct
```

Run `./deploy/install.sh --help` for the complete flag list. A prebuilt configuration can be supplied with `--config FILE`.

## What the installer creates

Default layout:

```text
$HOME/elpis/       source checkout
$HOME/data/        private agent data
```

Services:

- `elpis-xorg.service` — root system service for the persistent Xorg display;
- `elpis-desktop.service` — user Openbox/tint2 session;
- `elpis-harness.service` — user Elpis process.

The service-unit name remains `elpis-harness` for upgrade compatibility even though the project and checkout are named Elpis.

The installer also provisions Node.js 24, build and media tools, Playwright Chromium dependencies, systemd lingering, a private `config.yaml`, and required X11 state.

## Verify

As the service user:

```bash
systemctl --user status elpis-harness elpis-desktop
journalctl --user -u elpis-harness -n 100 --no-pager
```

As root:

```bash
systemctl status elpis-xorg
```

The console listens on loopback by default. Use an authenticated TLS reverse proxy for remote access; do not expose port 8787 directly.

## Update

```bash
cd $HOME/elpis
git pull --ff-only
npm ci
npm run build
systemctl --user restart elpis-harness
```

Review configuration and database changes before updating a long-lived installation. Back up `DATA_DIRECTORY` before migrations.

## Existing hosts

The installer reuses an existing checkout and existing identity/memory files. It does not overwrite an existing `SOUL.md` or data directory. Use `--harness-dir`, `--data-dir`, and `--config` when adopting a non-default layout.

## LXC and display notes

The desktop stack expects access to a real or virtual display device. A KVM VM is the simplest supported shape. LXC deployments may require explicit seat, DRM, input, and `/tmp/.X11-unix` configuration and are not the default path.
