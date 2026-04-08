import { S3FilesClient, GetFileSystemCommand, ListMountTargetsCommand, CreateMountTargetCommand } from '@aws-sdk/client-s3files';

const client = new S3FilesClient();

export const handler = async (event: any) => {
  console.log('isComplete event:', JSON.stringify(event));
  const fsId = event.PhysicalResourceId;

  if (event.RequestType === 'Delete') {
    try {
      const { status } = await client.send(new GetFileSystemCommand({ fileSystemId: fsId }));
      console.log('delete check status:', status);
      return { IsComplete: status === 'deleted' };
    } catch (e: any) {
      if (e.name === 'ResourceNotFoundException') return { IsComplete: true };
      throw e;
    }
  }

  if (event.RequestType === 'Update') return { IsComplete: true };

  // Create: wait for FS available, then create mount target
  const p = event.ResourceProperties;
  const fsResp = await client.send(new GetFileSystemCommand({ fileSystemId: fsId }));
  console.log('getFileSystem response:', JSON.stringify({ status: fsResp.status, fileSystemId: fsResp.fileSystemId, fileSystemArn: fsResp.fileSystemArn }));
  if (fsResp.status === 'error') throw new Error('File system entered error state: ' + (fsResp.statusMessage || ''));
  if (fsResp.status !== 'available') return { IsComplete: false };

  // FS available — ensure mount target exists
  const { mountTargets } = await client.send(new ListMountTargetsCommand({ fileSystemId: fsId }));
  console.log('mountTargets:', JSON.stringify(mountTargets));
  if (mountTargets && mountTargets.length > 0) {
    const mt = mountTargets[0];
    if (mt.lifeCycleState === 'available' || mt.status === 'available') {
      return {
        IsComplete: true,
        Data: { FileSystemId: fsId, FileSystemArn: fsResp.fileSystemArn, MountTargetId: mt.mountTargetId },
      };
    }
    return { IsComplete: false };
  }

  console.log('creating mount target...');
  await client.send(new CreateMountTargetCommand({
    fileSystemId: fsId, subnetId: p.SubnetId, securityGroups: [p.SecurityGroupId],
  }));
  return { IsComplete: false };
};
