import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { PULUMI_STATE_KEY_ALIAS, pulumiStateBucketName } from "./state";

/** Days an overwritten or deleted state file is kept before S3 expires it. */
export const NONCURRENT_STATE_DAYS = 90;

export interface PulumiStateBackendArgs {
  /** Provider for the account the backend lives in. */
  provider: aws.Provider;
  accountId: pulumi.Input<string>;
  region: string;
}

/**
 * A Pulumi backend for workload stacks in one account: a private, versioned bucket encrypted with a
 * KMS key that the stacks also use as their secrets provider. Workload stacks must not own their own
 * backend (they could delete their own state), so this stack provides it.
 *
 * Every resource is retained on delete: turning `pulumiState` off or destroying this stack leaves the
 * backend in place. The key and bucket are also protected, so nothing can replace them by accident.
 */
export class PulumiStateBackend extends pulumi.ComponentResource {
  readonly bucket: pulumi.Output<string>;
  readonly keyArn: pulumi.Output<string>;
  /** For `pulumi login`. */
  readonly backendUrl: pulumi.Output<string>;
  /** For `pulumi stack init --secrets-provider`. */
  readonly secretsProvider: string;

  constructor(name: string, args: PulumiStateBackendArgs, opts?: pulumi.ComponentResourceOptions) {
    super("iac-aws:index:PulumiStateBackend", name, {}, opts);
    const child = { parent: this, provider: args.provider, retainOnDelete: true };

    const key = new aws.kms.Key(
      `${name}-pulumi-state`,
      {
        description: "Pulumi state and secrets for workload stacks, managed by iac-aws",
        enableKeyRotation: true,
        // IAM policies in this account decide who may use the key, as for any other resource.
        policy: pulumi.output(args.accountId).apply((accountId) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DelegateToIam",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                Action: "kms:*",
                Resource: "*",
              },
            ],
          }),
        ),
      },
      { ...child, protect: true },
    );
    new aws.kms.Alias(`${name}-pulumi-state`, { name: PULUMI_STATE_KEY_ALIAS, targetKeyId: key.keyId }, child);

    const bucket = new aws.s3.Bucket(
      `${name}-pulumi-state`,
      { bucket: pulumi.output(args.accountId).apply(pulumiStateBucketName) },
      { ...child, protect: true },
    );
    new aws.s3.BucketPublicAccessBlock(
      `${name}-pulumi-state`,
      {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      child,
    );
    new aws.s3.BucketOwnershipControls(
      `${name}-pulumi-state`,
      { bucket: bucket.id, rule: { objectOwnership: "BucketOwnerEnforced" } },
      child,
    );
    new aws.s3.BucketServerSideEncryptionConfiguration(
      `${name}-pulumi-state`,
      {
        bucket: bucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: { sseAlgorithm: "aws:kms", kmsMasterKeyId: key.arn },
            bucketKeyEnabled: true,
          },
        ],
      },
      child,
    );
    const versioning = new aws.s3.BucketVersioning(
      `${name}-pulumi-state`,
      { bucket: bucket.id, versioningConfiguration: { status: "Enabled" } },
      child,
    );
    // Every update rewrites the checkpoint, so old versions pile up; keep enough to roll back.
    new aws.s3.BucketLifecycleConfiguration(
      `${name}-pulumi-state`,
      {
        bucket: bucket.id,
        rules: [
          {
            id: "expire-noncurrent-state",
            status: "Enabled",
            filter: {},
            noncurrentVersionExpiration: { noncurrentDays: NONCURRENT_STATE_DAYS },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
          },
        ],
      },
      { ...child, dependsOn: versioning },
    );
    new aws.s3.BucketPolicy(
      `${name}-pulumi-state`,
      {
        bucket: bucket.id,
        policy: bucket.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "TlsOnly",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [arn, `${arn}/*`],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          }),
        ),
      },
      child,
    );

    this.bucket = bucket.bucket;
    this.keyArn = key.arn;
    this.backendUrl = pulumi.interpolate`s3://${bucket.bucket}?region=${args.region}&awssdk=v2`;
    this.secretsProvider = `awskms://${PULUMI_STATE_KEY_ALIAS}?region=${args.region}`;
    this.registerOutputs({ bucket: this.bucket, keyArn: this.keyArn, backendUrl: this.backendUrl });
  }
}
