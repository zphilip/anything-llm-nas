const MOUNT_LIST = "mountpoints.csv";
const MOUNT_DIRECTORY = require("path").resolve(__dirname, "../../../mountpoint");
const path = require('path');
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');
const { createObjectCsvWriter } = require('csv-writer');
const execPromise = util.promisify(exec);

/**
 * Save mount point data to CSV file
 * Maintains a list of all mount points with their status
 */
async function saveMountPointsToCSV(mountData, csvPath = MOUNT_LIST) {
  try {
    let existingRecords = [];
    
    // Read existing records if file exists
    if (fs.existsSync(csvPath)) {
      const csvContent = await fs.promises.readFile(csvPath, 'utf8');
      existingRecords = csvContent.split('\n')
        .slice(1) // Skip header
        .filter(line => line.trim()) // Remove empty lines
        .map(line => {
          const [mountId, mountPoint, targetPath, listName, mountTime, status] = line.split(',');
          return { 
            mountId: mountId.trim(),
            mountPoint: mountPoint.trim(),
            targetPath: targetPath.trim(),
            listName: listName.trim(),
            mountTime: mountTime.trim(),
            status: status.trim()
          };
        });
      
      // Remove any existing record with the same mount point
      existingRecords = existingRecords.filter(record => 
        record.mountPoint !== mountData.mountPoint
      );
    }

    // Add new record
    existingRecords.push(mountData);

    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'mountId', title: 'mount_id' },
        { id: 'mountPoint', title: 'mount_point' },
        { id: 'targetPath', title: 'target_path' },
        { id: 'listName', title: 'list_name' },
        { id: 'mountTime', title: 'mount_time' },
        { id: 'status', title: 'status' }
      ],
      append: false // Rewrite file with all records
    });

    await csvWriter.writeRecords(existingRecords);
    console.log(`Mount point updated in ${csvPath} (${existingRecords.length} total records)`);

  } catch (error) {
    console.error('Error saving mount points:', error);
    throw error;
  }
}

/**
 * Mount an SMB/CIFS share to a local mount point
 * @param {string} nasshare - The network share path (e.g., //server/share)
 * @param {string} username - SMB username
 * @param {string} password - SMB password
 * @param {string} mountpoint - Local mount point directory
 * @param {string} mountId - Unique mount ID
 * @param {string} csvFilePath - Path to the file list CSV
 */
