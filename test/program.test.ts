import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

interface Created {
  type: string;
  name: string;
  inputs: Record<string, any>;
  protect?: boolean;
  retainOnDelete?: boolean;
  dependencies?: string[];
}

const created: Created[] = [];
const options = new Map<string, { protect?: boolean; retainOnDelete?: boolean; dependencies?: string[] }>();

beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource(args) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs, ...options.get(`${args.type} ${args.name}`) });
        const state: Record<string, any> = { ...args.inputs };
        let id = `${args.name}-id`;
        if (args.type === "aws:organizations/organization:Organization") {
          state.roots = [{ id: "r-root" }];
          state.masterAccountId = "000000000000";
        }
        if (args.type === "aws:organizations/account:Account") id = args.inputs.import ?? `1${String(created.length).padStart(11, "0")}`;
        if (args.type === "aws:iam/role:Role") state.arn = `arn:aws:iam::000000000000:role/${args.inputs.name}`;
        if (args.type === "aws:identitystore/group:Group") state.groupId = `${args.name}-group-id`;
        if (args.type === "aws:identitystore/user:User") state.userId = `${args.name}-user-id`;
        if (args.type === "aws:ssoadmin/permissionSet:PermissionSet") state.arn = `arn:aws:sso:::permissionSet/${args.name}`;
        if (args.type === "aws:s3/bucket:Bucket") state.arn = `arn:aws:s3:::${args.inputs.bucket}`;
        if (args.type === "aws:kms/key:Key") {
          id = `${args.name}-key-id`;
          state.keyId = id;
          state.arn = `arn:aws:kms:us-east-1:000000000000:key/${id}`;
        }
        if (args.type === "aws:iam/openIdConnectProvider:OpenIdConnectProvider") {
          state.arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com";
        }
        return { id, state };
      },
      call: (args) => {
        if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") return { accountId: "000000000000" };
        if (args.token === "aws:ssoadmin/getInstances:getInstances") {
          return { arns: ["arn:aws:sso:::instance/ssoins-test"], identityStoreIds: ["d-1234567890"] };
        }
        return args.inputs;
      },
    },
    "iac-aws",
    "test",
    false,
  );
  // Mocks never see resource options, so read protect, retainOnDelete and dependencies off the raw request.
  const monitor = pulumi.runtime.getMonitor() as any;
  const register = monitor.registerResource.bind(monitor);
  monitor.registerResource = (req: any, callback: any) => {
    options.set(`${req.getType()} ${req.getName()}`, {
      protect: req.getProtect(),
      retainOnDelete: req.getRetainondelete(),
      dependencies: req.getDependenciesList(),
    });
    return register(req, callback);
  };
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((r) => output.apply(r));
}

async function build() {
  const { availableScps, attachScps } = await import("../src/scps");
  const { loadSpec } = await import("../src/spec");
  const { createOrganization } = await import("../src/organization");
  const { createManagementTrust } = await import("../src/management");
  const { createAccounts, ORG_ACCESS_ROLE } = await import("../src/accounts");
  const { createAdminAccess } = await import("../src/identity-center");
  const { createBudgets } = await import("../src/budgets");
  const aws = await import("@pulumi/aws");

  const spec = loadSpec(path.join(__dirname, "..", "org.example.yaml"), availableScps());
  const provider = new aws.Provider("management", { region: spec.region });
  const org = createOrganization(spec, provider);
  const roles = createManagementTrust(spec, provider, "000000000000");
  const accounts = createAccounts({
    spec,
    ouIds: org.ouIds,
    provider,
    memberRole: ORG_ACCESS_ROLE,
    planRoleArn: roles.planRoleArn,
  });
  attachScps(
    spec,
    {
      organization: org.organization,
      rootId: org.rootId,
      ouIds: org.ouIds,
      accountIds: Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.account.id])),
    },
    provider,
  );
  await resolve(pulumi.all(Object.values(accounts).map((a) => a.account.id)));
  await resolve(pulumi.all(Object.values(accounts).flatMap((a) => Object.values(a.githubRoleArns))));
  await resolve(pulumi.all(Object.values(accounts).flatMap((a) => (a.pulumiState ? [a.pulumiState.backendUrl] : []))));
  const memberIds = Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.account.id]));
  const admins = createAdminAccess(spec, provider, { management: "000000000000", ...memberIds })!;
  const accessPortalUrl = await resolve(admins.accessPortalUrl);
  createBudgets(spec, provider, { management: "000000000000", ...memberIds });
  await new Promise((r) => setTimeout(r, 50));
  // Let pending registrations settle.
  await new Promise((r) => setTimeout(r, 50));
  const accountIds = await resolve(pulumi.all(memberIds));
  return { spec, accounts, accessPortalUrl, accountIds };
}

