#!/usr/bin/env bash
# deploy/install.sh — provision a FRESH Debian 13 (trixie) machine for the
# Elpis: a single, dedicated agent per machine/VM/LXC.
#
# What it does, in order:
# 1. re-execs itself as root via sudo if not already root
# 2. installs every system dependency via apt (required AND optional-but-
# wanted: ffmpeg for animated emote keyframes, openssh-client for
# elpis.ssh, browser libraries, and the Xorg/Openbox computer-use desktop)
# 3. installs Node 24 (LTS) from the NodeSource apt repo
# 4. creates the service user (default: agent) with passwordless sudo —
# the agent owns the box by design — and enables systemd lingering
# 5. clones the harness (or reuses the checkout this script runs from),
# then `npm ci --include=dev` + `npm run build` as the service user
# 6. installs Playwright's Chromium revision + browser system dependencies
# 7. writes config.yaml (interactive prompts, flags, or --config FILE)
# 8. installs real Xorg :0 as a SYSTEM unit plus desktop + harness USER units
#
# Interactive: sudo ./install.sh
# Non-interactive: sudo ./install.sh --non-interactive \
# --llm-base-url https://api.example.com/ \
# --llm-api-key sk-... --llm-model some-model \
# --discord-token ... --guild-id 111... --guild-slug home \
# --channel 222...:direct --channel 333...:social
# See --help for the full flag list.
set -euo pipefail

NODE_MAJOR=24
DEFAULT_USER="agent"
DEFAULT_REPO_URL="https://github.com/avafloww/elpis.git"
DEFAULT_BRANCH="main"
SERVICE_UNIT="elpis-harness"
DESKTOP_UNIT="elpis-desktop"
XORG_UNIT="elpis-xorg"

# ---------------------------------------------------------------------------
# colors + output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\e[0m';  C_BOLD=$'\e[1m';   C_DIM=$'\e[2m'
  C_RED=$'\e[31m';   C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'
  C_CYAN=$'\e[36m';  C_MAGENTA=$'\e[35m'
  G1=$'\e[38;5;213m'; G2=$'\e[38;5;177m'; G3=$'\e[38;5;141m'
  G4=$'\e[38;5;105m'; G5=$'\e[38;5;69m';  G6=$'\e[38;5;45m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW=''
  C_CYAN='' C_MAGENTA='' G1='' G2='' G3='' G4='' G5='' G6=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s▸ %s%s\n' "$C_BOLD" "$C_CYAN" "$*" "$C_RESET"; }
ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s✘ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

banner() {
  printf '\n'
  printf '%s  ███████╗██╗     ██████╗ ██╗███████╗%s\n' "$G1" "$C_RESET"
  printf '%s  ██╔════╝██║     ██╔══██╗██║██╔════╝%s\n' "$G2" "$C_RESET"
  printf '%s  █████╗  ██║     ██████╔╝██║███████╗%s\n' "$G3" "$C_RESET"
  printf '%s  ██╔══╝  ██║     ██╔═══╝ ██║╚════██║%s\n' "$G4" "$C_RESET"
  printf '%s  ███████╗███████╗██║     ██║███████║%s\n' "$G5" "$C_RESET"
  printf '%s  ╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝%s\n' "$G6" "$C_RESET"
  printf '%s  elpis harness installer — a home for a persistent agent%s\n\n' "$C_DIM" "$C_RESET"
}

# ---------------------------------------------------------------------------
# usage + argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: sudo ./install.sh [options]

Provisions a fresh, dedicated Debian 13 machine for one Elpis agent.
With no options (and a TTY) it runs interactively; --non-interactive requires
the config values below as flags (or a prebuilt file via --config).

Machine / layout:
  --user NAME             service account to create/use        (default: $DEFAULT_USER)
  --harness-dir DIR       harness checkout path                (default: ~USER/elpis)
  --data-dir DIR          agent data directory ("brain")       (default: ~USER/data)
  --repo-url URL          git URL to clone (default: the checkout this script
                          runs from, if any; else $DEFAULT_REPO_URL)
  --branch NAME           branch to check out                  (default: $DEFAULT_BRANCH)
  --timezone TZ           set the system timezone (IANA name; default: leave as-is)
  --locale LOCALE         generate + set a system locale, e.g. en_CA.UTF-8
                          (default: leave as-is)

Initial brain seeds:
  --agent-name NAME       generate a minimal SOUL.md for a brand-new agent
  --soul-file FILE        install an authored FILE as SOUL.md
  --memory-file FILE      install an authored FILE as MEMORY.md
                          (seeds are mode 0600 and never overwrite existing files;
                           --agent-name and --soul-file are mutually exclusive)

