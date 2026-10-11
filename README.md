# iac-aws

Generic Pulumi foundation for an AWS Organization: OUs, SCPs, member accounts, and GitHub OIDC trust per account.

One copy of this repo = one AWS Organization, described by a single `org.yaml`. Design and rationale: [docs/design.md](docs/design.md).

## What you get

- An Organization with SCPs enabled, and the OU tree from `org.yaml`
- Member accounts created (or adopted) into their OUs, with root emails from one inbox via plus-addressing
- SCPs from [`policies/scp/`](policies/scp) attached to the root, OUs, or accounts
- In each account: GitHub's OIDC provider and one `github-<key>` role per entry in its `github` block, plus `iac-aws-readonly` for previews
- In the management account: `iac-aws-plan` (this repo's PRs, read-only) and `iac-aws-deploy` (this repo's `main`, admin)
- Optional human admins: IAM Identity Center users in an `iac-aws-admins` group with `AdministratorAccess` in every account, management included, signing in at the access portal (stack output `accessPortalUrl`)
- Optional monthly cost budgets per account (and for the whole organization), emailing you at the percentages you choose
- Optional Pulumi state backend per account for workload repos' stacks (S3 bucket and KMS key), with read or write access for its `github-<key>` roles
- Pulumi state in an S3 bucket in the management account, secrets encrypted with KMS. The bootstrap wizard creates both; the stack never manages its own backend

## Bootstrap

Once per organization. You need Node 24, the Pulumi CLI, the AWS CLI v2, the GitHub CLI (signed in), and git.

1. On GitHub, "Use this template" → new **private** repo. Clone it and `cd` into it.
2. `cp org.example.yaml org.yaml` and describe your organization. Set `selfRepo` to the new repo.
3. Run the wizard:
   ```bash
   bash scripts/bootstrap.sh
   ```

The wizard walks through nine stages, and every stage can be re-run safely:

| Stage | What happens |
|---|---|
| 1. Check tools and org.yaml | installs dependencies, runs the tests (which validate `org.yaml`) |
| 2. Create the management account | you sign up for a brand-new AWS account (fresh plus-address) and turn on root MFA |
| 3. Temporary admin user | as root in the console, you create IAM user `iac-aws-bootstrap` with `AdministratorAccess` and an access key; the key lives only in the wizard's environment, never on disk. Not a root key: root can't assume roles, which the deploy needs |
| 4. State backend | creates the KMS key `alias/iac-aws-state` and the bucket `iac-aws-state-<account-id>` (versioned, private, TLS only) |
| 5. Pulumi stack | creates stack `main` in that bucket, with secrets encrypted by the KMS key |
| 6. First deploy | `pulumi up`: organization, OUs, SCPs, accounts, OIDC roles |
| 7. IAM Identity Center | only if `org.yaml` has `identityCenter`: you enable it in the console (it needs the organization from stage 6) and turn on "Send email OTP" |
| 8. Hand over to CI | sets the repo variables, commits `org.yaml` and `Pulumi.main.yaml`, pushes, and waits for the `up` workflow to pass; that run creates the admins |
| 9. Delete the temporary admin user | you delete `iac-aws-bootstrap`; the wizard checks its key no longer works |

From then on: edit `org.yaml` in a PR, read the preview comment, merge to apply.

## Day to day

| Change | In `org.yaml` |
|---|---|
| New account | add an entry under `accounts` (admins get access to it automatically) |
| Budget for an account | add it under `budgets.monthly` (key `organization` covers every account together) |
| New admin | add them under `identityCenter.admins`; they sign in at the access portal with their email and get a one-time code |
| Let a repo deploy to an account | add a role under that account's `github` with the repo's OIDC subject |
| Give a repo's stacks somewhere to keep state | `pulumiState: true` on the account, and `pulumiState: write` (deploys) or `read` (previews) on its roles |
| New OU | add its path under `ous` |
| New guardrail | add `policies/scp/<name>.json`, then `<name>: [targets]` under `scps` |

OIDC subjects look like `repo:<owner>/<repo>:ref:refs/heads/main`, `repo:<owner>/<repo>:environment:production`, or `repo:<owner>/<repo>:pull_request`. Repos created after 2026-07-15 use GitHub's immutable form, `repo:<owner>@<owner-id>/<repo>@<repo-id>:...`; get a repo's prefix with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix`. The subject must match exactly, or AWS rejects the job. In the workload repo, use `aws-actions/configure-aws-credentials` with `role-to-assume: arn:aws:iam::<account-id>:role/github-<key>`; the stack output `githubRoleArns` lists them.

Accounts are `protect`ed. Removing one from `org.yaml` fails until you unprotect it on purpose (`pulumi state unprotect`). Set `closeOnDeletion: true` on the account first if you want it closed rather than detached.

## Pulumi state for workload repos

A workload repo's stacks need a backend, and a stack must never own its own backend (it could delete its own state). So this repo provides one, in the workload's own account, for each account with `pulumiState: true`:

| | Name |
|---|---|
| S3 bucket | `pulumi-state-<account-id>`, in `region`: versioned, SSE-KMS with the key below, private, TLS only; overwritten state versions expire after 90 days |
| KMS key | `alias/pulumi-state`, rotated yearly; encrypts the bucket and the stacks' secrets |

The names are fixed, so a workload repo needs only the account ID and region (the stack output `pulumiStateBackends` has both URLs per account):

```bash
pulumi login "s3://pulumi-state-<account-id>?region=<region>&awssdk=v2"
pulumi stack init <stack> --secrets-provider "awskms://alias/pulumi-state?region=<region>"
```

In GitHub Actions, set `PULUMI_BACKEND_URL` (or `pulumi/actions`' `cloud-url`) to the same `s3://` URL. Each role gets the access its `pulumiState` asks for:

- `write`, for deploys: read, write and delete state; encrypt and decrypt with the key.
- `read`, for previews: read state, write only lock files (a preview takes the stack lock), decrypt secrets. `ReadOnlyAccess` alone can do neither of the last two.

The backend is never deleted by this stack: every part of it is `retainOnDelete`, and the key and bucket are also `protect`ed so nothing replaces them. To turn it off, unprotect those two (`pulumi stack --show-urns | grep pulumi-state`, then `pulumi state unprotect '<urn>'` for the key and the bucket), then remove `pulumiState` from the account. The stack forgets the backend; the bucket, key and state stay in the account until you delete them by hand.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests cover the spec rules, SCP rendering and size limits, OIDC trust policies, state backend access, and the whole program under Pulumi mocks against `org.example.yaml`.
