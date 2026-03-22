#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "${script_dir}/.." && pwd)"
image="${RECAPPI_DOCKER_IMAGE:-recappi-sdk-linux-dev}"
platform="${RECAPPI_DOCKER_PLATFORM:-linux/amd64}"

docker build \
  --platform "${platform}" \
  -f "${root_dir}/docker/linux-dev.Dockerfile" \
  -t "${image}" \
  "${root_dir}"

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

quoted_args=()
for arg in "$@"; do
  quoted_args+=("$(printf '%q' "${arg}")")
done

docker run --rm \
  --platform "${platform}" \
  -e YARN_INSTALL_STATE_PATH=/tmp/yarn-install-state.gz \
  -v "${root_dir}:/src:ro" \
  "${image}" \
  bash -lc "set -euo pipefail && rm -rf /workspace && mkdir -p /workspace && cd /src && tar --exclude='./.git' --exclude='./node_modules' --exclude='./target' --exclude='./dist' --exclude='./recording.*.node' -cf - . | tar -xf - -C /workspace && cd /workspace && ${quoted_args[*]}"