async function mountToSmbShare(nasshare, username, password, mountpoint, mountId, csvFilePath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Remove leading slashes and replace backslashes
      const cleanNasShare = nasshare.replace(/^[\/\\]+/, '//').replace(/\\/g, '/');
      const cleanMountPoint = String(mountpoint).replace(/^[\/\\]+/, '/');
  
      // Construct mount command with proper escaping and UTF-8 support
      const command = `sudo mount -t cifs "${cleanNasShare}" "${cleanMountPoint}" -o username="${username}",password="${password}",iocharset=utf8`;
  
      console.log(`Mounting: ${cleanNasShare} -> ${cleanMountPoint}`);
      
      exec(command, async (error, stdout, stderr) => {
        if (error) {
          console.error('Mount error:', error);
          
          // Save failed mount attempt
          const mountData = {
            mountId: mountId,
            mountPoint: cleanMountPoint,
            targetPath: cleanNasShare,
            listName: csvFilePath,
            mountTime: new Date().toISOString(),
            status: 'failed'
          };
          
          try {
            await saveMountPointsToCSV(mountData, path.join(MOUNT_DIRECTORY, MOUNT_LIST));
          } catch (csvError) {
            console.error('Failed to save mount point data:', csvError);
          }
          
          reject(new Error(`Failed to mount: ${stderr || error.message}`));
          return;
        }

        // Save successful mount
        const mountData = {
          mountId: mountId,
          mountPoint: cleanMountPoint,
          targetPath: cleanNasShare,
          listName: csvFilePath,
          mountTime: new Date().toISOString(),
          status: 'mounted'
        };

        try {
          await saveMountPointsToCSV(mountData, path.join(MOUNT_DIRECTORY, MOUNT_LIST));
          console.log('Mount point saved to CSV');
          resolve(stdout);
        } catch (csvError) {
          console.error('Failed to save mount point data:', csvError);
          // Still resolve since mount was successful
          resolve(stdout);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Unmount an SMB share
 * @param {string} mountpoint - The mount point to unmount
 */
async function unmountSmbShare(mountpoint) {
  try {
    const cleanMountPoint = String(mountpoint).replace(/^[\/\\]+/, '/');
    const command = `sudo umount -f "${cleanMountPoint}"`;
    
    console.log(`Unmounting: ${cleanMountPoint}`);
    await execPromise(command);
    console.log('Successfully unmounted');
    
    // Update CSV status
    const csvPath = path.join(MOUNT_DIRECTORY, MOUNT_LIST);
    if (fs.existsSync(csvPath)) {
      const csvContent = await fs.promises.readFile(csvPath, 'utf8');
      let records = csvContent.split('\n')
        .slice(1)
        .filter(line => line.trim())
        .map(line => {
          const [mountId, mountPoint, targetPath, listName, mountTime, status] = line.split(',');
          return {
            mountId: mountId.trim(),
            mountPoint: mountPoint.trim(),
            targetPath: targetPath.trim(),
            listName: listName.trim(),
            mountTime: mountTime.trim(),
            status: mountPoint.trim() === cleanMountPoint ? 'unmounted' : status.trim()
          };
        });
      
      const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: [
          { id: 'mountId', title: 'mount_id' },
          { id: 'mountPoint', title: 'mount_point' },
          { id: 'targetPath', title: 'target_path' },
          { id: 'listName', title: 'list_name' },
          { id: 'mountTime', title: 'mount_time' },
          { id: 'status', title: 'status' }
        ],
        append: false
      });
      
      await csvWriter.writeRecords(records);
    }
    
    return true;
  } catch (error) {
    console.error('Error unmounting:', error);
    throw error;
  }
}

/**
 * Check if a path is a mount point
 * @param {string} mountPath - Path to check
 */
async function isMountPoint(mountPath) {
  try {
    const { stdout } = await execPromise('mount');
    return stdout.includes(mountPath);
  } catch (error) {
    console.error('Error checking mount point:', error);
    return false;
  }
}

/**
 * Create a new mount point directory
 * @param {string} mountpoint - Base mount point directory
 * @param {string} mountId - Unique mount ID
 * @param {string} formattedSharePath - Formatted share path
 */
async function createNewMountPoint(mountpoint, mountId, formattedSharePath) {
  const localMountPoint = path.join(
    mountpoint,
    mountId,
    formattedSharePath
  );
  
  console.log(`Generated unique mount point: ${localMountPoint}`);
  
  if (fs.existsSync(localMountPoint)) {
    console.log(`Mount point directory exists: ${localMountPoint}`);
    
    // Check if it's already mounted
    if (await isMountPoint(localMountPoint)) {
      console.log(`Directory is already mounted: ${localMountPoint}`);
      try {
        await unmountSmbShare(localMountPoint);
        console.log('Successfully unmounted existing mount point');
      } catch (unmountError) {
        console.warn('Error unmounting:', unmountError);
        throw new Error(`Failed to unmount existing mount point: ${unmountError.message}`);
      }
    }
  } else {
    console.log(`Creating mount point directory: ${localMountPoint}`);
    fs.mkdirSync(localMountPoint, { recursive: true });
  }
  
  return String(localMountPoint);
}

module.exports = {
  saveMountPointsToCSV,
  mountToSmbShare,
  unmountSmbShare,
  isMountPoint,
  createNewMountPoint,
  MOUNT_DIRECTORY,
  MOUNT_LIST
};
