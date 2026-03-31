#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${script_dir}/docker-linux.sh" bash -lc "yarn install && cargo test && yarn build --target x86_64-unknown-linux-gnu && yarn test"
