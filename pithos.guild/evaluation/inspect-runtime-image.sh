#!/bin/bash
# macOS Bash 3.2; inspect only. No selected program is executed.
set -eu
umask 077
export LC_ALL=C
[ "$#" -eq 0 ] || { echo 'No arguments accepted' >&2; exit 1; }
DOCKER=${DOCKER:-docker}
image=sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff
out=$(mktemp -d "${TMPDIR:-/tmp}/guild-image-inspect.XXXXXXXX")
echo "Output: $out"
: > "$out/inventory.tsv"
name="guild-inspect-${out##*.}-$$"
cid=''
creating=0
cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  # Recover only a complete ID actually returned by this create invocation.
  # Never inspect/delete a name: a collision may belong to somebody else.
  if [ -z "$cid" ] && [ "$creating" -eq 1 ]; then
    candidate=$(cat "$out/create-id.txt" 2>/dev/null) || candidate=''
    case "$candidate" in
      *[!a-f0-9]*|'') ;;
      *) if [ "${#candidate}" -eq 64 ]; then cid=$candidate; fi ;;
    esac
  fi
  if [ -n "$cid" ]; then
    if ! "$DOCKER" rm -v "$cid" > "$out/cleanup.txt" 2> "$out/cleanup-error.txt"; then
      echo "Cleanup failed; owned container ID: $cid" >&2
      result=1
    fi
  elif [ "$creating" -eq 1 ]; then
    echo "Creation outcome unknown. Do not remove by name automatically. Reconcile Docker manually: $name (see create-id.txt)." >&2
    result=1
  fi
  echo "Retained output: $out" >&2
  [ "$result" -ne 0 ] || echo 'Inspection complete; container removed. No runtime trust or gate approval.'
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# No portable macOS timeout is assumed. Foreground Docker operations may block.
# Ctrl-C aborts; creation cancellation is unresolved unless an ID was returned.
echo 'If Docker hangs, press Ctrl-C; see inspection documentation for reconciliation.' >&2
format='{{.Id}}{{printf "\t"}}{{.Os}}{{printf "\t"}}{{.Architecture}}{{printf "\t"}}{{index .Config "User"}}{{printf "\t"}}{{if index .Config "Volumes"}}true{{else}}false{{end}}'
"$DOCKER" image inspect --format "$format" "$image" > "$out/image.tsv" 2> "$out/image-error.txt"
# Reviewed metadata spellings only; neither attests a runtime UID or GID.
expected_numeric=$(printf '%s\tlinux\tarm64\t501\tfalse' "$image")
expected_named=$(printf '%s\tlinux\tarm64\tpi\tfalse' "$image")
metadata=$(cat "$out/image.tsv")
[ "$metadata" = "$expected_numeric" ] || [ "$metadata" = "$expected_named" ] || { echo 'Image ID/OS/architecture/user mismatch or declared volumes; stopped before create.' >&2; exit 1; }
creating=1
if "$DOCKER" create --pull=never --name "$name" --entrypoint=/__inspect_only_never_execute__ \
  --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=512m --cpus=1 --pids-limit=64 --user=501:501 "$image" \
  > "$out/create-id.txt" 2> "$out/create-error.txt"; then
  candidate=$(cat "$out/create-id.txt")
  case "$candidate" in *[!a-f0-9]*|'') echo 'Invalid returned container ID' >&2; exit 1;; esac
  [ "${#candidate}" -eq 64 ] || exit 1
  cid=$candidate
  creating=0
else
  echo 'Create failed; cleanup will use only a complete returned ID, never the name.' >&2
  exit 1
fi
root=/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent
# Original versioned native runtime13 roster and numbering remain unchanged.
paths=(
  /usr/bin/node
  "$root/package.json"
  "$root/dist/cli.js"
  "$root/dist/cli/setup.js"
  "$root/dist/core/http-dispatcher.js"
  "$root/dist/core/model-runtime.js"
  "$root/dist/core/agent-session.js"
  "$root/dist/core/resource-loader.js"
  "$root/dist/core/system-prompt.js"
  "$root/dist/core/auth-storage.js"
  "$root/node_modules/@earendil-works/pi-ai/package.json"
  "$root/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"
  "$root/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json"
)
# Reviewed supplemental STATIC observations only, not a dependency closure or
# additions to the native runtime requirement/policy/admitted digests.
supplemental_paths=(
  "$root/dist/main.js"
  "$root/dist/config.js"
)
mkdir "$out/files"
total=0
index=0
for path in "${paths[@]}" "${supplemental_paths[@]}"; do
  index=$((index + 1))
  classification=native-runtime13
  if [ "$index" -gt "${#paths[@]}" ]; then classification=supplemental-static; fi
  # Bash ulimit -f uses 1024-byte units; bound even a mistaken directory archive.
  # No -L: final symlinks must remain symlinks and will be rejected below.
  if ! (ulimit -f 131136; "$DOCKER" cp "$cid:$path" -) > "$out/leaf.tar" 2> "$out/copy-error.txt"; then
    printf '%s\tcopy-failed (missing or inaccessible; see copy-error.txt)\n' "$path" >> "$out/observations.tsv"
    exit 1
  fi
  if ! size=$(perl "$(dirname "$0")/inspect-runtime-leaf.pl" "$out/leaf.tar" "${path##*/}" "$out/files/$index" "$((268435456 - total))" 2> "$out/leaf-error.txt"); then
    printf '%s\trejected archive/type; see leaf-error.txt\n' "$path" >> "$out/observations.tsv"
    exit 1
  fi
  total=$((total + size))
  hash=$(shasum -a 256 "$out/files/$index")
  hash=${hash%% *}
  printf '%s\t%s\t%s\n' "$path" "$hash" "$classification" >> "$out/inventory.tsv"
  printf '%s\tregular\t%s bytes\tfiles/%s\n' "$path" "$size" "$index" >> "$out/observations.tsv"
  rm "$out/leaf.tar"
done
