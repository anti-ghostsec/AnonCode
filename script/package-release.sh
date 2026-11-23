#!/bin/sh
# Packages a Linux release: package-release.sh <version> <built app binary>.
# The archive has everything AnonCode needs to start: the source, the app
# built from it, Bun, and the agent's dependencies already installed, so
# unpacking it and running ./anoncode is all there is to do.
set -eu
version=$1
app=$(readlink -f "$2")
root=$(cd "$(dirname "$0")/.." && pwd)
name="AnonCode-$version-linux-x86_64"
out=$(pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
dir="$stage/$name"

mkdir -p "$dir"
git -C "$root" archive --format=tar "${ANONCODE_REF:-HEAD}" | tar -x -C "$dir"

# Bun, the version the project is pinned to. The baseline build, so it
# also runs on CPUs without AVX2.
bun_version=$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$root/package.json")
[ -n "$bun_version" ] || { echo "package.json names no bun version" >&2; exit 1; }
zip=bun-linux-x64-baseline.zip
url="https://github.com/oven-sh/bun/releases/download/bun-v$bun_version"
curl -fsSL -o "$stage/$zip" "$url/$zip"
curl -fsSL -o "$stage/SHASUMS256.txt" "$url/SHASUMS256.txt"
(cd "$stage" && grep " $zip\$" SHASUMS256.txt | sha256sum -c -)
mkdir -p "$dir/bin"
unzip -q -j "$stage/$zip" '*/bun' -d "$dir/bin"
chmod 755 "$dir/bin/bun"

# The agent's dependencies, exactly as the lockfile has them.
(cd "$dir" && ./bin/bun install --frozen-lockfile --ignore-scripts --production)

mkdir -p "$dir/packages/anoncode/target/release"
cp "$app" "$dir/packages/anoncode/target/release/anoncode"

tar -C "$stage" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
