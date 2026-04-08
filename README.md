# cdk-openab

AWS CDK constructs library for deploying [OpenAB aka Agent Broker](https://github.com/openabdev/openab) on AWS ECS Fargate.

##### Architecture

Two data persistence modes are supported:

**S3 Files mode** (`useS3Files: true`) — Recommended. Mounts the S3 bucket as an NFS file system via [S3 Files](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-mounting-ecs.html). No sidecar needed.

```
┌───────────────────────────────────────────────────────────────────┐
│  AWS Cloud                                                        │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  VPC (default: 10.168.0.0/16)                               │  │
│  │                                                             │  │
│  │  ┌───────────────────────────────────────────────────────┐  │  │
│  │  │  Public Subnet                                        │  │  │
│  │  │                                                       │  │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │  │  │
│  │  │  │  ECS Cluster                                    │  │  │  │
│  │  │  │                                                 │  │  │  │
│  │  │  │  ┌───────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │  Fargate Service (FARGATE_SPOT | FARGATE) │  │  │  │  │
│  │  │  │  │                                           │  │  │  │  │
│  │  │  │  │  ┌─────────────┐  ┌────────────────────┐  │  │  │  │  │
│  │  │  │  │  │ config-init │─▶│  app container     │  │  │  │  │  │
│  │  │  │  │  │ (S3 config) │  │  (S3 Files mount)  │  │  │  │  │  │
│  │  │  │  │  └─────────────┘  └────────────────────┘  │  │  │  │  │
│  │  │  │  └───────────────────────────────────────────┘  │  │  │  │
│  │  │  └─────────────────────────────────────────────────┘  │  │  │
│  │  └───────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────┐    ┌──────────────────┐                     │
│  │  S3 (config      │    │  S3 (data bucket) │                    │
│  │  asset)          │    │  + S3 File System  │                    │
│  │  config.toml     │    │  ⇄ /home/agent    │                    │
│  └──────────────────┘    └──────────────────┘                     │
└───────────────────────────────────────────────────────────────────┘
```

**Classic mode** (default) — Uses init/sidecar containers for S3 sync.

```
┌───────────────────────────────────────────────────────────────────┐
│  AWS Cloud                                                        │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  VPC (default: 10.168.0.0/16)                               │  │
│  │                                                             │  │
│  │  ┌───────────────────────────────────────────────────────┐  │  │
│  │  │  Public Subnet                                        │  │  │
│  │  │                                                       │  │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │  │  │
│  │  │  │  ECS Cluster                                    │  │  │  │
│  │  │  │                                                 │  │  │  │
│  │  │  │  ┌───────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │  Fargate Service (FARGATE_SPOT | FARGATE) │  │  │  │  │
│  │  │  │  │                                           │  │  │  │  │
│  │  │  │  │  ┌───────────┐  ┌──────────────────────┐  │  │  │  │  │
│  │  │  │  │  │ data-init │─▶│  app container       │  │  │  │  │  │
│  │  │  │  │  │ (S3 pull) │  │  (port 80)           │  │  │  │  │  │
│  │  │  │  │  └───────────┘  └──────────┬───────────┘  │  │  │  │  │
│  │  │  │  │                            │ stops        │  │  │  │  │
│  │  │  │  │                            ▼              │  │  │  │  │
│  │  │  │  │                 ┌───────────────────────┐ │  │  │  │  │
│  │  │  │  │                 │ data-backup (sidecar) │ │  │  │  │  │
│  │  │  │  │                 │ S3 sync on app stop   │ │  │  │  │  │
│  │  │  │  │                 └───────────────────────┘ │  │  │  │  │
│  │  │  │  └───────────────────────────────────────────┘  │  │  │  │
│  │  │  └─────────────────────────────────────────────────┘  │  │  │
│  │  └───────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────┐    ┌──────────────────┐                     │
│  │  S3 (config      │    │  S3 (data        │                     │
│  │  asset)          │    │  bucket)         │                     │
│  │  config.toml     │    │  /home/agent     │                     │
│  └──────────────────┘    └──────────────────┘                     │
└───────────────────────────────────────────────────────────────────┘
```

##### Install

```bash
# npm
npm install cdk-openab

# pip
pip install cdk-openab
```

##### Usage

```ts
import { OpenAB } from 'cdk-openab';

// S3 Files mode (recommended)
new OpenAB(this, 'Broker', {
  configPath: './config.toml',
  useS3Files: true,
});

// Classic mode
new OpenAB(this, 'Broker', {
  configPath: './config.toml',
});

// With custom settings
new OpenAB(this, 'Broker', {
  cpu: 2048,
  memoryLimitMiB: 4096,
  dataS3Prefix: 'my-agent-data',
  configPath: './config.toml',
  useS3Files: true,
});
```

##### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `vpc` | `ec2.IVpc` | New VPC (public subnet) | 自訂 VPC |
| `vpcCidr` | `string` | `10.168.0.0/16` | 新建 VPC 的 CIDR |
| `image` | `ecs.ContainerImage` | `ghcr.io/openabdev/openab:78f8d2c` | Container image |
| `memoryLimitMiB` | `number` | `4096` | Task memory (MiB) |
| `cpu` | `number` | `2048` | Task CPU units |
| `assignPublicIp` | `boolean` | `true` | 是否分配 public IP |
| `enableFargateSpot` | `boolean` | `true` | 啟用 FARGATE_SPOT |
| `dataBucket` | `s3.IBucket` | 自動建立 | 持久化資料用的 S3 bucket |
| `dataS3Prefix` | `string` | `agent-data` | S3 資料前綴（僅 classic mode） |
| `dataLocalPath` | `string` | `/home/agent` | 資料掛載路徑 |
| `configPath` | `string` | **必填** | 本地 config.toml 路徑，透過 S3 init container 掛載到 `/etc/openab/config.toml` |
| `useS3Files` | `boolean` | `false` | 使用 S3 Files 掛載 data bucket 為 NFS file system，免除 backup sidecar |

##### Exposed Resources

`OpenAB` construct 暴露以下屬性，方便後續串接：

- `broker.vpc` — VPC
- `broker.cluster` — ECS Cluster
- `broker.service` — Fargate Service
- `broker.dataBucket` — 持久化資料 S3 Bucket
- `broker.s3FileSystem` — S3 File System（僅 S3 Files mode）

##### Container Flow

**S3 Files mode** (`useS3Files: true`)

1. **`config-init`** (init container)：從 S3 asset 下載 `config.toml`，並 chown 資料目錄為 `1000:1000`
2. **`app`**：主應用容器，S3 Files volume 直接掛載 `/home/agent`（read-write），資料自動雙向同步到 S3 bucket

**Classic mode** (default)

1. **`data-init`** (init container)：從 S3 data bucket 還原 `/home/agent` 資料，並從 S3 asset 下載 `config.toml`
2. **`app`**：主應用容器，等待 init 完成後啟動，掛載資料目錄（read-write）和 config（read-only）
3. **`data-backup`** (sidecar)：每 10 分鐘定期將 `/home/agent` sync 到 S3 data bucket，並在收到 SIGTERM（app 停止）時執行最後一次備份
