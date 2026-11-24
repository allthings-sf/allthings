#!/usr/bin/env bash
# Installs the allthings CLI, `allthings`, in ~/.allthings/bin, with `atw`
# beside it as the old name for now.
#
#   curl -fsSL https://allthings.dev/install.bash | bash
#
# allthings.dev serves this file as it is here (web/scripts/build.ts).
#
# ALLTHINGS_VERSION=2.0.0-alpha.3 installs that (pre)release; the default is
# the latest stable release. ALLTHINGS_HOME moves the install (~/.allthings).
set -euo pipefail

repo="allthings-sf/allthings"
home_dir="${ALLTHINGS_HOME:-$HOME/.allthings}"
bin_dir="$home_dir/bin"
version="${ALLTHINGS_VERSION:-${ATW_VERSION:-}}"
# The old name's variable still works, with a note on stderr, as the CLI's
# old names do.
if [[ -z "${ALLTHINGS_VERSION:-}" && -n "${ATW_VERSION:-}" ]]; then
  echo "ATW_VERSION is now ALLTHINGS_VERSION. The old name still works for now and goes away in a later release." >&2
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux | darwin) ;;
  *)
    echo "No installer for $os. Download the binary from https://github.com/$repo/releases." >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
platform="bun-$os-$arch"

if [[ -z "$version" ]]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)
fi
if [[ -z "$version" ]]; then
  echo "Could not find the latest release." >&2
  exit 1
fi

mkdir -p "$bin_dir"
download=$(mktemp "$bin_dir/.allthings.XXXXXX")
trap 'rm -f "$download"' EXIT
base="https://github.com/$repo/releases/download/$version"
asset="allthings-$platform"
if ! curl -fsL -o "$download" "$base/$asset"; then
  # Releases before the rename used the atw-cli prefix.
  asset="atw-cli-$platform"
  if ! curl -fsSL -o "$download" "$base/$asset"; then
    echo "Release $version has no binary for $platform." >&2
    exit 1
  fi
fi

if manifest=$(curl -fsL "$base/SHA256SUMS"); then
  expected=$(awk -v asset="$asset" 'NF == 2 && $2 == asset { print $1 }' <<<"$manifest")
else
  # Existing releases predate SHA256SUMS. GitHub publishes its own digest
  # per asset in the release metadata. Never accept an undigested binary.
  metadata=$(curl -fsSL "https://api.github.com/repos/$repo/releases/tags/$version")
  if command -v jq >/dev/null; then
    digest=$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .digest // empty' <<<"$metadata")
  else
    digest=$(python3 -c 'import json, sys
print(next((a.get("digest") or "" for a in json.load(sys.stdin)["assets"] if a["name"] == sys.argv[1]), ""))' "$asset" <<<"$metadata")
  fi
  expected="${digest#sha256:}"
  [[ "$digest" == "sha256:$expected" ]] || { echo "No SHA-256 digest for $asset." >&2; exit 1; }
fi

if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Release $version has no valid SHA-256 checksum for $asset." >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum < "$download")
else
  actual=$(shasum -a 256 < "$download")
fi
if [[ "${actual%% *}" != "$expected" ]]; then
  echo "Checksum mismatch for $asset." >&2
  exit 1
fi
chmod 755 "$download"
mv "$download" "$bin_dir/allthings"
trap - EXIT
ln -sf allthings "$bin_dir/atw"

echo "Installed allthings $version in $bin_dir."
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add it to your PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo
"$bin_dir/allthings" --help
