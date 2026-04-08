const { S3FilesClient, CreateFileSystemCommand, DeleteFileSystemCommand, ListMountTargetsCommand, DeleteMountTargetCommand, GetFileSystemCommand } = require('@aws-sdk/client-s3files');
const client = new S3FilesClient();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  console.log('onEvent:', JSON.stringify(event));
  const p = event.ResourceProperties;
  if (event.RequestType === 'Create') {
    const fs = await client.send(new CreateFileSystemCommand({ bucket: p.BucketArn, roleArn: p.RoleArn }));
    console.log('createFileSystem response:', JSON.stringify(fs));
    return {
      PhysicalResourceId: fs.fileSystemId,
      Data: { FileSystemId: fs.fileSystemId, FileSystemArn: fs.fileSystemArn },
    };
  }
  if (event.RequestType === 'Delete') {
    const fsId = event.PhysicalResourceId;
    // Delete mount targets first and wait for them to be gone
    try {
      const { mountTargets } = await client.send(new ListMountTargetsCommand({ fileSystemId: fsId }));
      for (const mt of (mountTargets || [])) {
        await client.send(new DeleteMountTargetCommand({ mountTargetId: mt.mountTargetId })).catch(() => {});
      }
      // Wait for mount targets to be deleted
      for (let i = 0; i < 30; i++) {
        const res = await client.send(new ListMountTargetsCommand({ fileSystemId: fsId }));
        if (!res.mountTargets || res.mountTargets.length === 0) break;
        await sleep(10000);
      }
    } catch (e) { /* ignore */ }
    // Now delete file system
    try {
      await client.send(new DeleteFileSystemCommand({ fileSystemId: fsId, forceDelete: true }));
    } catch (e) {
      if (!e.name?.match(/ValidationException|ResourceNotFoundException/)) throw e;
    }
    return { PhysicalResourceId: fsId };
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
};
