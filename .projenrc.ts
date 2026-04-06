import { awscdk, javascript } from "projen";
const project = new awscdk.AwsCdkConstructLibrary({
  author: "Neil Kuan",
  authorAddress: "guan840912@gmail.com",
  cdkVersion: "2.170.0",
  defaultReleaseBranch: "main",
  jsiiVersion: "~5.9.0",
  name: "cdk-agent-broker",
  packageManager: javascript.NodePackageManager.NPM,
  projenrcTs: true,
  repositoryUrl: "https://github.com/neilkuan/cdk-agent-broker.git",

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();