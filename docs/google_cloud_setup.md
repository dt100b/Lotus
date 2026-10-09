# Google Cloud setup for Lotus

## Create the VM

In the selected Google Cloud project, go to Compute Engine > VM instances >
Create instance. Suggested starting settings:

| Setting | Value |
| --- | --- |
| Name | `lotus-worker` |
| Region / zone | `us-central1` / `us-central1-a`, or another suitable region |
| Machine family / type | E2 / `e2-medium` (4 GB RAM, shared CPU) |
| Provisioning model | Standard, not Spot |
| OS | Ubuntu 24.04 LTS, x86/64; ordinary Ubuntu, not Ubuntu Pro |
| Boot disk | 50 GB balanced persistent disk initially; monitor free space |
| External IP | Ephemeral IPv4 for initial access and outbound connectivity |
| HTTP / HTTPS firewall boxes | Leave unchecked for private SSH access |

This is a trial-credit configuration, not the ongoing free `e2-micro` tier.
Check the console's estimated cost before creating it; disk and external IPv4
are also billable resources. E2-medium exposes two shared vCPUs and supplies
one vCPU's sustained CPU time in total. Increase the machine size if measurements
show that GEX replay or other computation cannot keep up.

Official references: [VM creation](https://docs.cloud.google.com/compute/docs/create-linux-vm-instance),
[machine specifications](https://docs.cloud.google.com/compute/docs/general-purpose-machines#e2_shared-core),
and [trial conditions](https://docs.cloud.google.com/free/docs/free-cloud-features).

After the VM starts, click its SSH button to open the browser terminal.
Run installation commands there, not in Cloud Shell or your local PowerShell.
If the default network lacks an SSH firewall rule, configure SSH access using
[Google's connection instructions](https://docs.cloud.google.com/compute/docs/connect/ssh-in-browser).

## Install and start independent collection

In the VM's SSH terminal:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/dt100b/Lotus.git ~/lotus-setup
sudo bash ~/lotus-setup/deploy/install-ubuntu.sh
```

If `~/lotus-setup` already exists, inspect/use that checkout rather than cloning
on top of it. The installer creates a dedicated service user and a checkout at
`/opt/lotus`, installs Python dependencies and checksum-verified official Node 22
binaries, builds the dashboard, and checks Deribit public market-data access.
If access fails, inspect the reported error and provider availability before
proceeding. No exchange account credentials are required by these public collectors.

It installs four service definitions and starts ATM, skew, and the API. It leaves
the GEX worker unstarted on a new install until history has been restored. This
avoids presenting a newly collected thin trade window as the existing dealer book.
Re-running the installer keeps the existing `/opt/lotus` checkout and data. It
does not automatically pull changes or restart already-running services; after
an intentional update, restart the affected services separately.

The first ATM and skew collection should occur shortly after service startup.
Subsequent observations use ten-minute UTC boundaries. Check successful capture
times, not only whether the process is running:

```bash
sudo systemctl --no-pager status lotus-atm-collector lotus-skew-collector lotus-api
sudo journalctl -u lotus-atm-collector -u lotus-skew-collector -n 60 --no-pager
sudo cat /opt/lotus/project/runtime/dashboard_build/atm_term_refresh_status.json
sudo cat /opt/lotus/project/runtime/dashboard_build/local_skew_refresh_status.json
```

Keep the PC collectors running during preparation if you need uninterrupted
local history. Before the final archive transfer, stop the local writers and
confirm their processes have exited. Before restoring collected archives on the
VM, stop its ATM/skew collectors and API too so restored files cannot race writers.
The GEX worker also starts ATM/skew threads, but OS leases prevent duplicate
standalone collectors for the same artifacts directory.

## Transfer existing history

GitHub does not contain your 1.4 GB history database or collected archives.
The handover needs:

- `project/data/phase1_history.sqlite3`
- `project/runtime/dashboard_build/` (checkpoint, GEX history, ATM and skew archives)
- `project/greeks/data/` (including the last GEX snapshot)

Use a SQLite online backup or stop the local database writer before copying it.
For a coherent checkpoint/archive handover, stopping local workers during the
export is preferred. Copying an actively written database file alone is unsafe.
Do not replace the source data or delete your local copy during migration.

After stopping all local writers, run in PowerShell:

```powershell
Set-Location C:\Lotus-1
tar -czf project/runtime/lotus-cloud-handover.tar.gz project/data/phase1_history.sqlite3 project/runtime/dashboard_build project/greeks/data
```

The export file is inside ignored `project/runtime/` and outside the included
directories. Transfer it with `gcloud compute scp` after installing and signing
into the Google Cloud CLI on the PC:

```powershell
gcloud compute scp "C:\Lotus-1\project\runtime\lotus-cloud-handover.tar.gz" lotus-worker:~/lotus-cloud-handover.tar.gz --zone=us-central1-a --project=YOUR_PROJECT_ID
```

Replace project, VM name, and zone with the actual values. Google documents
[file transfer](https://docs.cloud.google.com/compute/docs/instances/transfer-files)
and [CLI installation](https://docs.cloud.google.com/sdk/docs/install).
Do not paste passwords or account tokens into the chat.

In the VM SSH terminal, stop cloud writers, restore the trusted archive, and
give the service user access:

```bash
sudo systemctl stop lotus-atm-collector lotus-skew-collector lotus-api
# Stop GEX too if this is a repeat migration to an already-running deployment.
sudo systemctl stop lotus-live-refresh
sudo install -o lotus -g lotus -m 600 ~/lotus-cloud-handover.tar.gz /opt/lotus/project/runtime/lotus-cloud-handover.tar.gz
sudo -u lotus tar -xzf /opt/lotus/project/runtime/lotus-cloud-handover.tar.gz -C /opt/lotus
```

The archive restores the local history captured at export time. Cloud captures
made before this restore are replaced by that archive, so keep the final handover
short and preserve the source archive until verification is complete.

If the trade history gap exceeds the main-host retention window, use the
history-host catch-up commands in the Phase 6 runbook before starting GEX.
Then enable the GEX worker and restart the other services:

```bash
sudo systemctl enable --now lotus-live-refresh
sudo systemctl start lotus-atm-collector lotus-skew-collector lotus-api
curl --fail http://127.0.0.1:8000/api/v1/health
sudo journalctl -u lotus-live-refresh -n 60 --no-pager
```

Verify the existing history is visible, fresh captures continue, and GEX health
becomes fresh after a completed refresh. Check that all four services are enabled
and recover after a VM reboot. Keep local history and the transfer archive until
that verification succeeds.

## View the cloud dashboard privately

From the PC, create an SSH tunnel using the Google Cloud CLI:

```powershell
gcloud compute ssh lotus-worker --zone=us-central1-a --project=YOUR_PROJECT_ID -- -N -L 8001:127.0.0.1:8000
```

Leave that command running and open `http://localhost:8001/dashboard` in a browser.
Port 8001 avoids conflicting with your existing local API on port 8000. Closing
the tunnel or turning off the PC does not stop the VM's collectors. Reconnect
the tunnel whenever you want to view the dashboard. GEX-backed routes can return
503 until the history and snapshot have been restored.

## Before relying on it

Monitor the ATM/skew success timestamps separately from GEX `/api/v1/health`,
watch free disk space, and arrange off-VM backups of the data. A process marked
active can still be failing every data request. Billing budget alerts are
notifications, not a spending cap. Plan the paid-tier transition or migration
before trial credit expires; otherwise Google stops the trial resources.

The installer is repository preparation. It does not provision a VM, establish
a cloud account connection, transfer existing data, or prove runtime behavior
on a Linux server until you execute and verify it there.
