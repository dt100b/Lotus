#!/usr/bin/env bash
# Run on the cloud VM: sudo bash deploy/install-ubuntu.sh
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi
if [[ ! -f /etc/os-release ]] || ! command -v systemctl >/dev/null; then
  echo 'This installer requires Ubuntu with systemd.' >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID} != ubuntu ]]; then
  echo 'Use an Ubuntu VM (24.04 LTS recommended).' >&2
  exit 1
fi

app_root=/opt/lotus
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y git python3-venv curl ca-certificates xz-utils
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required; use Ubuntu 24.04 LTS"'
if ! id lotus >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /home/lotus --shell /usr/sbin/nologin lotus
fi
if [[ ! -d ${app_root}/.git ]]; then
  if [[ -e ${app_root} ]]; then
    echo '/opt/lotus already exists without a Git checkout; inspect it before proceeding.' >&2
    exit 1
  fi
  install -d -o lotus -g lotus "${app_root}"
  runuser -u lotus -- git clone https://github.com/dt100b/Lotus.git "${app_root}"
fi
# Re-running uses the existing checkout and never resets it or overwrites data.
cd "${app_root}"
runuser -u lotus -- python3 -m venv .venv
runuser -u lotus -- .venv/bin/python -m pip install --upgrade pip
runuser -u lotus -- .venv/bin/python -m pip install -e .
runuser -u lotus -- mkdir -p project/data project/runtime/dashboard_build project/greeks/data

# Use official Node 22 binaries; Ubuntu 24.04's distro Node is too old for Vite 8.
# Verify the downloaded archive against Node's published SHA-256 manifest.
runuser -u lotus -- .venv/bin/python - <<'PY'
import hashlib
import pathlib
import platform
import re
import subprocess
import tempfile
import urllib.request

arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
base = 'https://nodejs.org/dist/latest-v22.x/'
manifest = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
matches = [line.split() for line in manifest.splitlines()
           if re.search(r'node-v22\.\d+\.\d+-linux-' + arch + r'\.tar\.xz$', line)]
if len(matches) != 1:
    raise SystemExit('Cannot identify the official Node archive')
expected, filename = matches[0]
node_root = pathlib.Path('/opt/lotus/.node')
node_root.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='lotus-node-') as temporary:
    archive = pathlib.Path(temporary) / filename
    with urllib.request.urlopen(base + filename, timeout=120) as response, archive.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    with archive.open('rb') as downloaded:
        if hashlib.file_digest(downloaded, 'sha256').hexdigest() != expected:
            raise SystemExit('Node archive checksum mismatch')
    subprocess.run(['tar', '-xJf', str(archive), '-C', str(node_root), '--strip-components=1'], check=True)
print('Installed official Node 22:', filename)
PY

cd "${app_root}/frontend"
runuser -u lotus -- env PATH="${app_root}/.node/bin:${PATH}" npm ci --no-audit --no-fund
runuser -u lotus -- env PATH="${app_root}/.node/bin:${PATH}" npm run build
cd "${app_root}"

# Confirm public market-data connectivity before enabling collection.
runuser -u lotus -- .venv/bin/python - <<'PY'
import httpx
with httpx.Client(timeout=30) as client:
    response = client.get('https://www.deribit.com/api/v2/public/get_index_price',
                          params={'index_name': 'btc_usd'})
    response.raise_for_status()
    result = response.json()
    if result.get('error') or not result.get('result', {}).get('index_price'):
        raise SystemExit('Deribit market-data preflight failed')
print('Deribit market-data connectivity passed')
PY

for unit in lotus-atm-collector lotus-skew-collector lotus-api lotus-live-refresh; do
  install -m 644 "deploy/${unit}.service" /etc/systemd/system/
done
systemd-analyze verify /etc/systemd/system/lotus-{atm-collector,skew-collector,api,live-refresh}.service
systemctl daemon-reload
systemctl enable --now lotus-atm-collector lotus-skew-collector lotus-api
systemctl is-active lotus-atm-collector lotus-skew-collector lotus-api
echo 'ATM, skew, and API services are enabled. API listens privately on 127.0.0.1:8000.'
echo 'Restore GEX history/checkpoints before enabling lotus-live-refresh.'
echo 'See /opt/lotus/docs/google_cloud_setup.md for transfer and verification steps.'
