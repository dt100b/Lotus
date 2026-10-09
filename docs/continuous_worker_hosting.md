# Continuous worker hosting

Pushing the current source to GitHub makes the project reproducible and provides
a deployment source. It does not start a server or preserve collected history.

## Hosting model

Run collectors as supervised services on an always-on Linux host with persistent
storage. Keep GitHub Actions for tests and controlled deployments. A self-hosted
runner is an agent on a machine you supply; it does not supply uptime, storage,
or failover. GitHub limits self-hosted workflow jobs to five days, and scheduled
workflows can be delayed or dropped during high load:

- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

An always-on service can still lose data during power, network, host, or exchange
outages. Use freshness alerts, backups, and a recovery procedure. The ATM and skew
collectors archive observations made while running; trade backfill cannot
reconstruct historical option quotes missed during downtime.

## Processes and persistent data

Use the same checkout and `project/runtime/dashboard_build` directory for the
collectors and API. The default ATM and skew cadence is 600 seconds on UTC
boundaries; the GEX worker normally runs every 60 seconds.

| Process | Entry point | Persistent output |
| --- | --- | --- |
| ATM IV | `project/scripts/collect_atm_term_curve.py` | `atm_term_curve_live.json`, `atm_term_refresh_status.json`, `atm_term_history/` |
| Skew | `project/scripts/collect_skew.py` | `local_skew_live.json`, `local_skew_refresh_status.json`, `local_skew_history_v1/` |
| GEX | `project/scripts/refresh_dashboard_live.py` | History database, inventory checkpoint, GEX snapshot |
| API/dashboard | `uvicorn project.api.main:app` | Reads the shared artifacts and owns the live ticker stream |

Keep `project/data/`, `project/runtime/`, and `project/greeks/data/` on persistent
storage and back them up separately from Git. For SQLite, use its online backup
API or stop writers before copying the database. Git deliberately excludes these
runtime directories. Frozen market data needed by tests lives under
`project/tests/fixtures/`; older committed options-surface diagnostics are retained.
Audit documents may reference additional captures kept locally under `runtime/`.

## Linux service setup

These commands are an operator template, not a record of a completed deployment.
Provision the host and a dedicated `lotus` user first. Clone the repository to
`/opt/lotus`, give that user access to the checkout and data directories, create
`/opt/lotus/.venv`, and install the project:

```bash
cd /opt/lotus
python3 -m venv .venv
.venv/bin/python -m pip install -e .
```

Transfer existing collected history and checkpoints before starting the services,
or initialize GEX history using the README backfill commands. Do not start two
GEX writers against the same database/checkpoint. ATM and skew each use an OS
lease to prevent duplicate collectors for the same artifacts directory.

The new unit templates assume `User=lotus` and `/opt/lotus`. Adjust both for your
host. Install and start the ATM and skew services:

```bash
sudo install -m 644 deploy/lotus-atm-collector.service /etc/systemd/system/
sudo install -m 644 deploy/lotus-skew-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lotus-atm-collector lotus-skew-collector
sudo systemctl status lotus-atm-collector lotus-skew-collector
journalctl -u lotus-atm-collector -u lotus-skew-collector -f
```

Configure the existing `deploy/lotus-live-refresh.service` for the same host/user
and install it separately. Supervise the API too, build `frontend/dist` with
`npm ci && npm run build`, and use a private network or authenticated HTTPS
reverse proxy to expose the dashboard. A dashboard running on another machine
must read these collectors' data through the hosted API or a deliberate transfer;
a remote worker does not update a local dashboard's files automatically.

Monitor each collector's status JSON and the ages of its successful captures in
addition to `/api/v1/health`, which reports GEX snapshot health. Alert when more
than two collection intervals pass without success, and check disk space and
service state. Confirm startup after reboot and recovery after network failure.

## GitHub runner role

A runner is optional. If used, register it on the intended deployment host and
run the runner agent as a service. Use short deployment jobs that install a
tested commit and restart the supervised worker services. Store durable data
outside the runner's disposable checkout; do not run collectors indefinitely
inside workflow jobs.

This repository is public. Keep deployment jobs restricted to trusted code and
explicitly authorized deployment triggers; do not execute fork pull requests on
a host with production data or deployment credentials. GitHub provides
[self-hosted runner security guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners).

No runner, server, credentials, or deployment workflow is registered by this
repository sync. Choose the actual host before configuring deployment.
