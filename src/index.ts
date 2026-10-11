import * as path from "node:path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createAccounts, ORG_ACCESS_ROLE, READONLY_ROLE } from "./accounts";
import { createBudgets } from "./budgets";
import { createAdminAccess } from "./identity-center";
import { createManagementTrust } from "./management";
import { createOrganization } from "./organization";
import { attachScps, availableScps } from "./scps";
import { loadSpec } from "./spec";

const spec = loadSpec(path.join(__dirname, "..", "org.yaml"), availableScps());

// Deploys reach member accounts as ORG_ACCESS_ROLE. PR previews set IAC_AWS_MODE=plan and
// read them as READONLY_ROLE instead, so pull request code never holds admin credentials.
const mode = process.env.IAC_AWS_MODE ?? "deploy";
if (mode !== "deploy" && mode !== "plan") throw new Error(`IAC_AWS_MODE must be "deploy" or "plan", got "${mode}"`);

const management = new aws.Provider("management", {
  region: spec.region,
  defaultTags: { tags: { "managed-by": "iac-aws" } },
});

const managementAccountId = aws.getCallerIdentityOutput({}, { provider: management }).accountId;

const org = createOrganization(spec, management);
const roles = createManagementTrust(spec, management, managementAccountId);
const accounts = createAccounts({
  spec,
  ouIds: org.ouIds,
  provider: management,
  memberRole: mode === "plan" ? READONLY_ROLE : ORG_ACCESS_ROLE,
  planRoleArn: roles.planRoleArn,
});
const memberAccountIds = Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.account.id]));
attachScps(spec, { rootId: org.rootId, ouIds: org.ouIds, accountIds: memberAccountIds }, management);
// The wizard's first deploy sets this when Identity Center is not enabled yet: it can only be
// enabled once the organization exists, which that same deploy creates. CI never sets it.
const skipAdmins = process.env.IAC_AWS_SKIP_IDENTITY_CENTER === "1";
if (skipAdmins && spec.identityCenter) pulumi.log.warn("Skipping Identity Center admins (IAC_AWS_SKIP_IDENTITY_CENTER=1)");
const allAccountIds = { management: managementAccountId, ...memberAccountIds };
const admins = skipAdmins ? undefined : createAdminAccess(spec, management, allAccountIds);
createBudgets(spec, management, allAccountIds);

export const organizationId = org.organization.id;
export { managementAccountId };
export const planRoleArn = roles.planRoleArn;
export const deployRoleArn = roles.deployRoleArn;
export const accountIds = memberAccountIds;
export const githubRoleArns = Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.githubRoleArns]));
export const ouIds = org.ouIds;
export const accessPortalUrl = admins?.accessPortalUrl;
