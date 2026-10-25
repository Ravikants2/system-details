# System Details

System Details has two opt-in, manual workflows:

1. A browser-only snapshot of browser, operating system, device category, and
   screen resolution.
2. A Windows PowerShell report for a computer you own or administer.

Neither workflow runs in the background, installs a service, or sends data
without an explicit confirmation.

## Private telemetry repository

The public website source is in `Ravikants2/system-details`. Machine reports
must go to the separate private repository `Ravikants2/system-details-data`.
The optional web API checks the GitHub repository visibility before writing
browser snapshots and refuses to use a public repository.

GitHub is storage, not an always-on server. The Windows collector runs locally
when a person starts it, and commits one report only after a separate upload
confirmation. GitHub Actions is not used to watch devices or collect telemetry.

### Local website and optional API

Requires Node.js 20.18 or newer. No npm packages are needed.

```powershell
Copy-Item .env.example .env
```

The example targets the private telemetry repository. For local development,
authenticate the GitHub CLI as an account with access to the private repo:

```powershell
gh auth login
```

The server can use the CLI's stored credential without copying a token into
`.env`. For a hosted Node server without GitHub CLI, set `GITHUB_TOKEN` in the
host's secret settings to a fine-grained token with **Contents: Read and write**
access to the private repo. Never put the token in `public/`, browser code, or a
committed file.

```powershell
npm start
```

Open `http://localhost:3000`. Without GitHub configuration, the local device
preview still works and snapshots download as local JSON files.

### Deploy the public dashboard to GitHub Pages

The website is a static Jekyll site. The workflow in
`.github/workflows/pages.yml` builds and deploys it when changes are pushed to
`main`. In the GitHub repository settings, enable Pages with **GitHub Actions**
as the build and deployment source. The published URL is:

<https://ravikants2.github.io/system-details/>

GitHub Pages cannot run the Node API. On Pages, an opted-in browser snapshot is
downloaded to the visitor's device; it is not uploaded. The public website
never reads or displays records from the private telemetry repo. The separate
Windows collector uploads to that private repo using the authenticated GitHub
CLI.

The Node API can be self-hosted separately if private browser-snapshot uploads
are needed. Store its GitHub credential only on that server.

### Windows manual report

The collector at
[`public/Collect-WindowsTelemetry.ps1`](./public/Collect-WindowsTelemetry.ps1)
supports Windows PowerShell and uploads with the GitHub CLI, not a token in
the script. Install [GitHub CLI](https://cli.github.com/) and authenticate as
`Ravikants2` with access to the private data repository:

```powershell
gh auth login
gh api repos/Ravikants2/system-details-data --jq .private
```

The second command must print `true`. Download the script, inspect it, and run
it in a visible PowerShell window:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Collect-WindowsTelemetry.ps1
```

`Bypass` applies only to that PowerShell process. The script does not change
the machine's execution policy. It asks the operator to type `COLLECT` before
reading details, previews the report, then requires a separate `UPLOAD`
confirmation before committing a JSON file.

The one-time report can include:

- Windows edition/build, model, processor, memory, and current boot time/uptime.
- The currently logged-in Windows account (not a history of other users'
  logins).
- Physical network adapter names, MAC addresses, and private IPv4 addresses.
- Up to 60 recent boot/shutdown event IDs from the previous 180 days. Access
  depends on local Windows event-log permissions.
- Up to 1,000 installed-application names, versions, publishers, and install
  dates found in standard uninstall registry entries.
- Public IP and ISP from `ipwho.is`. This necessarily sends a request from the
  device to that provider.
- An on-demand 5 MB download and 1 MB upload speed test to Cloudflare's
  `speed.cloudflare.com`.

The script warns about external requests before collection. IP/ISP lookup and
the speed test are best-effort; failures are shown and recorded in the report.
Reports include account names and network identifiers and should be treated
as sensitive. The collector does not collect passwords, keystrokes, files,
browsing history, process command lines, or telemetry from other devices.
It does not run at startup or on a schedule.

The current private-repository target is set at the top of the script. It
checks that the authenticated GitHub account is `Ravikants2` and that the
target repo is private before it collects. The upload payload is temporarily
written to the user's temp directory for GitHub CLI and removed after the
upload attempt; it is not kept as a local report.

## Storage and retention

Each confirmed upload creates a separate JSON file under `data/records/` in
the private repository. Git commits retain history; deleting a file does not
necessarily remove its earlier versions from repository history. Apply
repository access controls and retention procedures appropriate for sensitive
machine data. Do not change the telemetry repository to public.

## Validate

```powershell
npm test
```
