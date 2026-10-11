# iac-aws

Generic Pulumi foundation for an AWS Organization: OUs, SCPs, member accounts, and GitHub OIDC trust per account.

One copy of this repo = one AWS Organization, described by a single `org.yaml`. Design and rationale: [docs/design.md](docs/design.md).

## What you get

- An Organization with SCPs enabled, and the OU tree from `org.yaml`
- Member accounts created (or adopted) into their OUs, with root emails from one inbox via plus-addressing
- SCPs from [`policies/scp/`](policies/scp) attached to the root, OUs, or accounts
- In each account: GitHub's OIDC provider and one `github-<key>` role per entry in its `github` block, plus `iac-aws-readonly` for previews
- In the management account: `iac-aws-plan` (this repo's PRs, read-only) and `iac-aws-deploy` (this repo's `main`, admin)
- Pulumi state in an S3 bucket in the management account, secrets encrypted with KMS. The bootstrap wizard creates both; the stack never manages its own backend

## Bootstrap

Once per organization. You need Node 24, the Pulumi CLI, the AWS CLI v2, the GitHub CLI (signed in), and git.

1. On GitHub, "Use this template" → new **private** repo. Clone it and `cd` into it.
2. `cp org.example.yaml org.yaml` and describe your organization. Set `selfRepo` to the new repo.
3. Run the wizard:
   ```bash
   bash scripts/bootstrap.sh
   ```

The wizard walks through eight stages, and every stage can be re-run safely:

| Stage | What happens |
|---|---|
| 1. Check tools and org.yaml | installs dependencies, runs the tests (which validate `org.yaml`) |
| 2. Create the management account | you sign up for a brand-new AWS account (fresh plus-address) and turn on root MFA |
| 3. Temporary admin user | as root in the console, you create IAM user `iac-aws-bootstrap` with `AdministratorAccess` and an access key; the key lives only in the wizard's environment, never on disk. Not a root key: root can't assume roles, which the deploy needs |
| 4. State backend | creates the KMS key `alias/iac-aws-state` and the bucket `iac-aws-state-<account-id>` (versioned, private, TLS only) |
| 5. Pulumi stack | creates stack `main` in that bucket, with secrets encrypted by the KMS key |
| 6. First deploy | `pulumi up`: organization, OUs, SCPs, accounts, OIDC roles |
| 7. Hand over to CI | sets the repo variables, commits `org.yaml` and `Pulumi.main.yaml`, pushes, and waits for the `up` workflow to pass |
| 8. Delete the temporary admin user | you delete `iac-aws-bootstrap`; the wizard checks its key no longer works |

From then on: edit `org.yaml` in a PR, read the preview comment, merge to apply.

## Day to day

| Change | In `org.yaml` |
|---|---|
| New account | add an entry under `accounts` |
| Let a repo deploy to an account | add a role under that account's `github` with the repo's OIDC subject |
| New OU | add its path under `ous` |
| New guardrail | add `policies/scp/<name>.json`, then `<name>: [targets]` under `scps` |

OIDC subjects look like `repo:<owner>/<repo>:ref:refs/heads/main`, `repo:<owner>/<repo>:environment:production`, or `repo:<owner>/<repo>:pull_request`. Repos created after 2026-07-15 use GitHub's immutable form, `repo:<owner>@<owner-id>/<repo>@<repo-id>:...`; get a repo's prefix with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix`. The subject must match exactly, or AWS rejects the job. In the workload repo, use `aws-actions/configure-aws-credentials` with `role-to-assume: arn:aws:iam::<account-id>:role/github-<key>`; the stack output `githubRoleArns` lists them.

Accounts are `protect`ed. Removing one from `org.yaml` fails until you unprotect it on purpose (`pulumi state unprotect`). Set `closeOnDeletion: true` on the account first if you want it closed rather than detached.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests cover the spec rules, SCP rendering and size limits, OIDC trust policies, and the whole program under Pulumi mocks against `org.example.yaml`.
