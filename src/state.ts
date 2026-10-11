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

/**
 * Workload repos keep their stacks' state in their own account, in a backend this stack creates
 * for accounts with `pulumiState: true` (src/pulumi-state.ts). Workload repos log in by these
 * names, so they are a convention to keep, not an implementation detail.
 */
export const PULUMI_STATE_KEY_ALIAS = "alias/pulumi-state";

export function pulumiStateBucketName(accountId: string): string {
  return `pulumi-state-${accountId}`;
}

/** A Pulumi S3 backend: the state bucket, and the KMS key (found by alias) that encrypts its secrets. */
export interface StateBackend {
  accountId: string;
  bucket: string;
  keyAlias: string;
  /** The bucket encrypts objects with the same key (SSE-KMS), so even writing a lock file needs a data key. */
  sseKms: boolean;
}

export function orgStateBackend(managementAccountId: string): StateBackend {
  return { accountId: managementAccountId, bucket: stateBucketName(managementAccountId), keyAlias: STATE_KEY_ALIAS, sseKms: false };
}

export function pulumiStateBackend(accountId: string): StateBackend {
  return { accountId, bucket: pulumiStateBucketName(accountId), keyAlias: PULUMI_STATE_KEY_ALIAS, sseKms: true };
}

/** "read" for previews, "write" for deploys. */
export type StateAccess = "read" | "write";

/**
 * What a role needs from a backend. A preview reads state, takes and releases the stack lock, and
 * decrypts secrets. A deploy also writes state and encrypts secrets.
 */
export function stateAccessPolicy(backend: StateBackend, access: StateAccess): object[] {
  const bucket = `arn:aws:s3:::${backend.bucket}`;
  const key = `arn:aws:kms:*:${backend.accountId}:key/*`;
  const byAlias = { "ForAnyValue:StringEquals": { "kms:ResourceAliases": backend.keyAlias } };
  const list = { Sid: "ListState", Effect: "Allow", Action: "s3:ListBucket", Resource: bucket };

  if (access === "write") {
    return [
      list,
      { Sid: "WriteState", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: `${bucket}/*` },
      {
        Sid: "UseStateKey",
        Effect: "Allow",
        Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*"],
        Resource: key,
        Condition: byAlias,
      },
    ];
  }

  const statements: object[] = [
    list,
    { Sid: "ReadState", Effect: "Allow", Action: "s3:GetObject", Resource: `${bucket}/*` },
    {
      Sid: "StackLocks",
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:DeleteObject"],
      Resource: `${bucket}/.pulumi/locks/*`,
    },
    { Sid: "DecryptSecrets", Effect: "Allow", Action: "kms:Decrypt", Resource: key, Condition: byAlias },
  ];
  if (backend.sseKms) {
    // S3 asks KMS for a data key to encrypt each lock file. Only S3 can use this grant.
    statements.push({
      Sid: "EncryptLocks",
      Effect: "Allow",
      Action: "kms:GenerateDataKey",
      Resource: key,
      Condition: { ...byAlias, StringLike: { "kms:ViaService": "s3.*.amazonaws.com" } },
    });
  }
  return statements;
}