const ofType = (t: string) => created.filter((c) => c.type === t);

describe("program against org.example.yaml", () => {
  let built: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    built = await build();
  });

  it("creates the OU tree with implied parents", () => {
    const ous = ofType("aws:organizations/organizationalUnit:OrganizationalUnit");
    expect(ous.map((o) => o.inputs.name).sort()).toEqual(["NonProd", "Prod", "Sandbox", "Security", "Workloads"]);
    expect(ous.find((o) => o.inputs.name === "Workloads")!.inputs.parentId).toBe("r-root");
    expect(ous.find((o) => o.inputs.name === "Prod")!.inputs.parentId).toBe("ou-workloads-id");
  });

  it("creates each account in its OU with a templated email", () => {
    const accts = ofType("aws:organizations/account:Account");
    expect(accts.map((a) => a.name).sort()).toEqual(["app-dev", "app-prod", "log-archive"]);
    const prod = accts.find((a) => a.name === "app-prod")!;
    expect(prod.inputs).toMatchObject({
      email: "you+aws-app-prod@example.com",
      parentId: "ou-workloads-prod-id",
      roleName: "OrganizationAccountAccessRole",
    });
  });

  it("attaches every SCP to a resolved target id", () => {
    const attachments = ofType("aws:organizations/policyAttachment:PolicyAttachment");
    expect(attachments).toHaveLength(5);
    for (const a of attachments) expect(a.inputs.targetId).toBeTruthy();
    expect(attachments.find((a) => a.name === "scp-region-guard--sandbox")!.inputs.targetId).toBe("ou-sandbox-id");
  });

  it("creates every SCP only once the organization exists", () => {
    // Otherwise the first deploy creates them in parallel with the organization, and AWS rejects
    // them with AWSOrganizationsNotInUseException.
    const policies = ofType("aws:organizations/policy:Policy");
    expect(policies).toHaveLength(4);
    for (const p of policies) {
      expect(p.dependencies, p.name).toContainEqual(expect.stringMatching(/aws:organizations\/organization:Organization::organization$/));
    }
  });

  it("gives every member account a readonly role trusted by the management plan role", () => {
    const readonly = ofType("aws:iam/role:Role").filter((r) => r.inputs.name === "iac-aws-readonly");
    expect(readonly).toHaveLength(3);
    const trust = JSON.parse(readonly[0].inputs.assumeRolePolicy);
    expect(trust.Statement[0].Principal.AWS).toBe("arn:aws:iam::000000000000:role/iac-aws-plan");
  });

  it("creates GitHub roles only where the spec asks, plus the management pair", () => {
    const names = ofType("aws:iam/role:Role").map((r) => r.inputs.name).filter((n) => n !== "iac-aws-readonly").sort();
    expect(names).toEqual(["github-deploy", "github-deploy", "github-plan", "iac-aws-deploy", "iac-aws-plan"]);
    expect(ofType("aws:iam/openIdConnectProvider:OpenIdConnectProvider")).toHaveLength(3); // management, app-prod, app-dev
    const mgmtDeploy = ofType("aws:iam/role:Role").find((r) => r.inputs.name === "iac-aws-deploy")!;
    expect(JSON.parse(mgmtDeploy.inputs.assumeRolePolicy).Statement[0].Condition.StringLike).toEqual({
      "token.actions.githubusercontent.com:sub": ["repo:your-github-user@1234567/your-iac-aws-copy@890123456:ref:refs/heads/main"],
    });
  });

  it("lets the plan role read state but only write lock files", () => {
    const inline = ofType("aws:iam/rolePolicy:RolePolicy").find((p) => p.name === "management-iac-aws-plan-inline")!;
    const statements = JSON.parse(inline.inputs.policy).Statement;
    const writes = statements.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("s3:Put") || a.startsWith("s3:Delete")));
    expect(writes).toHaveLength(1);
    expect(writes[0].Resource).toBe("arn:aws:s3:::iac-aws-state-000000000000/.pulumi/locks/*");
    expect(statements.find((s: any) => s.Sid === "DecryptSecrets").Condition).toEqual({
      "ForAnyValue:StringEquals": { "kms:ResourceAliases": "alias/iac-aws-state" },
    });
  });

  it("creates a Pulumi state backend only in accounts that opt in", () => {
    const { accountIds } = built;
    const buckets = ofType("aws:s3/bucket:Bucket");
    expect(buckets.map((b) => b.inputs.bucket).sort()).toEqual(
      [`pulumi-state-${accountIds["app-dev"]}`, `pulumi-state-${accountIds["app-prod"]}`].sort(),
    );
    const keys = ofType("aws:kms/key:Key");
    expect(keys.map((k) => k.name).sort()).toEqual(["app-dev-pulumi-state", "app-prod-pulumi-state"]);
    for (const k of keys) expect(k.inputs.enableKeyRotation).toBe(true);
    const devKeyPolicy = JSON.parse(keys.find((k) => k.name === "app-dev-pulumi-state")!.inputs.policy);
    expect(devKeyPolicy.Statement).toEqual([
      expect.objectContaining({ Principal: { AWS: `arn:aws:iam::${accountIds["app-dev"]}:root` }, Action: "kms:*" }),
    ]);
    const aliases = ofType("aws:kms/alias:Alias");
    expect(aliases.map((a) => a.inputs.name)).toEqual(["alias/pulumi-state", "alias/pulumi-state"]);
    expect(aliases.find((a) => a.name === "app-dev-pulumi-state")!.inputs.targetKeyId).toBe("app-dev-pulumi-state-key-id");
  });

  it("locks the state bucket down and encrypts it with the state key", () => {
    const dev = (t: string) => ofType(t).find((r) => r.name === "app-dev-pulumi-state")!.inputs;
    expect(dev("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(dev("aws:s3/bucketOwnershipControls:BucketOwnershipControls").rule).toEqual({ objectOwnership: "BucketOwnerEnforced" });
    expect(dev("aws:s3/bucketVersioning:BucketVersioning").versioningConfiguration).toEqual({ status: "Enabled" });
    expect(dev("aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration").rules).toEqual([
      {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: "aws:kms",
          kmsMasterKeyId: "arn:aws:kms:us-east-1:000000000000:key/app-dev-pulumi-state-key-id",
        },
        bucketKeyEnabled: true,
      },
    ]);
    const [rule] = dev("aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration").rules;
    expect(rule).toMatchObject({ status: "Enabled", noncurrentVersionExpiration: { noncurrentDays: 90 } });
    const [tls] = JSON.parse(dev("aws:s3/bucketPolicy:BucketPolicy").policy).Statement;
    expect(tls).toMatchObject({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } });
  });

  it("never deletes a state backend, and protects its key and bucket", () => {
    const backend = created.filter((c) => c.name.endsWith("-pulumi-state"));
    expect(backend).toHaveLength(18); // 9 resources in each of app-dev and app-prod
    for (const r of backend) expect(r.retainOnDelete, `${r.type} ${r.name}`).toBe(true);
    const protectedTypes = backend.filter((r) => r.protect).map((r) => r.type);
    expect([...new Set(protectedTypes)].sort()).toEqual(["aws:kms/key:Key", "aws:s3/bucket:Bucket"]);
  });

  it("grants each GitHub role the state access it asks for", () => {
    const { accountIds } = built;
    const policy = (name: string) =>
      JSON.parse(ofType("aws:iam/rolePolicy:RolePolicy").find((p) => p.name === name)!.inputs.policy).Statement;
    const bucket = `arn:aws:s3:::pulumi-state-${accountIds["app-dev"]}`;
    const alias = { "ForAnyValue:StringEquals": { "kms:ResourceAliases": "alias/pulumi-state" } };

    const plan = policy("app-dev-github-plan-inline");
    expect(plan.find((s: any) => s.Sid === "ReadState")).toMatchObject({ Action: "s3:GetObject", Resource: `${bucket}/*` });
    const writes = plan.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("s3:Put") || a.startsWith("s3:Delete")));
    expect(writes).toHaveLength(1);
    expect(writes[0].Resource).toBe(`${bucket}/.pulumi/locks/*`);
    expect(plan.find((s: any) => s.Sid === "DecryptSecrets")).toMatchObject({
      Action: "kms:Decrypt",
      Resource: `arn:aws:kms:*:${accountIds["app-dev"]}:key/*`,
      Condition: alias,
    });
    // Lock files are SSE-KMS encrypted, so S3 needs a data key on the plan role's behalf.
    expect(plan.find((s: any) => s.Sid === "EncryptLocks")).toMatchObject({
      Action: "kms:GenerateDataKey",
      Condition: { ...alias, StringLike: { "kms:ViaService": "s3.*.amazonaws.com" } },
    });

    const deploy = policy("app-dev-github-deploy-inline");
    expect(deploy.find((s: any) => s.Sid === "WriteState")).toEqual({
      Sid: "WriteState",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `${bucket}/*`,
    });
    expect(deploy.find((s: any) => s.Sid === "UseStateKey")).toMatchObject({
      Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*"],
      Condition: alias,
    });
    expect(policy("app-prod-github-deploy-inline")[0].Resource).toBe(`arn:aws:s3:::pulumi-state-${accountIds["app-prod"]}`);
  });

  it("outputs how to log in to each state backend", async () => {
    const dev = built.accounts["app-dev"].pulumiState!;
    expect(await resolve(dev.backendUrl)).toBe(`s3://pulumi-state-${built.accountIds["app-dev"]}?region=us-east-1&awssdk=v2`);
    expect(dev.secretsProvider).toBe("awskms://alias/pulumi-state?region=us-east-1");
    expect(built.accounts["log-archive"].pulumiState).toBeUndefined();
  });

  it("points each member provider at its own account", () => {
    const providers = ofType("pulumi:providers:aws").filter((p) => p.name.startsWith("account-"));
    expect(providers).toHaveLength(3);
    for (const p of providers) {
      const roleArn = JSON.parse(p.inputs.assumeRoles)[0].roleArn as string;
      expect(roleArn).toMatch(/^arn:aws:iam::\d{12}:role\/OrganizationAccountAccessRole$/);
    }
  });

  it("gives the admin group AdministratorAccess in every account, management included", () => {
    const users = ofType("aws:identitystore/user:User");
    expect(users).toHaveLength(1);
    expect(users[0].inputs).toMatchObject({
      identityStoreId: "d-1234567890",
      userName: "you@example.com",
      displayName: "Your Name",
      emails: { value: "you@example.com", primary: true },
    });
    expect(ofType("aws:identitystore/groupMembership:GroupMembership")).toHaveLength(1);

    const permissionSet = ofType("aws:ssoadmin/permissionSet:PermissionSet");
    expect(permissionSet).toHaveLength(1);
    expect(permissionSet[0].inputs).toMatchObject({ name: "AdministratorAccess", sessionDuration: "PT8H" });

    const assignments = ofType("aws:ssoadmin/accountAssignment:AccountAssignment");
    expect(assignments.map((a) => a.name).sort()).toEqual([
      "admin-app-dev",
      "admin-app-prod",
      "admin-log-archive",
      "admin-management",
    ]);
    for (const a of assignments) {
      expect(a.inputs).toMatchObject({ principalType: "GROUP", targetType: "AWS_ACCOUNT", principalId: "admins-group-id" });
    }
    expect(assignments.find((a) => a.name === "admin-management")!.inputs.targetId).toBe("000000000000");
  });

  it("outputs the access portal URL", () => {
    expect(built.accessPortalUrl).toBe("https://d-1234567890.awsapps.com/start");
  });

  it("creates a monthly budget per key, filtered to its account", () => {
    const budgets = ofType("aws:budgets/budget:Budget");
    expect(budgets.map((b) => b.inputs.name).sort()).toEqual([
      "iac-aws-app-dev",
      "iac-aws-app-prod",
      "iac-aws-management",
      "iac-aws-organization",
    ]);
    const prod = budgets.find((b) => b.inputs.name === "iac-aws-app-prod")!.inputs;
    expect(prod).toMatchObject({ budgetType: "COST", limitAmount: "200", limitUnit: "USD", timeUnit: "MONTHLY" });
    expect(prod.costFilters).toEqual([{ name: "LinkedAccount", values: [expect.stringMatching(/^[0-9]{12}$/)] }]);
    const mgmt = budgets.find((b) => b.inputs.name === "iac-aws-management")!.inputs;
    expect(mgmt.costFilters).toEqual([{ name: "LinkedAccount", values: ["000000000000"] }]);
    const org = budgets.find((b) => b.inputs.name === "iac-aws-organization")!.inputs;
    expect(org.costFilters ?? []).toEqual([]);
  });

  it("alerts at each percentage on actual spend, plus the forecast", () => {
    const prod = ofType("aws:budgets/budget:Budget").find((b) => b.inputs.name === "iac-aws-app-prod")!.inputs;
    expect(prod.notifications.map((n: any) => [n.notificationType, n.threshold])).toEqual([
      ["ACTUAL", 50],
      ["ACTUAL", 80],
      ["ACTUAL", 100],
      ["FORECASTED", 100],
    ]);
    for (const n of prod.notifications) {
      expect(n).toMatchObject({
        comparisonOperator: "GREATER_THAN",
        thresholdType: "PERCENTAGE",
        subscriberEmailAddresses: ["you@example.com"],
      });
    }
  });
});
