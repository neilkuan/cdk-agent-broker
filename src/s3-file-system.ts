import { CfnResource, Duration, Fn, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props for S3FileSystem.
 */
export interface S3FileSystemProps {
  /**
   * The S3 bucket to expose as a file system.
   */
  readonly bucket: s3.IBucket;

  /**
   * The VPC where the mount target will be created.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Subnet selection for the mount target.
   * Should match the subnets used by your compute resources
   * to avoid cross-AZ data transfer costs.
   *
   * @default - default VPC subnets
   */
  readonly vpcSubnets?: ec2.SubnetSelection;
}

/**
 * Creates an S3 File System (S3 Files) from an S3 bucket,
 * making the bucket accessible as an NFS file system.
 *
 * Uses cr.Provider with isCompleteHandler for async resource creation.
 * When AWS publishes L1 CloudFormation resources, swap the internals
 * without changing the public interface.
 */
export class S3FileSystem extends Construct implements ec2.IConnectable {
  public readonly fileSystemId: string;
  public readonly fileSystemArn: string;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly connections: ec2.Connections;
  public readonly serviceRole: iam.Role;

  constructor(scope: Construct, id: string, props: S3FileSystemProps) {
    super(scope, id);

    const subnets = props.vpc.selectSubnets(props.vpcSubnets);
    const subnet = subnets.subnets[0];
    const stack = Stack.of(this);

    // IAM role for S3 Files service to access the bucket.
    this.serviceRole = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:s3files:${stack.region}:${stack.account}:file-system/*` },
        },
      }),
      description: 'Allows S3 Files service to access the S3 bucket',
    });
    props.bucket.grantReadWrite(this.serviceRole);

    // S3 Files needs bucket notification permissions for EventBridge sync setup
    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3BucketNotification',
      actions: ['s3:GetBucketNotification', 's3:PutBucketNotification'],
      resources: [props.bucket.bucketArn],
    }));

    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EventBridgeManage',
      actions: [
        'events:DeleteRule', 'events:DisableRule', 'events:EnableRule',
        'events:PutRule', 'events:PutTargets', 'events:RemoveTargets',
      ],
      resources: ['arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*'],
      conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
    }));
    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EventBridgeRead',
      actions: ['events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule'],
      resources: ['arn:aws:events:*:*:rule/*'],
    }));

    // Security group for the mount target
    this.securityGroup = new ec2.SecurityGroup(this, 'MountTargetSG', {
      vpc: props.vpc,
      description: 'S3 Files mount target',
      allowAllOutbound: false,
    });
    this.connections = new ec2.Connections({
      securityGroups: [this.securityGroup],
      defaultPort: ec2.Port.tcp(2049),
    });

    // --- cr.Provider: onEvent creates/deletes, isComplete polls until ready ---
    const lambdaPolicy = [
      new iam.PolicyStatement({ actions: ['s3files:*'], resources: ['*'] }),
      new iam.PolicyStatement({
        actions: [
          'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface',
          'ec2:DescribeNetworkInterfaces', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [this.serviceRole.roleArn] }),
      new iam.PolicyStatement({
        actions: ['s3:GetBucketNotification', 's3:PutBucketNotification'],
        resources: [props.bucket.bucketArn],
      }),
      new iam.PolicyStatement({
        actions: [
          'events:DeleteRule', 'events:DisableRule', 'events:EnableRule',
          'events:PutRule', 'events:PutTargets', 'events:RemoveTargets',
          'events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule',
        ],
        resources: ['*'],
      }),
    ];

    const lambdaCode = lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
      bundling: {
        image: lambda.Runtime.NODEJS_22_X.bundlingImage,
        command: ['bash', '-c', 'cp -r /asset-input/* /asset-output/ && cd /asset-output && npm install --omit=dev'],
      },
    });

    const onEventFn = new lambda.Function(this, 'OnEventFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'on-event.handler',
      timeout: Duration.minutes(5),
      code: lambdaCode,
    });
    lambdaPolicy.forEach(p => onEventFn.addToRolePolicy(p));

    const isCompleteFn = new lambda.Function(this, 'IsCompleteFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'is-complete.handler',
      timeout: Duration.minutes(1),
      code: lambdaCode,
    });
    lambdaPolicy.forEach(p => isCompleteFn.addToRolePolicy(p));

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEventFn,
      isCompleteHandler: isCompleteFn,
      queryInterval: Duration.seconds(10),
      totalTimeout: Duration.minutes(30),
    });

    const resource = new CfnResource(this, 'Resource', {
      type: 'AWS::CloudFormation::CustomResource',
      properties: {
        ServiceToken: provider.serviceToken,
        BucketArn: props.bucket.bucketArn,
        RoleArn: this.serviceRole.roleArn,
        SubnetId: subnet.subnetId,
        SecurityGroupId: this.securityGroup.securityGroupId,
      },
    });

    this.fileSystemId = Fn.getAtt(resource.logicalId, 'FileSystemId').toString();
    this.fileSystemArn = Fn.getAtt(resource.logicalId, 'FileSystemArn').toString();
  }
}
