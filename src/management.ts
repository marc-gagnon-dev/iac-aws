import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { READONLY_ROLE } from "./accounts";
import { GithubOidcTrust } from "./github-oidc";
import { Spec } from "./spec";
import { orgStateBackend, stateAccessPolicy } from "./state";

export const PLAN_ROLE = "iac-aws-plan";
export const DEPLOY_ROLE = "iac-aws-deploy";

export interface ManagementRoles {
  planRoleArn: pulumi.Output<string>;
  deployRoleArn: pulumi.Output<string>;
}

/**
 * Lets this repo's own workflows run Pulumi against the management account:
 * pull requests preview with read-only access, pushes to main deploy with admin.
 * Deploy reaches the state bucket and KMS key through AdministratorAccess; plan gets an explicit grant.
 */
export function createManagementTrust(
  spec: Spec,
  provider: aws.Provider,
  managementAccountId: pulumi.Input<string>,
): ManagementRoles {
  const trust = new GithubOidcTrust("management", {
    provider,
    roles: [
      {
        name: PLAN_ROLE,
        subjects: [`repo:${spec.selfRepo}:pull_request`],
        policies: ["arn:aws:iam::aws:policy/SecurityAudit"],
        inlinePolicy: pulumi.output(managementAccountId).apply((accountId) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Sid: "ReadMemberAccounts", Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::*:role/${READONLY_ROLE}` },
              { Sid: "FindIdentityCenter", Effect: "Allow", Action: "sso:ListInstances", Resource: "*" },
              ...stateAccessPolicy(orgStateBackend(accountId), "read"),
            ],
          }),
        ),
        maxSessionHours: 1,
      },
      {
        name: DEPLOY_ROLE,
        subjects: [`repo:${spec.selfRepo}:ref:refs/heads/main`],
        policies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
        maxSessionHours: 1,
      },
    ],
  });
  return { planRoleArn: trust.roleArns[PLAN_ROLE], deployRoleArn: trust.roleArns[DEPLOY_ROLE] };
}
