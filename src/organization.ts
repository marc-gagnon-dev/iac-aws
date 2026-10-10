import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { expandOuPaths, parentOf, slug, Spec } from "./spec";

export interface OrganizationResult {
  organization: aws.organizations.Organization;
  rootId: pulumi.Output<string>;
  ouIds: Record<string, pulumi.Output<string>>;
}

/** The Organization itself and the OU tree, parents created before children. */
export function createOrganization(spec: Spec, provider: aws.Provider): OrganizationResult {
  const organization = new aws.organizations.Organization(
    "organization",
    {
      featureSet: "ALL",
      enabledPolicyTypes: ["SERVICE_CONTROL_POLICY"],
      awsServiceAccessPrincipals: [],
    },
    // Deleting the organization would orphan every account; never let a diff do that.
    { provider, protect: true },
  );
  const rootId = organization.roots.apply((roots) => roots[0].id);

  const ouIds: Record<string, pulumi.Output<string>> = {};
  for (const path of expandOuPaths(spec.ous)) {
    const parent = parentOf(path);
    const ou = new aws.organizations.OrganizationalUnit(
      `ou-${slug(path)}`,
      { name: path.split("/").pop()!, parentId: parent ? ouIds[parent] : rootId },
      { provider },
    );
    ouIds[path] = ou.id;
  }

  return { organization, rootId, ouIds };
}