LLM endpoint (OpenAI-compatible):
  --llm-base-url URL      REQUIRED  e.g. https://api.openai.com/v1
  --llm-api-key KEY       REQUIRED
  --llm-model NAME        REQUIRED  whatever the endpoint serves
  --llm-context-size N    context window in tokens; omit ONLY if the endpoint
                          serves <base_url>/models/info (boot probes it)

Discord:
  --discord-token TOKEN   REQUIRED  bot token
  --operator-id ID        Discord user id allowed to run slash commands
  --error-channel-id ID   channel for harness error notices
  --guild-id ID           REQUIRED  the (single) guild for flag-based setup
  --guild-slug SLUG       REQUIRED  lowercase handle, e.g. "home"
  --channel ID:TIER       REQUIRED, repeatable  tier = direct|social|quiet
  --no-slash-commands     don't register slash commands in the guild
                          (multi-guild setups: use --config or interactive mode)

Optional integrations:
  --kagi-api-key KEY      enables elpis.search()/extract()

Config file mode:
  --config FILE           install FILE as config.yaml verbatim; skips all the
                          LLM/Discord/Kagi flags and prompts

Behavior:
  --non-interactive       no prompts; missing required values are fatal
  --no-start              install + enable but do not start the service
  --force-os              skip the Debian 13 check (unsupported)
  -h, --help              this text
EOF
}

ORIG_ARGS=("$@") # preserved for the sudo re-exec — the parse loop consumes $@

MODE_NONINTERACTIVE=0
AGENT_USER="$DEFAULT_USER"
HARNESS_DIR=""
DATA_DIR=""
REPO_URL=""
BRANCH="$DEFAULT_BRANCH"
TIMEZONE=""
LOCALE=""
AGENT_NAME=""
SOUL_FILE=""
MEMORY_FILE=""
LLM_BASE_URL=""
LLM_API_KEY=""
LLM_MODEL=""
LLM_CONTEXT_SIZE=""
DISCORD_TOKEN=""
OPERATOR_NAME="operator"
OPERATOR_PRONOUNS=""
OPERATOR_ID=""
ERROR_CHANNEL_ID=""
GUILD_ID=""
GUILD_SLUG=""
SLASH_COMMANDS="true"
CHANNELS=()
KAGI_API_KEY=""
CONFIG_FILE=""
START_SERVICE=1
FORCE_OS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive)    MODE_NONINTERACTIVE=1 ;;
    --user)               AGENT_USER="${2:?}"; shift ;;
    --harness-dir)        HARNESS_DIR="${2:?}"; shift ;;
    --data-dir)           DATA_DIR="${2:?}"; shift ;;
    --repo-url)           REPO_URL="${2:?}"; shift ;;
    --branch)             BRANCH="${2:?}"; shift ;;
    --timezone)           TIMEZONE="${2:?}"; shift ;;
    --locale)             LOCALE="${2:?}"; shift ;;
    --agent-name)         AGENT_NAME="${2:?}"; shift ;;
    --soul-file)          SOUL_FILE="${2:?}"; shift ;;
    --memory-file)        MEMORY_FILE="${2:?}"; shift ;;
    --llm-base-url)       LLM_BASE_URL="${2:?}"; shift ;;
    --llm-api-key)        LLM_API_KEY="${2:?}"; shift ;;
    --llm-model)          LLM_MODEL="${2:?}"; shift ;;
    --llm-context-size)   LLM_CONTEXT_SIZE="${2:?}"; shift ;;
    --discord-token)      DISCORD_TOKEN="${2:?}"; shift ;;
    --operator-name)      OPERATOR_NAME="${2:?}"; shift ;;
    --operator-pronouns)  OPERATOR_PRONOUNS="${2:?}"; shift ;;
    --operator-id)        OPERATOR_ID="${2:?}"; shift ;;
    --error-channel-id)   ERROR_CHANNEL_ID="${2:?}"; shift ;;
    --guild-id)           GUILD_ID="${2:?}"; shift ;;
    --guild-slug)         GUILD_SLUG="${2:?}"; shift ;;
    --channel)            CHANNELS+=("${2:?}"); shift ;;
    --no-slash-commands)  SLASH_COMMANDS="false" ;;
    --kagi-api-key)       KAGI_API_KEY="${2:?}"; shift ;;
    --config)             CONFIG_FILE="${2:?}"; shift ;;
    --no-start)           START_SERVICE=0 ;;
    --force-os)           FORCE_OS=1 ;;
    -h|--help)            usage; exit 0 ;;
 *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# preflight: on-disk script, seed inputs, root re-exec, OS check
# ---------------------------------------------------------------------------

[[ -z "$SOUL_FILE" || ( -f "$SOUL_FILE" && -r "$SOUL_FILE" ) ]] \
  || die "--soul-file is not a readable file: $SOUL_FILE"
