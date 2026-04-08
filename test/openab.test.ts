import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OpenAB } from '../src';

const configPath = path.join(__dirname, 'fixtures', 'config.toml');

test('creates Fargate service with default VPC and public subnet', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.resourceCountIs('AWS::EC2::Subnet', 1);
  template.resourcePropertiesCountIs('AWS::EC2::Subnet', {
    MapPublicIpOnLaunch: true,
  }, 1);
  template.resourceCountIs('AWS::ECS::Cluster', 1);
  template.resourceCountIs('AWS::ECS::Service', 1);
  template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
});

test('creates Fargate service with provided VPC', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const vpc = new ec2.Vpc(stack, 'Vpc');

  new OpenAB(stack, 'OpenAB', { configPath, vpc });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::ECS::Cluster', 1);
  template.resourceCountIs('AWS::ECS::Service', 1);
});

test('assignPublicIp creates only public subnets', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath, assignPublicIp: true });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::Subnet', 1);
  template.resourcePropertiesCountIs('AWS::EC2::Subnet', {
    MapPublicIpOnLaunch: true,
  }, 1);
});

test('classic mode: init container, backup sidecar, and S3 bucket', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath });

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Name: 'data-init', Essential: false }),
    ]),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Name: 'data-backup', Essential: false }),
    ]),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Essential: true,
        MountPoints: Match.arrayWith([
          Match.objectLike({ ContainerPath: '/home/agent' }),
          Match.objectLike({ ContainerPath: '/etc/openab' }),
        ]),
      }),
    ]),
  });
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('s3 files mode: no data-init or data-backup, has config-init and S3 Files volume', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath, useS3Files: true });

  const template = Template.fromStack(stack);

  // Should have config-init, NOT data-init or data-backup
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Name: 'config-init', Essential: false }),
    ]),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.not(
      Match.arrayWith([
        Match.objectLike({ Name: 'data-init' }),
      ]),
    ),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.not(
      Match.arrayWith([
        Match.objectLike({ Name: 'data-backup' }),
      ]),
    ),
  });

  // App container still mounts at /home/agent and /etc/openab
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Essential: true,
        MountPoints: Match.arrayWith([
          Match.objectLike({ ContainerPath: '/home/agent' }),
          Match.objectLike({ ContainerPath: '/etc/openab' }),
        ]),
      }),
    ]),
  });

  // Task definition has S3Files volume configuration (via CFN escape hatch)
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: Match.arrayWith([
      Match.objectLike({
        Name: 'agent-data',
        S3FilesVolumeConfiguration: Match.objectLike({
          FileSystemArn: Match.anyValue(),
        }),
      }),
    ]),
  });

  // Should have Custom::S3FileSystem resource
  template.resourceCountIs('Custom::S3FileSystem', 1);
  template.resourceCountIs('Custom::S3FilesMountTarget', 1);

  // Security group for mount target
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'S3 Files mount target',
  });

  // S3 bucket still created
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('s3 files mode: creates mount target security group and Fargate service SG', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath, useS3Files: true });

  const template = Template.fromStack(stack);

  // Mount target SG exists
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'S3 Files mount target',
  });

  // Two SGs total: Fargate service + mount target
  template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
});

test('s3 files mode: creates S3 Files service role with bucket access', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new OpenAB(stack, 'OpenAB', { configPath, useS3Files: true });

  const template = Template.fromStack(stack);

  // Service role for S3 Files with trust policy
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: Match.objectLike({
            Service: 'elasticfilesystem.amazonaws.com',
          }),
        }),
      ]),
    }),
  });
});

test('s3 files mode: exposes s3FileSystem property', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const openab = new OpenAB(stack, 'OpenAB', { configPath, useS3Files: true });

  expect(openab.s3FileSystem).toBeDefined();
});

test('classic mode: s3FileSystem property is undefined', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const openab = new OpenAB(stack, 'OpenAB', { configPath });

  expect(openab.s3FileSystem).toBeUndefined();
});
