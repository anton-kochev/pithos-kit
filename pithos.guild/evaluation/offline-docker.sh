#!/usr/bin/env bash
# Host-only isolation. Optional fixed synthetic Pi probe; never pulls/builds images or mounts a Pi home.
set -euo pipefail
umask 077
if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ || ( $# == 2 && "$2" != --synthetic-pi && "$2" != --synthetic-guild ) ]]; then
  printf 'Usage: bash pithos.guild/evaluation/offline-docker.sh SOURCE_CONTAINER [--synthetic-pi | --synthetic-guild]\n' >&2
  exit 2
fi
source_container=$1
mode=--verify
if [[ $# == 2 ]]; then mode=$2; fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd "$script_dir/../.." && pwd -P)
uid=$(id -u); gid=$(id -g)
[[ "$uid" != 0 ]] || { printf 'Run this script as a non-root host user.\n' >&2; exit 1; }
[[ "$repo" != *','* && "$repo" != *$'\n'* ]] || { printf 'Checkout paths containing commas/newlines are unsupported.\n' >&2; exit 1; }
[[ ! -L "$repo/.pi" && ! -L "$repo/.pi/evaluation" ]] || exit 1
mkdir -p "$repo/.pi/evaluation"
output=$(mktemp -d "$repo/.pi/evaluation/offline-docker.XXXXXXXX")
printf 'Artifacts: %s\n' "$output"
mkdir "$output/harness" "$output/evidence"
cid=''; owned_name=''; owner=${output##*/}
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -z "$cid" && -n "$owned_name" ]]; then
    if [[ $(docker inspect --format '{{index .Config.Labels "pithos.guild.offline-run"}}' "$owned_name" 2>/dev/null) == "$owner" ]]; then
      cid=$owned_name
    else
      printf 'Container creation outcome unknown; inspect %s and its ownership label on the host.\n' "$owned_name" >&2
      code=1
    fi
  fi
  if [[ -n "$cid" ]]; then
    if docker inspect --format '{"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"memoryLimit":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"pidsLimit":{{json .HostConfig.PidsLimit}},"nanoCpus":{{.HostConfig.NanoCpus}}}' "$cid" >"$output/docker-final-state.json" 2>"$output/docker-final-state.stderr"; then
      printf '0\n' >"$output/docker-final-state-exit-code.txt"
    else
      printf '1\n' >"$output/docker-final-state-exit-code.txt"
      printf 'Final container state unavailable; cleanup will still be attempted.\n' >&2
      code=1
    fi
    if ! docker rm --force "$cid" >"$output/cleanup.stdout" 2>"$output/cleanup.stderr"; then
      printf 'Container cleanup failed; inspect container %s on the host.\n' "$cid" >&2
      code=1
    fi
  fi
  printf '%s\n' "$code" >"$output/host-exit-code.txt"
  if [[ "$code" != 0 ]]; then printf 'Offline harness failed; retained artifacts: %s\n' "$output" >&2; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
assets='offline-runtime.ts offline-state.ts offline-verify.ts'
if [[ "$mode" != --verify ]]; then
  assets="$assets offline-probe.ts offline-bootstrap.ts offline-synthetic.ts offline-capture.ts native-launch.ts native-preload.ts native-config.ts native-input-contracts.ts native-policy.ts native-runtime-input.ts native-session.ts native-request.ts scoped-auth-identity.ts manifest.ts pricing.ts response-observer.ts"
fi
if [[ "$mode" == --synthetic-guild ]]; then
  assets="$assets offline-guild-bootstrap.ts offline-guild-admission.ts offline-guild-evidence.ts offline-diagnostics.ts child-observer.ts limits.ts trace.ts"
  guild_dir=$(cd "$script_dir/.." && pwd -P)
  for directory in src extensions agents agents/roles agents/profiles skills skills/conventional-commit; do
    [[ -d "$guild_dir/$directory" && ! -L "$guild_dir/$directory" ]] || exit 1
  done
  guild_assets='package.json extensions/index.ts src/agents.ts src/commit.ts src/guild.ts src/logging.ts src/run-queue.ts src/runner.ts src/safety.ts src/ui.ts src/visibility.ts skills/conventional-commit/SKILL.md'
  for role in explorer architect coder reviewer; do guild_assets="$guild_assets agents/roles/$role.md"; done
  for profile in general frontend angular typescript dotnet rust; do guild_assets="$guild_assets agents/profiles/$profile.md"; done
  for asset in $guild_assets; do
    [[ -f "$guild_dir/$asset" && ! -L "$guild_dir/$asset" ]] || exit 1
    [[ $(wc -c <"$guild_dir/$asset") -le 1048576 ]] || exit 1
    mkdir -p "$output/harness/guild/$(dirname "$asset")"
    cp "$guild_dir/$asset" "$output/harness/guild/$asset"
  done
fi
for asset in $assets; do
  [[ -f "$script_dir/src/$asset" && ! -L "$script_dir/src/$asset" ]] || exit 1
  cp "$script_dir/src/$asset" "$output/harness/$asset"
done
source_info=$(docker inspect --format '{{.State.Running}}|{{.Image}}' "$source_container")
[[ "$source_info" =~ ^true\|sha256:[a-f0-9]{64}$ ]] || { printf 'Select a running container with an immutable image ID.\n' >&2; exit 1; }
image=${source_info#true|}
[[ $(docker image inspect --format '{{len .Config.Volumes}}' "$image") == 0 ]] || { printf 'Images declaring automatic volumes are unsupported.\n' >&2; exit 1; }
# Static reads only, with a clean environment; never imports Pi or reads auth/home.
docker exec -i "$source_container" /usr/bin/env -i PATH=/usr/bin:/bin \
  /usr/bin/node --input-type=module-typescript - --fingerprint \
  <"$output/harness/offline-runtime.ts" >"$output/harness/expected-runtime.json" 2>"$output/inventory.stderr"
[[ -s "$output/harness/expected-runtime.json" ]] || exit 1
owned_name="guild-offline-${output##*.}"
printf '%s\n' "$owned_name" >"$output/container-name.txt"
cid=$(docker create --name "$owned_name" --label "pithos.guild.offline-run=$owner" --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true --user "$uid:$gid" --ipc private --init \
  --pids-limit 64 --memory 512m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --mount "type=bind,source=$output/harness,target=/harness,readonly" \
  --mount "type=bind,source=$output/evidence,target=/evidence" \
  --entrypoint /usr/bin/env "$image" -i PATH=/usr/bin:/bin HOME=/tmp/guild-offline \
  TMPDIR=/tmp/guild-offline PI_CODING_AGENT_DIR=/tmp/guild-offline PI_OFFLINE=1 \
  /usr/bin/node /harness/offline-verify.ts "$mode")
[[ "$cid" =~ ^[a-f0-9]{64}$ ]] || { cid=''; exit 1; }
policy=$(docker inspect --format '{{.Image}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.Config.User}}|{{.HostConfig.PidMode}}|{{.HostConfig.IpcMode}}|{{.HostConfig.UTSMode}}|{{len .HostConfig.Devices}}' "$cid")
# Separate mount inventory, sorted because Docker does not promise mount ordering.
mounts=$(docker inspect --format '{{range .Mounts}}{{printf "%s:%s:%t\n" .Type .Destination .RW}}{{end}}' "$cid" | LC_ALL=C sort | grep -v '^$')
expected="$image|none|false|true|[\"ALL\"]|[\"no-new-privileges=true\"]|$uid:$gid||private||0"
[[ "$policy" == "$expected" ]] || { printf 'Docker isolation policy mismatch; container not started.\n' >&2; exit 1; }
[[ "$mounts" == $'bind:/evidence:true\nbind:/harness:false' ]] || { printf 'Unexpected container mounts; container not started.\n' >&2; exit 1; }
printf '%s\n' "$policy" >"$output/docker-policy.txt"
printf '%s\n' "$mounts" >"$output/docker-mounts.txt"
docker start --attach "$cid" >"$output/container.stdout" 2>"$output/container.stderr"
[[ $(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$cid") == 'exited|0' ]] || exit 1
[[ -f "$output/evidence/verification.json" && ! -L "$output/evidence/verification.json" && -s "$output/evidence/verification.json" ]] || exit 1
grep -qx 'OFFLINE_VERIFIED' "$output/container.stdout" || exit 1
if [[ "$mode" == --synthetic-guild ]]; then
  [[ -f "$output/evidence/synthetic-guild/summary.json" && ! -L "$output/evidence/synthetic-guild/summary.json" && -s "$output/evidence/synthetic-guild/summary.json" ]] || exit 1
  grep -qx 'SYNTHETIC_GUILD_VERIFIED' "$output/container.stdout" || exit 1
  printf 'Synthetic Guild checks finished. Review %s/evidence/synthetic-guild/summary.json\n' "$output"
elif [[ "$mode" == --synthetic-pi ]]; then
  [[ -f "$output/evidence/synthetic/summary.json" && ! -L "$output/evidence/synthetic/summary.json" && -s "$output/evidence/synthetic/summary.json" ]] || exit 1
  grep -qx 'SYNTHETIC_PI_VERIFIED' "$output/container.stdout" || exit 1
  printf 'Synthetic CLI checks finished. Review %s/evidence/synthetic/summary.json\n' "$output"
else
  printf 'Readiness checks finished. Review %s/evidence/verification.json\n' "$output"
fi