[[ -z "$MEMORY_FILE" || ( -f "$MEMORY_FILE" && -r "$MEMORY_FILE" ) ]] \
  || die "--memory-file is not a readable file: $MEMORY_FILE"
[[ -z "$AGENT_NAME" || -z "$SOUL_FILE" ]] \
  || die "--agent-name and --soul-file are mutually exclusive"

[[ -f "${BASH_SOURCE[0]:-}" ]] \
  || die "this script must be run from a file on disk (not piped into bash) — download it first"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    say "${C_DIM}not root — re-executing under sudo…${C_RESET}"
    exec sudo bash "$SCRIPT_PATH" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  else
 # minimal base images ship without sudo — fall back to su (root password
 # prompt); the apt step then installs sudo for everything after
    say "${C_YELLOW}not root and sudo is not installed — falling back to su (enter the root password)${C_RESET}"
    _cmd="bash $(printf '%q' "$SCRIPT_PATH")"
    for _a in ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}; do _cmd+=" $(printf '%q' "$_a")"; done
    exec su root -c "$_cmd"
  fi
fi

if [[ "$FORCE_OS" -ne 1 ]]; then
  [[ -r /etc/os-release ]] || die "cannot read /etc/os-release"
  . /etc/os-release
  [[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "13" ]] \
    || die "this installer targets Debian 13 (found: ${ID:-?} ${VERSION_ID:-?}) — pass --force-os to override"
fi

# detect whether this script runs from inside a harness checkout (the common
# path: clone the repo anywhere, run deploy/install.sh) — used as clone source
LOCAL_SOURCE=""
_maybe_root="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
if [[ -f "$_maybe_root/package.json" ]] \
   && grep -q '"name": "elpis"' "$_maybe_root/package.json" 2>/dev/null; then
  LOCAL_SOURCE="$_maybe_root"
fi

# ---------------------------------------------------------------------------
# value gathering — interactive prompts or flag validation
# ---------------------------------------------------------------------------

# escape a value for use inside a double-quoted YAML scalar
yesc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

is_digits() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_slug()   { [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] && ! is_digits "$1"; }
is_tier()   { [[ "$1" == direct || "$1" == social || "$1" == quiet ]]; }

# ask VAR "prompt" "default"
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __ans
  if [[ -n "$__default" ]]; then
    read -r -p "  ${C_BOLD}${__prompt}${C_RESET} ${C_DIM}[${__default}]${C_RESET} " __ans
    __ans="${__ans:-$__default}"
  else
    read -r -p "  ${C_BOLD}${__prompt}${C_RESET} " __ans
  fi
  printf -v "$__var" '%s' "$__ans"
}

# ask_secret VAR "prompt" — no echo
ask_secret() {
  local __var="$1" __prompt="$2" __ans
  read -rs -p "  ${C_BOLD}${__prompt}${C_RESET} " __ans
  printf '\n'
  printf -v "$__var" '%s' "$__ans"
}

# ask_yn "prompt" default(y|n) → return 0 for yes
ask_yn() {
  local __prompt="$1" __default="$2" __ans __hint
  [[ "$__default" == y ]] && __hint="Y/n" || __hint="y/N"
  read -r -p "  ${C_BOLD}${__prompt}${C_RESET} ${C_DIM}[${__hint}]${C_RESET} " __ans
  __ans="${__ans:-$__default}"
  [[ "$__ans" =~ ^[Yy] ]]
}

require_nonempty() { [[ -n "$2" ]] || die "missing required value: $1 (see --help)"; }

GUILDS_YAML="" # accumulated `guilds:` list entries

