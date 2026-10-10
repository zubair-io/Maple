# Muse PR review runner

The `Muse PR Review` workflow runs on the repository-scoped GitHub Actions runner in Proxmox CT 126 (`github-runner`). The workflow requests the `self-hosted`, `Linux`, `X64`, and `maple-review` labels, so other CI workflows remain on GitHub-hosted runners.

The runner initiates outbound connections to GitHub Actions, GitHub, and Muse. It does not need a public listener, Cloudflare Tunnel, or inbound firewall rule. Reviews use the Muse CLI's authenticated account session; they do not use an OpenCode integration or a `MUSE` API-key secret. `gh` uses the job-scoped `GITHUB_TOKEN` only to fetch the PR diff and post the review comment.

## Container setup

CT 126 is an unprivileged Debian LXC. Install the current Linux x64 Actions runner by following the commands shown in **Maple → Settings → Actions → Runners → New self-hosted runner**. GitHub's page provides the current runner release and a one-hour registration token; never commit or save that token in the repository.

Run the service under a dedicated non-root account with no sudo access. Register it at the repository level for `https://github.com/zubair-io/Maple`, name it `maple-muse-ct126`, and add the `maple-review` custom label. Install and start the runner service with the `svc.sh` commands from GitHub's Linux runner instructions. Confirm its status is **Online** under the repository's runner settings before routing the workflow to it.

Install the Muse CLI in a system-wide path available to the `maplerunner` service account. Authenticate that account once with `muse login` and approve the sign-in as the Maple maintainer. Do not run the Actions service as root or copy root's private Muse credentials into the runner account. Install `gh` for the runner account as well; the workflow supplies `GH_TOKEN` only to the commands that call GitHub.

The workflow uses `pull_request_target` so GitHub loads its trusted workflow from the base repository. It checks out only the PR's base commit and fetches the PR diff as data. It must never check out or execute code from the PR head. A job-level guard skips pull requests whose head repository differs from Maple. The job has read-only contents access and pull-request comment permission; do not attach this runner to another repository or route general CI jobs to it.

Review verdicts are posted as comments. They do not fail the Actions check or block merging; CI status is determined by command success and the repository's other required checks.

## Runner recovery

If the runner is offline, Muse review jobs queue until it reconnects. Restore CT 126, then check the runner service with `systemctl status 'actions.runner.zubair-io-Maple.*.service'` and inspect its journal. Re-register only if the runner was removed from GitHub; registration tokens expire after one hour.

See [GitHub's runner setup instructions](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) for current Linux x64 download and service commands.
