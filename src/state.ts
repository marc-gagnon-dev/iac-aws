/**
 * Pulumi state lives in the management account, in resources the bootstrap wizard
 * (scripts/bootstrap.sh) creates before the first `pulumi up`. The stack never manages
 * them itself: a stack that owns its own backend can delete its own state.
 *
 * Keep these names in sync with scripts/bootstrap.sh.
 */
export const STATE_KEY_ALIAS = "alias/iac-aws-state";

export function stateBucketName(managementAccountId: string): string {
  return `iac-aws-state-${managementAccountId}`;
}

/** What a PR preview needs from the backend: read state, take and release the stack lock, decrypt secrets. */
export function stateReadPolicy(managementAccountId: string): object[] {
  const bucket = `arn:aws:s3:::${stateBucketName(managementAccountId)}`;
  return [
    { Sid: "ListState", Effect: "Allow", Action: "s3:ListBucket", Resource: bucket },
    { Sid: "ReadState", Effect: "Allow", Action: "s3:GetObject", Resource: `${bucket}/*` },
    {
      Sid: "StackLocks",
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:DeleteObject"],
      Resource: `${bucket}/.pulumi/locks/*`,
    },
    {
      Sid: "DecryptSecrets",
      Effect: "Allow",
      Action: "kms:Decrypt",
      Resource: `arn:aws:kms:*:${managementAccountId}:key/*`,
      Condition: { "ForAnyValue:StringEquals": { "kms:ResourceAliases": STATE_KEY_ALIAS } },
    },
  ];
}
