import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as time from "@pulumiverse/time";
import { GithubOidcTrust } from "./github-oidc";
import { accountEmail, Spec } from "./spec";

/** Role Organizations creates in every account it vends. Deploys reach member accounts through it. */
export const ORG_ACCESS_ROLE = "OrganizationAccountAccessRole";
/** Read-only role this stack creates in every member account for PR previews. */
export const READONLY_ROLE = "iac-aws-readonly";

export interface MemberAccount {
  account: aws.organizations.Account;
  provider: aws.Provider;
  githubRoleArns: Record<string, pulumi.Output<string>>;
}

export interface AccountsArgs {
  spec: Spec;
  ouIds: Record<string, pulumi.Input<string>>;
  /** Management-account provider. */
  provider: aws.Provider;
  /** Role assumed in each member account: ORG_ACCESS_ROLE to deploy, READONLY_ROLE to preview. */
  memberRole: string;
  /** Management-account role allowed to assume READONLY_ROLE. */
  planRoleArn: pulumi.Input<string>;
}

export function createAccounts(args: AccountsArgs): Record<string, MemberAccount> {
  const { spec, provider } = args;
  const result: Record<string, MemberAccount> = {};

  for (const [key, acct] of Object.entries(spec.accounts)) {
    const account = new aws.organizations.Account(
      key,
      {
        name: acct.name ?? key,
        email: accountEmail(spec, key),
        parentId: args.ouIds[acct.ou],
        roleName: ORG_ACCESS_ROLE,
        iamUserAccessToBilling: "ALLOW",
        closeOnDeletion: acct.closeOnDeletion,
      },
      {
        provider,
        // Closing or detaching an account is slow and hard to undo. Remove protection deliberately.
        protect: true,
        import: acct.id,
        // AWS only applies these at creation; the API cannot change them afterwards.
        ignoreChanges: ["roleName", "iamUserAccessToBilling", "email", "name"],
      },
    );

    // A freshly created account's ORG_ACCESS_ROLE takes a short while to become assumable.
    // The sleep runs once, when the account is first created or adopted.
    const ready = new time.Sleep(`${key}-ready`, { createDuration: "60s" }, { dependsOn: account });

    const accountProvider = new aws.Provider(`account-${key}`, {
      region: spec.region,
      allowedAccountIds: [account.id],
      assumeRoles: [
        {
          roleArn: pulumi.interpolate`arn:aws:iam::${account.id}:role/${args.memberRole}`,
          sessionName: "iac-aws",
        },
      ],
      defaultTags: { tags: { "managed-by": "iac-aws" } },
    }, { dependsOn: ready });

    const readonly = new aws.iam.Role(
      `${key}-${READONLY_ROLE}`,
      {
        name: READONLY_ROLE,
        assumeRolePolicy: pulumi.output(args.planRoleArn).apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { AWS: arn }, Action: "sts:AssumeRole" }],
          }),
        ),
        description: "Lets iac-aws PR previews read this account",
      },
      { provider: accountProvider },
    );
    new aws.iam.RolePolicyAttachment(
      `${key}-${READONLY_ROLE}-SecurityAudit`,
      { role: readonly.name, policyArn: "arn:aws:iam::aws:policy/SecurityAudit" },
      { provider: accountProvider },
    );

    const roles = Object.entries(acct.github).map(([roleKey, role]) => ({ name: `github-${roleKey}`, ...role }));
    const githubRoleArns =
      roles.length > 0 ? new GithubOidcTrust(key, { provider: accountProvider, roles }).roleArns : {};

    result[key] = { account, provider: accountProvider, githubRoleArns };
  }

  return result;
}