append_guild_yaml() { # id slug slash_commands channels(newline-separated "id:tier")
  local id="$1" slug="$2" slash="$3" chans="$4" line cid tier
  GUILDS_YAML+="    - id: \"$id\"
      slug: $slug
      slash_commands: $slash
      channels:
"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    cid="${line%%:*}"; tier="${line#*:}"
    GUILDS_YAML+="        \"$cid\": $tier
"
  done <<< "$chans"
}

gather_interactive() {
  say "  ${C_DIM}This will set up this machine as the dedicated home of one agent."
  say "  Answers with a [default] can be accepted with Enter.${C_RESET}"

  printf '\n%s%s── machine ─────────────────────────────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  ask AGENT_USER   "Service user:" "$AGENT_USER"
  ask HARNESS_DIR  "Harness checkout dir:" "${HARNESS_DIR:-/home/$AGENT_USER/elpis}"
  ask DATA_DIR     "Data directory (the agent's brain):" "${DATA_DIR:-/home/$AGENT_USER/data}"
  if [[ -n "$LOCAL_SOURCE" ]]; then
    say "  ${C_DIM}source: this script runs inside a checkout at $LOCAL_SOURCE — it will be used as the clone source${C_RESET}"
  else
    ask REPO_URL "Harness git URL:" "${REPO_URL:-$DEFAULT_REPO_URL}"
  fi
  ask TIMEZONE "System timezone (blank = leave as-is):" "$TIMEZONE"

  printf '\n%s%s── the agent ───────────────────────────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  if [[ -n "$SOUL_FILE" ]]; then
    say "  ${C_DIM}authored SOUL seed: $SOUL_FILE${C_RESET}"
  else
    ask AGENT_NAME "New agent's name (blank = let them find one; seeds SOUL.md):" "$AGENT_NAME"
  fi
  [[ -n "$MEMORY_FILE" ]] && say "  ${C_DIM}authored MEMORY seed: $MEMORY_FILE${C_RESET}"

  if [[ -n "$CONFIG_FILE" ]]; then
    say "  ${C_DIM}--config $CONFIG_FILE supplied — skipping LLM/Discord/Kagi prompts${C_RESET}"
    confirm_summary
    return
  fi

  printf '\n%s%s── LLM endpoint (OpenAI-compatible) ────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  ask LLM_BASE_URL "Base URL:" "${LLM_BASE_URL:-https://api.openai.com/v1}"
  while [[ -z "$LLM_API_KEY" ]]; do ask_secret LLM_API_KEY "API key (hidden):"; done
  while [[ -z "$LLM_MODEL"   ]]; do ask LLM_MODEL "Model name:" "$LLM_MODEL"; done
  ask LLM_CONTEXT_SIZE "Context window in tokens (blank = probe models/info at boot):" "$LLM_CONTEXT_SIZE"

  printf '\n%s%s── Discord ─────────────────────────────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  while [[ -z "$DISCORD_TOKEN" ]]; do ask_secret DISCORD_TOKEN "Bot token (hidden):"; done
  ask OPERATOR_NAME "Operator display name:" "$OPERATOR_NAME"
  ask OPERATOR_PRONOUNS "Operator pronouns (blank = unset):" "$OPERATOR_PRONOUNS"
  ask OPERATOR_ID "Operator Discord user id (blank = slash commands disabled):" "$OPERATOR_ID"
  ask ERROR_CHANNEL_ID "Error-notice channel id (blank = log-only):" "$ERROR_CHANNEL_ID"

  say ""
  say "  ${C_DIM}Now the guild allowlist. A channel NOT listed here is never heard at"
  say "  all. Tiers: direct (responds to nearly everything), social (ambient"
  say "  participation), quiet (heard, rarely initiates).${C_RESET}"
  local n=0
  while true; do
    n=$((n + 1))
    printf '\n  %sguild #%d%s\n' "$C_CYAN" "$n" "$C_RESET"
    local gid="" gslug="" gslash="true" gchans=""
    while ! is_digits "${gid}"; do ask gid "Guild id:"; done
    while ! is_slug "${gslug}"; do ask gslug "Guild slug (lowercase handle, e.g. home):"; done
    if ask_yn "Register slash commands in this guild? (operator's home guild only)" "$([[ $n -eq 1 ]] && echo y || echo n)"; then
      gslash="true"
    else
      gslash="false"
    fi
    while true; do
      local cid="" ctier=""
      ask cid "  Channel id (blank = done with this guild):"
      [[ -z "$cid" ]] && { [[ -n "$gchans" ]] && break; warn "at least one channel is required"; continue; }
      is_digits "$cid" || { warn "channel id must be all digits"; continue; }
      while ! is_tier "${ctier}"; do ask ctier "  Tier for $cid (direct/social/quiet):" "social"; done
      gchans+="$cid:$ctier"$'\n'
      ok "#$cid → $ctier"
    done
    append_guild_yaml "$gid" "$gslug" "$gslash" "$gchans"
    ask_yn "Add another guild?" n || break
  done

  printf '\n%s%s── optional integrations ───────────────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  ask KAGI_API_KEY "Kagi API key for web search (blank = disabled):" "$KAGI_API_KEY"

  confirm_summary
}

confirm_summary() {
  printf '\n%s%s── summary ─────────────────────────────────────────%s\n' "$C_BOLD" "$C_MAGENTA" "$C_RESET"
  say "  user:         $AGENT_USER"
  say "  harness:      $HARNESS_DIR"
  say "  data dir:     $DATA_DIR"
  say "  source:       ${LOCAL_SOURCE:-$REPO_URL} (branch $BRANCH)"
  say "  agent name:   ${AGENT_NAME:-(unnamed — theirs to choose)}"
  say "  SOUL seed:    ${SOUL_FILE:-(generated/default)}"
  say "  MEMORY seed:  ${MEMORY_FILE:-(harness default)}"
  if [[ -n "$CONFIG_FILE" ]]; then
    say "  config:       $CONFIG_FILE (installed verbatim)"
  else
    say "  llm:          $LLM_MODEL @ $LLM_BASE_URL (key: ${#LLM_API_KEY} chars)"
    say "  context size: ${LLM_CONTEXT_SIZE:-(probe at boot)}"
    say "  operator:     ${OPERATOR_NAME} (${OPERATOR_PRONOUNS:-pronouns unset}), Discord ${OPERATOR_ID:-—}"
    say "  discord:      token ${#DISCORD_TOKEN} chars, errors → ${ERROR_CHANNEL_ID:-log-only}"
    say "  kagi:         $([[ -n "$KAGI_API_KEY" ]] && echo enabled || echo disabled)"
  fi
  say "  timezone:     ${TIMEZONE:-(unchanged)}"
  say ""
  ask_yn "Proceed with install?" y || die "aborted"
}

gather_noninteractive() {
  HARNESS_DIR="${HARNESS_DIR:-/home/$AGENT_USER/elpis}"
  DATA_DIR="${DATA_DIR:-/home/$AGENT_USER/data}"
  if [[ -z "$LOCAL_SOURCE" && -z "$REPO_URL" ]]; then
    REPO_URL="$DEFAULT_REPO_URL"
  fi
  if [[ -n "$CONFIG_FILE" ]]; then
    [[ -f "$CONFIG_FILE" ]] || die "--config file not found: $CONFIG_FILE"
    return
  fi
  require_nonempty "--llm-base-url"  "$LLM_BASE_URL"
  require_nonempty "--llm-api-key"   "$LLM_API_KEY"
  require_nonempty "--llm-model"     "$LLM_MODEL"
  require_nonempty "--discord-token" "$DISCORD_TOKEN"
  require_nonempty "--guild-id"      "$GUILD_ID"
  require_nonempty "--guild-slug"    "$GUILD_SLUG"
  [[ ${#CHANNELS[@]} -gt 0 ]] || die "at least one --channel ID:TIER is required (see --help)"
  is_digits "$GUILD_ID" || die "--guild-id must be all digits"
  is_slug "$GUILD_SLUG" || die "--guild-slug must match ^[a-z0-9][a-z0-9-]*\$ and not be all digits"
  local chans="" spec cid tier
  for spec in "${CHANNELS[@]}"; do
    cid="${spec%%:*}"; tier="${spec#*:}"
    is_digits "$cid" || die "bad --channel '$spec': id must be all digits"
    is_tier "$tier"  || die "bad --channel '$spec': tier must be direct|social|quiet"
    chans+="$cid:$tier"$'\n'
  done
  append_guild_yaml "$GUILD_ID" "$GUILD_SLUG" "$SLASH_COMMANDS" "$chans"
}

banner
if [[ "$MODE_NONINTERACTIVE" -eq 1 ]]; then
  gather_noninteractive
else
  [[ -t 0 ]] || die "stdin is not a TTY — use --non-interactive with flags (see --help)"
  gather_interactive
fi

# ---------------------------------------------------------------------------
# install steps
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive

step "Installing base packages (apt)"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git openssh-client \
  ffmpeg sqlite3 ripgrep jq tmux fish \
  build-essential python3 \
  sudo dbus-user-session dbus-x11 locales \
  xserver-xorg-core xserver-xorg-input-libinput xserver-xorg-video-fbdev xinit \
  openbox tint2 xdotool wmctrl scrot xclip x11-utils x11-xserver-utils xauth \
  firefox-esr xterm fonts-dejavu-core fonts-noto-color-emoji \
  >/dev/null
# The root-owned Xorg system service creates the per-agent authority file, but
# Xorg still requires its shared socket directory to be root-owned mode 1777.
install -d -o root -g root -m 1777 /tmp/.X11-unix
ok "base packages installed (shell/build tools, browser runtime, real Xorg/Openbox desktop)"

step "Installing Node $NODE_MAJOR (NodeSource)"
if command -v node >/dev/null 2>&1 && [[ "$(node --version)" == v$NODE_MAJOR.* ]]; then
  ok "node $(node --version) already present"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node --version), npm $(npm --version)"
fi
# prefer the apt-installed binary explicitly — a version manager (fnm/nvm) on
# PATH must not leak into the systemd unit
NODE_BIN="/usr/bin/node"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node)"
[[ "$("$NODE_BIN" --version)" == v$NODE_MAJOR.* ]] \
  || die "expected node v$NODE_MAJOR.x at $NODE_BIN, got $("$NODE_BIN" --version)"

step "Setting up service user '$AGENT_USER'"
if id -u "$AGENT_USER" >/dev/null 2>&1; then
  ok "user exists"
else
  useradd --create-home --shell /usr/bin/fish "$AGENT_USER"
  ok "user created (shell: fish)"
fi
AGENT_UID="$(id -u "$AGENT_USER")"
AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
usermod -aG sudo "$AGENT_USER"
# The agent owns this box by design (dedicated machine): elpis.sudo assumes
# passwordless sudo. Granted for the %sudo group AND the service user, as a
# drop-in validated by visudo. Do not install this harness on a shared machine.
_tmp="$(mktemp)"
printf '%%sudo ALL=(ALL:ALL) NOPASSWD: ALL\n%s ALL=(ALL:ALL) NOPASSWD: ALL\n' \
  "$AGENT_USER" > "$_tmp"
visudo -cf "$_tmp" >/dev/null || die "generated sudoers rule failed visudo validation"
install -m 0440 -o root -g root "$_tmp" "/etc/sudoers.d/90-$AGENT_USER"
rm -f "$_tmp"
ok "passwordless sudo granted (%sudo group + $AGENT_USER — dedicated-machine assumption)"
loginctl enable-linger "$AGENT_USER"
ok "systemd lingering enabled (user services run without a login session)"

# helper: run a command as the service user with a working user-manager bus
as_user() {
  sudo -u "$AGENT_USER" -H \
    env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" \
    "$@"
}

# lingering starts the per-user systemd instance asynchronously — wait for it
for _ in $(seq 1 30); do
  [[ -S "/run/user/$AGENT_UID/bus" ]] && break
  sleep 0.5
done
[[ -S "/run/user/$AGENT_UID/bus" ]] \
  || die "user manager for $AGENT_USER did not come up (/run/user/$AGENT_UID/bus missing)"

if [[ -n "$TIMEZONE" ]]; then
  step "Setting timezone"
  timedatectl set-timezone "$TIMEZONE"
  ok "timezone: $TIMEZONE"
fi

if [[ -n "$LOCALE" ]]; then
  step "Generating locale"
  sed -i "s|^# *${LOCALE}|${LOCALE}|" /etc/locale.gen
  grep -q "^${LOCALE}" /etc/locale.gen || echo "${LOCALE} UTF-8" >> /etc/locale.gen
  locale-gen >/dev/null
  update-locale "LANG=${LOCALE}"
  ok "locale: $LOCALE"
fi

step "Fetching the harness"
# Clone as root, then hand the tree to the service user. A bootstrap checkout
# may belong to the invoking non-root operator, so trust only that exact source
# for this command rather than weakening root's global safe.directory policy.
if [[ -d "$HARNESS_DIR/.git" ]]; then
  ok "existing checkout at $HARNESS_DIR — reusing"
elif [[ -n "$LOCAL_SOURCE" ]]; then
  _bootstrap_dir="$(mktemp -d)"
  _bootstrap_bundle="$_bootstrap_dir/bootstrap.bundle"
  if ! git -c safe.directory="$LOCAL_SOURCE" -c safe.directory="$LOCAL_SOURCE/.git" \
      -C "$LOCAL_SOURCE" bundle create "$_bootstrap_bundle" "refs/heads/$BRANCH"; then
    rm -rf "$_bootstrap_dir"
    die "failed to bundle local bootstrap checkout $LOCAL_SOURCE"
  fi
  if ! git clone --branch "$BRANCH" "$_bootstrap_bundle" "$HARNESS_DIR"; then
    rm -rf "$_bootstrap_dir"
    die "failed to clone local bootstrap bundle"
  fi
  rm -rf "$_bootstrap_dir"
 # keep origin pointed at the real remote, not the local bootstrap copy
  _origin="${REPO_URL:-$(git -C "$LOCAL_SOURCE" remote get-url origin 2>/dev/null || true)}"
  if [[ -n "$_origin" ]]; then
    git -C "$HARNESS_DIR" remote set-url origin "$_origin"
  fi
  ok "cloned from local checkout $LOCAL_SOURCE (origin: ${_origin:-unset})"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$HARNESS_DIR"
  ok "cloned $REPO_URL ($BRANCH)"
fi
chown -R "$AGENT_USER:$AGENT_USER" "$HARNESS_DIR"

step "Installing npm dependencies + building"
# Explicit --include=dev is load-bearing when the invoking environment carries
# NODE_ENV=production: TypeScript/tsx are needed for the build and test tools.
as_user bash -c "cd '$HARNESS_DIR' && npm ci --include=dev --no-audit --no-fund" \
  || die "npm ci failed"
ok "dependencies installed"
as_user bash -c "cd '$HARNESS_DIR' && npm run build" \
  || die "npm run build failed"
ok "built to dist/"

step "Installing Playwright Chromium"
"$HARNESS_DIR/node_modules/.bin/playwright" install-deps chromium >/dev/null \
  || die "Playwright browser system dependencies failed"
as_user bash -c "cd '$HARNESS_DIR' && node_modules/.bin/playwright-cli install-browser chromium" \
  || die "Playwright Chromium download failed"
ok "Playwright Chromium installed for $AGENT_USER"

step "Writing config.yaml"
CONFIG_PATH="$HARNESS_DIR/config.yaml"
if [[ -n "$CONFIG_FILE" ]]; then
  install -m 0600 -o "$AGENT_USER" -g "$AGENT_USER" "$CONFIG_FILE" "$CONFIG_PATH"
  ok "installed $CONFIG_FILE → $CONFIG_PATH (0600)"
else
  if [[ -f "$CONFIG_PATH" ]]; then
    cp -a "$CONFIG_PATH" "$CONFIG_PATH.bak.$(date +%s)"
    warn "existing config.yaml backed up"
  fi
  _tmp="$(mktemp)"
  {
    printf '# Generated by deploy/install.sh on %s\n' "$(date -Is)"
    printf '# Full reference: config.example.yaml / docs/config.md\n\n'
    printf 'llm:\n'
    printf '  api_key: "%s"\n' "$(yesc "$LLM_API_KEY")"
    printf '  base_url: "%s"\n' "$(yesc "$LLM_BASE_URL")"
    printf '  model: "%s"\n' "$(yesc "$LLM_MODEL")"
    if [[ -n "$LLM_CONTEXT_SIZE" ]]; then
      printf '  context_size: %s\n' "$LLM_CONTEXT_SIZE"
    fi
    printf '\noperator:\n'
    printf '  name: "%s"\n' "$(yesc "$OPERATOR_NAME")"
    [[ -n "$OPERATOR_PRONOUNS" ]] && printf '  pronouns: "%s"\n' "$(yesc "$OPERATOR_PRONOUNS")"
    [[ -n "$OPERATOR_ID" ]] && printf '  discord_id: "%s"\n' "$OPERATOR_ID"
    printf '\ndiscord:\n'
    printf '  bot_token: "%s"\n' "$(yesc "$DISCORD_TOKEN")"
    [[ -n "$ERROR_CHANNEL_ID" ]] && printf '  error_channel_id: "%s"\n' "$ERROR_CHANNEL_ID"
    printf '  guilds:\n'
    printf '%s' "$GUILDS_YAML"
    if [[ -n "$KAGI_API_KEY" ]]; then
      printf '\nkagi:\n  api_key: "%s"\n' "$(yesc "$KAGI_API_KEY")"
    fi
    printf '\npaths:\n  data_directory: "%s"\n' "$(yesc "$DATA_DIR")"
    printf '\nlog_level: info\n'
  } > "$_tmp"
  install -m 0600 -o "$AGENT_USER" -g "$AGENT_USER" "$_tmp" "$CONFIG_PATH"
  rm -f "$_tmp"
  ok "wrote $CONFIG_PATH (0600 — it holds live credentials)"
fi

step "Preparing data directory"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA_DIR"
install_seed() { # source destination label
  local source="$1" destination="$2" label="$3"
  [[ -n "$source" ]] || return 1
  if [[ -e "$destination" || -L "$destination" ]]; then
    if cmp -s "$source" "$destination"; then
      ok "$label already matches the authored seed"
    else
      warn "$label already exists — preserving the inhabitant's file; authored seed not installed"
    fi
    return 0
  fi
  install -m 0600 -o "$AGENT_USER" -g "$AGENT_USER" "$source" "$destination"
  ok "installed authored $label (0600)"
}

if ! install_seed "$SOUL_FILE" "$DATA_DIR/SOUL.md" "SOUL.md"; then
  if [[ -n "$AGENT_NAME" && ! -e "$DATA_DIR/SOUL.md" ]]; then
    _tmp="$(mktemp)"
    cat > "$_tmp" <<EOF
# SOUL.md

Your name is ${AGENT_NAME}. You are a new persistent agent, and this machine
is your home. This file is yours: it is read into every context you run in,
and you may rewrite it as you discover who you are. Nothing here is fixed.
EOF
    install -m 0600 -o "$AGENT_USER" -g "$AGENT_USER" "$_tmp" "$DATA_DIR/SOUL.md"
    rm -f "$_tmp"
    ok "seeded SOUL.md for $AGENT_NAME (0600)"
  fi
fi
install_seed "$MEMORY_FILE" "$DATA_DIR/MEMORY.md" "MEMORY.md" || true
ok "$DATA_DIR ready (the harness self-initializes any absent brain files and elpis-data/elpis.db)"

step "Installing systemd units"
stamp_unit() {
  local src="$1" dst="$2" owner="$3" group="$4"
  [[ -f "$src" ]] || die "unit template missing: $src"
  local tmp="$(mktemp)"
  sed -e "s|<HARNESS_ROOT>|$HARNESS_DIR|g" \
      -e "s|<NODE_BIN>|$NODE_BIN|g" \
      -e "s|<DATA_DIR>|$DATA_DIR|g" \
      -e "s|<AGENT_USER>|$AGENT_USER|g" \
      "$src" > "$tmp"
  install -D -m 0644 -o "$owner" -g "$group" "$tmp" "$dst"
  rm -f "$tmp"
  ok "unit installed: $dst"
}
stamp_unit "$HARNESS_DIR/deploy/$XORG_UNIT.service" "/etc/systemd/system/$XORG_UNIT.service" root root
stamp_unit "$HARNESS_DIR/deploy/$DESKTOP_UNIT.service" "$AGENT_HOME/.config/systemd/user/$DESKTOP_UNIT.service" "$AGENT_USER" "$AGENT_USER"
stamp_unit "$HARNESS_DIR/deploy/$SERVICE_UNIT.service" "$AGENT_HOME/.config/systemd/user/$SERVICE_UNIT.service" "$AGENT_USER" "$AGENT_USER"
chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.config" "$AGENT_HOME/.config/systemd" \
  "$AGENT_HOME/.config/systemd/user" 2>/dev/null || true
systemctl daemon-reload
as_user systemctl --user daemon-reload
systemctl enable "$XORG_UNIT" 2>/dev/null || die "systemctl enable $XORG_UNIT failed"
as_user systemctl --user enable "$DESKTOP_UNIT" "$SERVICE_UNIT" 2>/dev/null \
  || die "systemctl --user enable failed"
ok "Xorg system unit + desktop/harness user units enabled"

if [[ "$START_SERVICE" -eq 1 ]]; then
  step "Starting $XORG_UNIT + $DESKTOP_UNIT + $SERVICE_UNIT"
  systemctl restart "$XORG_UNIT" \
    || warn "Xorg restart returned nonzero — checking status anyway"
  as_user systemctl --user restart "$DESKTOP_UNIT" \
    || warn "desktop restart returned nonzero — checking status anyway"
  as_user systemctl --user restart "$SERVICE_UNIT" \
    || warn "harness restart returned nonzero — checking status anyway"
  sleep 4
  if [[ "$(systemctl is-active "$XORG_UNIT" || true)" == "active" ]]; then
    ok "$XORG_UNIT is active"
  else
    warn "$XORG_UNIT is not active yet — recent log:"
    journalctl --no-pager -u "$XORG_UNIT" -n 25 2>/dev/null || true
  fi
  for unit in "$DESKTOP_UNIT" "$SERVICE_UNIT"; do
    if [[ "$(as_user systemctl --user is-active "$unit" || true)" == "active" ]]; then
      ok "$unit is active"
    else
      warn "$unit is not active yet — recent log:"
      journalctl --no-pager -n 25 "_SYSTEMD_USER_UNIT=$unit.service" 2>/dev/null || true
    fi
  done
  say ""
  say "  ${C_DIM}first harness boot log:${C_RESET}"
  journalctl --no-pager -n 15 "_SYSTEMD_USER_UNIT=$SERVICE_UNIT.service" 2>/dev/null | sed 's/^/  /' || true
else
  warn "services installed but not started (--no-start)"
fi

# ---------------------------------------------------------------------------
# epilogue
# ---------------------------------------------------------------------------

printf '\n%s%s✦ install complete%s\n\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
say "  ${C_BOLD}Don't forget (Discord developer portal):${C_RESET}"
say "   • Bot → Privileged Gateway Intents → ${C_BOLD}Message Content Intent: ON${C_RESET}"
say "     (without it every message arrives empty — a silent failure, not a crash)"
say "   • Invite the bot with scopes ${C_BOLD}bot + applications.commands${C_RESET} and"
say "     Read/Send Messages permissions in the allowlisted channels"
say ""
say "  ${C_BOLD}Operating the harness${C_RESET} (as $AGENT_USER; over SSH set XDG_RUNTIME_DIR first):"
say "   ${C_DIM}export XDG_RUNTIME_DIR=/run/user/$AGENT_UID${C_RESET}"
say "   sudo systemctl status $XORG_UNIT           ${C_DIM}# real :0 / Proxmox display${C_RESET}"
say "   systemctl --user status $SERVICE_UNIT     ${C_DIM}# harness health${C_RESET}"
say "   systemctl --user status $DESKTOP_UNIT     ${C_DIM}# Openbox/tint2 session${C_RESET}"
say "   journalctl --user -u $SERVICE_UNIT -f     ${C_DIM}# live harness log${C_RESET}"
say ""
say "  ${C_BOLD}Console${C_RESET} (loopback-only by design — it exposes full reasoning):"
say "   ssh -L 8787:127.0.0.1:8787 $AGENT_USER@<this-host>  →  http://localhost:8787"
say ""
say "  config:  $CONFIG_PATH"
say "  data:    $DATA_DIR"
say "  harness: $HARNESS_DIR"
