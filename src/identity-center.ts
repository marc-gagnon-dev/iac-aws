import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { slug, Spec } from "./spec";

export const ADMIN_GROUP = "iac-aws-admins";
export const ADMIN_PERMISSION_SET = "AdministratorAccess";

export interface AdminAccess {
  accessPortalUrl: pulumi.Output<string>;
}

/**
 * Human admins: Identity Center users in one group, given AdministratorAccess in every
 * account (members and management). Identity Center itself is enabled once in the console
 * (the bootstrap wizard walks through it); AWS has no API to create an organization instance.
 */
export function createAdminAccess(
  spec: Spec,
  provider: aws.Provider,
  accountIds: Record<string, pulumi.Input<string>>,
): AdminAccess | undefined {
  const ic = spec.identityCenter;
  if (!ic) return undefined;

  const instances = aws.ssoadmin.getInstancesOutput({}, { provider });
  const first = (values: string[], what: string) => {
    if (!values.length) {
      throw new Error(
        `IAM Identity Center is not enabled in ${spec.region} (no ${what}). Enable it once in the management ` +
          `account console, in ${spec.region}, then re-run. See scripts/bootstrap.sh stage 7.`,
      );
    }
    return values[0];
  };
  const instanceArn = instances.arns.apply((a) => first(a, "instance"));
  const identityStoreId = instances.identityStoreIds.apply((a) => first(a, "identity store"));

  const group = new aws.identitystore.Group(
    "admins",
    { identityStoreId, displayName: ADMIN_GROUP, description: "AdministratorAccess in every account, managed by iac-aws" },
    { provider },
  );

  for (const admin of ic.admins) {
    const name = `admin-${slug(admin.email)}`;
    const user = new aws.identitystore.User(
      name,
      {
        identityStoreId,
        userName: admin.email,
        displayName: `${admin.givenName} ${admin.familyName}`,
        name: { givenName: admin.givenName, familyName: admin.familyName },
        emails: { value: admin.email, primary: true, type: "work" },
      },
      { provider },
    );
    new aws.identitystore.GroupMembership(
      name,
      { identityStoreId, groupId: group.groupId, memberId: user.userId },
      { provider },
    );
  }

  const permissionSet = new aws.ssoadmin.PermissionSet(
    "admin",
    {
      instanceArn,
      name: ADMIN_PERMISSION_SET,
      description: "Full admin, managed by iac-aws",
      sessionDuration: `PT${ic.sessionHours}H`,
    },
    { provider },
  );
  const policy = new aws.ssoadmin.ManagedPolicyAttachment(
    "admin-AdministratorAccess",
    { instanceArn, permissionSetArn: permissionSet.arn, managedPolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" },
    { provider },
  );

  for (const [key, accountId] of Object.entries(accountIds)) {
    new aws.ssoadmin.AccountAssignment(
      `admin-${key}`,
      {
        instanceArn,
        permissionSetArn: permissionSet.arn,
        principalId: group.groupId,
        principalType: "GROUP",
        targetId: accountId,
        targetType: "AWS_ACCOUNT",
      },
      // An assignment provisions the permission set into the account; attach the policy first
      // so the first provisioning already carries it.
      { provider, dependsOn: policy },
    );
  }

  return { accessPortalUrl: pulumi.interpolate`https://${identityStoreId}.awsapps.com/start` };
}
