import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { S3FileSystem } from './s3-file-system';

export interface OpenABProps {
  readonly vpc?: ec2.IVpc;
  readonly vpcCidr?: string;
  readonly image?: ecs.ContainerImage;
  readonly memoryLimitMiB?: number;
  readonly cpu?: number;
  readonly assignPublicIp?: boolean;
  readonly enableFargateSpot?: boolean;
  readonly dataBucket?: s3.IBucket;
  readonly dataS3Prefix?: string;
  readonly dataLocalPath?: string;
  readonly configPath: string;
  readonly logGroup?: logs.ILogGroup;

  /**
   * Use S3 Files to mount the data bucket as an NFS file system.
   * Eliminates the data-init sync and data-backup sidecar containers.
   *
   * @default false
   */
  readonly useS3Files?: boolean;

  /**
   * The log level for Rust components.
   * @default 'info'
   */
  readonly rustLogLevel?: string;

}

export class OpenAB extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly logGroup: logs.ILogGroup;
  public readonly dataBucket: s3.IBucket;
  public readonly s3FileSystem?: S3FileSystem;
  public rustLogLevel?: string;

  constructor(scope: Construct, id: string, props: OpenABProps) {
    super(scope, id);

    const useSpot = props.enableFargateSpot ?? true;
    const assignPublicIp = props.assignPublicIp ?? true;
    const useS3Files = props.useS3Files ?? false;
    this.rustLogLevel = props.rustLogLevel ?? 'info';

    this.vpc = props.vpc ?? new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr ?? '10.168.0.0/16'),
      maxAzs: 1,
      subnetConfiguration: assignPublicIp
        ? [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }]
        : undefined,
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      enableFargateCapacityProviders: useSpot,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: props.memoryLimitMiB ?? 4096,
      cpu: props.cpu ?? 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.logGroup = props.logGroup ?? new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
    });
    const logGroup = this.logGroup;

    const dataLocalPath = props.dataLocalPath ?? '/home/agent';
    const dataS3Prefix = props.dataS3Prefix ?? 'agent-data';

    // S3 bucket for persistent data
    this.dataBucket = props.dataBucket ?? new s3.Bucket(this, 'DataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: useS3Files, // S3 Files requires bucket versioning
    });

    // Config asset
    const configAsset = new s3assets.Asset(this, 'ConfigAsset', {
      path: props.configPath,
    });

    const vpcSubnets = assignPublicIp
      ? { subnetType: ec2.SubnetType.PUBLIC }
      : undefined;

    if (useS3Files) {
      this.s3FileSystem = this._buildS3FilesMode(taskDefinition, logGroup, dataLocalPath, configAsset, vpcSubnets);
    } else {
      this._buildClassicMode(taskDefinition, logGroup, dataLocalPath, dataS3Prefix, configAsset);
    }

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp,
      enableExecuteCommand: true,
      vpcSubnets,
      capacityProviderStrategies: useSpot
        ? [
          { capacityProvider: 'FARGATE_SPOT', weight: 2, base: 0 },
          { capacityProvider: 'FARGATE', weight: 1, base: 1 },
        ]
        : undefined,
    });

    // Allow Fargate → S3 Files mount target on NFS port
    if (useS3Files && this.s3FileSystem) {
      this.service.connections.allowTo(this.s3FileSystem, ec2.Port.tcp(2049), 'NFS to S3 Files');
    }
  }

  /**
   * S3 Files mode: mount bucket via S3FilesVolumeConfiguration, only config-init + app containers.
   */
  private _buildS3FilesMode(
    taskDefinition: ecs.FargateTaskDefinition,
    logGroup: logs.ILogGroup,
    dataLocalPath: string,
    configAsset: s3assets.Asset,
    vpcSubnets?: ec2.SubnetSelection,
  ): S3FileSystem {
    // Create S3 File System
    const s3Fs = new S3FileSystem(this, 'S3FileSystem', {
      bucket: this.dataBucket,
      vpc: this.vpc,
      vpcSubnets,
    });

    // S3 Files volume — CDK L2 doesn't support S3FilesVolumeConfiguration yet,
    // so add a placeholder volume then override via CFN escape hatch.
    // When CDK adds L2 support, replace with native addVolume() call.
    taskDefinition.addVolume({ name: 'agent-data' });
    const cfnTaskDef = taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride('Volumes.0.S3FilesVolumeConfiguration', {
      FileSystemArn: s3Fs.fileSystemArn,
    });

    // Docker volume for config (shared between init and app)
    taskDefinition.addVolume({ name: 'agent-config' });

    // S3 Files client permissions for Fargate task to mount the file system
    taskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FilesClientFullAccess'),
    );

    // S3 direct read permissions for optimized read performance
    this.dataBucket.grantRead(taskDefinition.taskRole);

    // Config-only init container (no data sync needed)
    const initContainer = taskDefinition.addContainer('config-init', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-cli:latest'),
      essential: false,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'config-init' }),
      environment: {
        CONFIG_S3_BUCKET: configAsset.s3BucketName,
        CONFIG_S3_KEY: configAsset.s3ObjectKey,
      },
      entryPoint: ['bash', '-c'],
      command: [
        `aws s3 cp s3://$CONFIG_S3_BUCKET/$CONFIG_S3_KEY /etc/openab/config.toml && chown -R 1000:1000 /etc/openab && (chown -R 1000:1000 ${dataLocalPath} 2>/dev/null; exit 0)`,
      ],
    });

    initContainer.addMountPoints(
      { sourceVolume: 'agent-data', containerPath: dataLocalPath, readOnly: false },
      { sourceVolume: 'agent-config', containerPath: '/etc/openab', readOnly: false },
    );

    // App container
    const container = taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/openabdev/openab:78f8d2c'),
      essential: true,
      user: '1000:1000',
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      environment: {
        RUST_LOG: this.rustLogLevel ?? 'info',
      },
    });

    container.addContainerDependencies({
      container: initContainer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    container.addMountPoints(
      { sourceVolume: 'agent-data', containerPath: dataLocalPath, readOnly: false },
      { sourceVolume: 'agent-config', containerPath: '/etc/openab', readOnly: true },
    );

    // Config asset read permission
    configAsset.grantRead(taskDefinition.taskRole);

    return s3Fs;
  }

  /**
   * Classic mode: init container syncs data from S3, backup sidecar syncs back.
   */
  private _buildClassicMode(
    taskDefinition: ecs.FargateTaskDefinition,
    logGroup: logs.ILogGroup,
    dataLocalPath: string,
    dataS3Prefix: string,
    configAsset: s3assets.Asset,
  ): void {
    // Shared Docker volumes
    taskDefinition.addVolume({ name: 'agent-data' });
    taskDefinition.addVolume({ name: 'agent-config' });

    // Init container: restore data from S3 + download config
    const initContainer = taskDefinition.addContainer('data-init', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-cli:latest'),
      essential: false,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'data-init' }),
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        DATA_S3_PREFIX: dataS3Prefix,
        DATA_LOCAL_PATH: dataLocalPath,
        CONFIG_S3_BUCKET: configAsset.s3BucketName,
        CONFIG_S3_KEY: configAsset.s3ObjectKey,
      },
      entryPoint: ['bash', '-c'],
      command: [
        [
          'mkdir -p $DATA_LOCAL_PATH',
          'aws s3 sync s3://$DATA_BUCKET/$DATA_S3_PREFIX $DATA_LOCAL_PATH || true',
          'aws s3 cp s3://$CONFIG_S3_BUCKET/$CONFIG_S3_KEY /etc/openab/config.toml',
          'chown -R 1000:1000 $DATA_LOCAL_PATH /etc/openab',
        ].join(' && '),
      ],
    });

    initContainer.addMountPoints(
      { sourceVolume: 'agent-data', containerPath: dataLocalPath, readOnly: false },
      { sourceVolume: 'agent-config', containerPath: '/etc/openab', readOnly: false },
    );

    // App container
    const container = taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/openabdev/openab:78f8d2c'),
      essential: true,
      user: '1000:1000',
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      environment: {
        RUST_LOG: this.rustLogLevel ?? 'info',
      },
    });

    container.addContainerDependencies({
      container: initContainer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    container.addMountPoints(
      { sourceVolume: 'agent-data', containerPath: dataLocalPath, readOnly: false },
      { sourceVolume: 'agent-config', containerPath: '/etc/openab', readOnly: true },
    );

    // Sidecar: periodic backup + final backup on SIGTERM
    const backupSidecar = taskDefinition.addContainer('data-backup', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-cli:latest'),
      essential: false,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'data-backup' }),
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        DATA_S3_PREFIX: dataS3Prefix,
        DATA_LOCAL_PATH: dataLocalPath,
      },
      entryPoint: ['bash', '-c'],
      command: [
        [
          'do_backup() { echo "[$(date)] Syncing $DATA_LOCAL_PATH to s3://$DATA_BUCKET/$DATA_S3_PREFIX ..."; aws s3 sync $DATA_LOCAL_PATH s3://$DATA_BUCKET/$DATA_S3_PREFIX --delete; echo "[$(date)] Backup done"; }',
          'trap \'do_backup; exit 0\' SIGTERM',
          'while true; do do_backup; sleep 600 & wait $!; done',
        ].join('; '),
      ],
    });

    backupSidecar.addContainerDependencies({
      container: initContainer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    backupSidecar.addMountPoints(
      { sourceVolume: 'agent-data', containerPath: dataLocalPath, readOnly: true },
    );

    // Grant S3 permissions
    this.dataBucket.grantReadWrite(taskDefinition.taskRole);
    configAsset.grantRead(taskDefinition.taskRole);
  }
}
