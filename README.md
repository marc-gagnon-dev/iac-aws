# iac-aws

Generic Pulumi foundation for an AWS Organization: OUs, SCPs, member accounts, and GitHub OIDC trust per account.

One copy of this repo = one AWS Organization, described by a single `org.yaml`. Design and rationale: [docs/design.md](docs/design.md).

## What you get

- An Organization with SCPs enabled, and the OU tree from `org.yaml`
- Member accounts created (or adopted) into their OUs, with root emails from one inbox via plus-addressing
- SCPs from [`policies/scp/`](policies/scp) attached to the root, OUs, or accounts
- In each account: GitHub's OIDC provider and one `github-<key>` role per entry in its `github` block, plus `iac-aws-readonly` for previews
- In the management account: `iac-aws-plan` (this repo's PRs, read-only) and `iac-aws-deploy` (this repo's `main`, admin)

## Bootstrap

Once per organization. You need Node 24, the Pulumi CLI, and a Pulumi Cloud account (free tier is fine).

1. **Create the copy.** On GitHub, "Use this template" → new private repo. Clone it.
2. **Describe the org.** `cp org.example.yaml org.yaml`, then edit it. Set `selfRepo` to the new repo. `npm ci && npm test` validates it.
3. **Create the management account.** Sign up for a new AWS account with your email (each organization needs its own management account, so use a fresh plus-address, e.g. `you+org-acme@gmail.com`). Turn on MFA for root.
4. **Create a temporary key.** In the root console: Security credentials → Create access key. Export it in your shell:
   ```bash
   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
   ```
   Prefer not to make a root key? Create an IAM user with `AdministratorAccess` and use its key instead. Everything else is the same.
5. **Deploy.**
   ```bash
   pulumi login
   pulumi stack init main
   pulumi up
   ```
   New accounts take a few minutes each. The stack outputs `planRoleArn` and `deployRoleArn`.
6. **Hand over to CI.** In the repo's Settings → Secrets and variables → Actions:
   - variables `IAC_AWS_PLAN_ROLE_ARN`, `IAC_AWS_DEPLOY_ROLE_ARN` (from the outputs) and `AWS_REGION` (same as `region` in `org.yaml`)
   - secret `PULUMI_ACCESS_TOKEN`
   - optional variable `PULUMI_STACK` if the stack is not called `main`
7. **Delete the temporary key** (or the IAM user). Commit `org.yaml` and push.

From then on: edit `org.yaml` in a PR, read the preview comment, merge to apply.

## Day to day

| Change | In `org.yaml` |
|---|---|
| New account | add an entry under `accounts` |
| Let a repo deploy to an account | add a role under that account's `github` with the repo's OIDC subject |
| New OU | add its path under `ous` |
| New guardrail | add `policies/scp/<name>.json`, then `<name>: [targets]` under `scps` |

OIDC subjects look like `repo:<owner>/<repo>:ref:refs/heads/main`, `repo:<owner>/<repo>:environment:production`, or `repo:<owner>/<repo>:pull_request`. In the workload repo, use `aws-actions/configure-aws-credentials` with `role-to-assume: arn:aws:iam::<account-id>:role/github-<key>`; the stack output `githubRoleArns` lists them.

Accounts are `protect`ed. Removing one from `org.yaml` fails until you unprotect it on purpose (`pulumi state unprotect`). Set `closeOnDeletion: true` on the account first if you want it closed rather than detached.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests cover the spec rules, SCP rendering and size limits, OIDC trust policies, and the whole program under Pulumi mocks against `org.example.yaml`.
