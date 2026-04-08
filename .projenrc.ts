import { awscdk, javascript } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'Neil Kuan',
  authorAddress: 'guan840912@gmail.com',
  cdkVersion: '2.248.0',
  name: 'cdk-openab',
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcTs: true,
  repositoryUrl: 'https://github.com/neilkuan/cdk-openab.git',
  description: 'AWS CDK constructs library for OpenAB',
  stability: 'experimental',
  defaultReleaseBranch: 'main',
  autoDetectBin: false,
  depsUpgradeOptions: {
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
    },
  },
  autoApproveOptions: {
    secret: 'GITHUB_TOKEN',
    allowedUsernames: ['neilkuan'],
  },

  npmProvenance: true,
  npmTokenSecret: '',
  npmTrustedPublishing: true,
  devDeps: [
    // 'ts-jest@29.1.2',
    'jsii-rosetta@5.0.x',
  ],
  minNodeVersion: '24.0.0',
  workflowNodeVersion: '24',
  typescriptVersion: '^5.5',
  jsiiVersion: '5.9.x',
  gitignore: [
    'config.toml',
    'cdk.out',
    'cdk.context.json',
    'cdk.json',
    '.DS_Store',
    'src/lambda/.npm',
    'kiro',
    '.kiro',
  ],
  npmignore: [
    'config.toml',
    'cdk.out',
    'cdk.context.json',
    'cdk.json',
    'integ-index.ts',
    '.DS_Store',
    'src/lambda/.npm',
    'kiro',
    '.kiro',
  ],
  bundledDeps: ['@aws-sdk/client-s3files'],
  excludeTypescript: ['integ-index.ts', 'src/lambda/*.ts'],
  publishToPypi: {
    distName: 'cdk-openab',
    module: 'cdk_openab',
  },
});

// Copy lambda .ts source files to lib/ for NodejsFunction entry resolution
project.postCompileTask.exec('cp -r src/lambda lib/');

// Fix Mergify deprecated `delete_head_branch` in pull_request_rules actions
// Move it to queue_rules instead
const mergifyFile = project.tryFindObjectFile('.mergify.yml');
if (mergifyFile) {
  // Remove deprecated delete_head_branch from pull_request_rules actions
  // Use GitHub's "Automatically delete head branches" setting instead
  mergifyFile.addDeletionOverride('pull_request_rules.0.actions.delete_head_branch');
}

project.synth();
