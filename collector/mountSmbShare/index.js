const HOT_DIRECTORY = require("path").resolve(__dirname, "../hotdir");
const SMB_FILELIST = 'file_data.csv';
const MOUNT_LIST = "mountpoints.csv";
const MOUNT_DIRECTORY = require("path").resolve(__dirname, "../../mountpoint");
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { promisify } = require('util');
const fsCopyFile = promisify(fs.copyFile);
const crypto = globalThis.crypto || require('crypto').webcrypto;
const { exec } = require('child_process');
const { createObjectCsvWriter } = require('csv-writer');
const execPromise = util.promisify(exec);
const {
  WATCH_DIRECTORY,
  SUPPORTED_FILETYPE_CONVERTERS,
} = require("../utils/constants");
const {
  trashFile,
  isTextType,
  normalizePath,
  isWithin,
} = require("../utils/files");

const RESERVED_FILES = ["__HOTDIR__.md"];
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '3');
const CONCURRENT_OPERATIONS = parseInt(process.env.CONCURRENT_OPERATIONS || '3');
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1048576'); // 1MB

const forceGC = async () => {
  if (global.gc) {
    global.gc();
  }
};

async function saveToCsv(fileData, outputPath) {
  try {   
    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: 'file_path', title: 'file_path' },
        { id: 'processed', title: 'processed' },
        { id: 'hash_value', title: 'hash_value' }
      ]
    });

    const formattedData = fileData.map(record => ({
      file_path: normalizeUnicodePath(record.file_path || ''),
      processed: String(!!record.processed),
      hash_value: record.hash_value || ''
    }));

    await csvWriter.writeRecords(formattedData);
    console.log(`CSV saved successfully: ${outputPath}`);

  } catch (error) {
    console.error('Error saving CSV:', error);
    throw new Error(`Failed to save CSV to ${outputPath}: ${error.message}`);
  }
}

function debugEncoding(filename) {
  console.log('\n=== Filename Encoding Debug ===');
  console.log('Original:', filename);
  console.log('Buffer:', Buffer.from(filename).toString('hex'));
  
  const encodings = ['utf8', 'utf16le', 'big5', 'gb2312', 'gbk', 'binary'];
  encodings.forEach(encoding => {
    try {
      const decoded = Buffer.from(filename).toString(encoding);
      console.log(`${encoding}:`, decoded);
    } catch (err) {
      console.log(`${encoding}: Failed -`, err.message);
    }
  });
  console.log('===========================\n');
}

async function listFilesInDirectory(smbSharePathFull, directory, ignorePaths) {
  try {
    const allFiles = [];
    console.log(`Scanning directory: ${directory}`);
    
    const files = await fs.promises.readdir(directory, { 
      withFileTypes: true,
      encoding: 'utf8'
    }).catch(err => {
      if (err.code === 'ENOENT') {
        return fs.promises.readdir(Buffer.from(directory), {
          withFileTypes: true,
          encoding: 'buffer'
        });
      }
      throw err;
    });

    for (const dirent of files) {
      try {
        let fileName;
        if (Buffer.isBuffer(dirent.name)) {
          fileName = dirent.name.toString('utf8');
        } else {
          fileName = dirent.name;
        }
        
        const fullPath = path.join(directory, fileName);
        const normalizedPath = path.normalize(fullPath)
          .replace(/\\/g, '/')
          .replace(/\/+/g, '/');

        console.log(`Checking path: ${normalizedPath}`);

        if (dirent.isDirectory()) {
          try {
            const subDirFiles = await listFilesInDirectory(smbSharePathFull, normalizedPath, ignorePaths);
            allFiles.push(...subDirFiles);
          } catch (subDirError) {
            console.warn(`Skipping inaccessible subdirectory ${normalizedPath}:`, subDirError.message);
            continue;
          }
        } else {
          const fileExtension = path.extname(normalizedPath).toLowerCase();
          
          if (!ignorePaths && Array.isArray(ignorePaths) && ignorePaths.length > 0) {
            const fileExtensions = ignorePaths
              .map(pattern => {
                const match = pattern.match(/\.(\w+)$/);
                return match ? match[1].toLowerCase() : null;
              })
              .filter(Boolean);

            if (fileExtensions.includes(fileExtension.slice(1))) {
              continue;
            }
          }

          const isSupported = SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension);
          if (isSupported) {
            const relativePath = path.relative(smbSharePathFull, normalizedPath);
            console.log(`Relative path: ${relativePath}`);    
            allFiles.push(relativePath);
          }
        }
      } catch (itemError) {
        console.warn(`Error processing item ${dirent.name}:`, itemError.message);
        continue;
      }
    }

    return allFiles;

  } catch (err) {
    console.error(`Error listing files in ${directory}:`, err);
    throw new Error(`Failed to list files: ${err.message}`);
  }
}

function normalizeUnicodePath(filepath) {
  if (!filepath) return '';
  try {
    return path.normalize(filepath)
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/');
  } catch (error) {
    console.error('Path normalization error:', error);
    return filepath;
  }
}

async function copyFileFromSmbToLocal(smbSharePathFull, targetFilename, hotDirectory) {
  try {
    const prefix = uuidv4();
    const originalFileName = path.basename(targetFilename);
    const originalDir = path.dirname(targetFilename);
    const newFileName = `${prefix}_${originalFileName}`;
    const newPath = path.join(originalDir, newFileName);
    const newFilePath = path.join(hotDirectory, newPath);
    const normalizedTargetPath = path.join(smbSharePathFull, targetFilename);
    
    if (RESERVED_FILES.includes(newFileName)) {
      return {
        success: false,
        reason: "Reserved filename",
        documents: [],
      };
    }

    const formattedLocalPath = newFilePath.replace(/[\/\\]/g, '/');

    const targetDir = path.dirname(formattedLocalPath);
    await fs.promises.mkdir(targetDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(normalizedTargetPath);
      const writeStream = fs.createWriteStream(formattedLocalPath);

      readStream.on('error', (error) => {
        console.error('Read error:', error);
        reject(error);
      });

      writeStream.on('error', (error) => {
        console.error('Write error:', error);
        reject(error);
      });

      writeStream.on('finish', () => {
        resolve();
      });

      readStream.pipe(writeStream);
    });

    const stats = await fs.promises.stat(formattedLocalPath);
    if (stats.size === 0) {
      throw new Error('Copied file is empty');
    }

    console.log(`Successfully copied to: ${formattedLocalPath}`);
    return formattedLocalPath;

  } catch (error) {
    console.error('Copy failed:', error);
    throw new Error(`Failed to copy file: ${error.message}`);
  }
}

async function processFileData(smbSharePathFull, targetFilename, localSmbShareDir, options = {}) {
  let fullFilePath = '';
  
  try {
    targetFilename = targetFilename.replace(/^\\+|^\//, '/');
    targetFilename = targetFilename.replace(/[\/\\]/g, '/');
    const normalizedTargetPath = normalizePath(path.join(smbSharePathFull, targetFilename));

    try {
      if (!fs.existsSync(normalizedTargetPath)) {
        console.warn(`File does not exist: ${normalizedTargetPath}`);
        return {
          success: false,
          reason: "File does not exist in mounted directory.",
          documents: [],
        };
      }

      const stats = await fs.promises.stat(normalizedTargetPath);
      if (!stats.isFile()) {
        console.warn(`Path exists but is not a file: ${normalizedTargetPath}`);
        return {
          success: false,
          reason: "Path exists but is not a file.",
          documents: [],
        };
      }

      fullFilePath = await copyFileFromSmbToLocal(smbSharePathFull, targetFilename, localSmbShareDir);        

      const fileExtension = path.extname(fullFilePath).toLowerCase();
      if (fullFilePath.includes(".") && !fileExtension) {
        return {
          success: false,
          reason: "No file extension found. This file cannot be processed.",
          documents: [],
        };
      }

      let processFileAs = fileExtension;
      if (!SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension)) {
        if (isTextType(fullFilePath)) {
          console.log(
            `\x1b[33m[Collector]\x1b[0m Processing ${fileExtension} as .txt`
          );
          processFileAs = ".txt";
        } else {
          return {
            success: false,
            reason: `Unsupported file extension: ${fileExtension}`,
            documents: [],
          };
        }
      }

      const FileTypeProcessor = require(SUPPORTED_FILETYPE_CONVERTERS[processFileAs]);
      const result = await FileTypeProcessor({
        fullFilePath: fullFilePath,
        filename: path.basename(fullFilePath),
        opWithOrignal: false
      });
      
      const hash_value = await generateFileHash(targetFilename);
      return {
        ...result,
        documents: result.documents.map(doc => ({
          ...doc,
          targetFilename: targetFilename,
          hash_value: hash_value
        }))
      };

    } catch (error) {
      console.error("Error processing file:", error);
      return {
        success: false,
        reason: error.message,
        documents: [],
      };
    }
  } catch (error) {
    console.error("Fatal error in processFileData:", error);
    return {
      success: false,
      reason: error.message,
      documents: [],
    };
  } 
}

async function generateFileHash(filePath) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(filePath);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (error) {
    console.error('Error generating file hash:', error);
    return '';
  }
}
  
async function processSingleFile(smbSharePathFull, localSmbShareDir, record, options) {
  let { file_path, hash_value } = record;
  let targetFilename = file_path.replace(/^\\+|^\//, '/');
  targetFilename = targetFilename.replace(/[\/\\]/g, '/');    
  console.log(`Processing file: ${targetFilename}`);

  const result = await processFileData(smbSharePathFull, targetFilename, localSmbShareDir, options);
  if (!result.success) {
    console.warn(`Error processing file ${file_path}: ${result.reason}`);
    return null;
  }

  return result.documents;
}

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Batch timeout')), ms));

const processBatchConcurrent = async (batch, smbSharePathFull, localSmbShareDir, credentials, batchTimeout = 180000) => {
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(CONCURRENT_OPERATIONS);
  const activeOperations = new Set();

  try {
    const promises = batch.map(record => {
      const operationPromise = limit(async () => {
        try {
          activeOperations.add(record.file_path);
          
          const result = await processSingleFile(
            smbSharePathFull,
            localSmbShareDir,
            record,
            credentials
          );

          activeOperations.delete(record.file_path);
          return result;
        } catch (error) {
          activeOperations.delete(record.file_path);
          console.error(`Error processing file ${record.file_path}:`, error);
          return null;
        }
      });
      return operationPromise;
    });

    const results = await Promise.all(promises);
    return results.filter(Boolean);

  } catch (error) {
    console.error(`Batch processing error: ${error.message}`);
    
    if (error.message === 'Batch timeout') {
      console.warn(`Batch timed out after ${batchTimeout}ms`);
      console.warn(`Files still processing:`, Array.from(activeOperations));   
    }
    
    return [];
  } finally {
    activeOperations.clear();
    await forceGC();
  }
};

async function isMountPoint(path) {
  try {
    const { stdout } = await execPromise('mount');
    return stdout.includes(path);
  } catch (error) {
    console.error('Error checking mount point:', error);
    return false;
  }
}

async function findExistingMount(nasshare, csvPath = path.join(MOUNT_DIRECTORY, MOUNT_LIST)) {
  try {
    const cleanNasShare = nasshare.replace(/^[\/\\]+/, '//').replace(/\\/g, '/');
    if (!fs.existsSync(csvPath)) {
      console.log(`Mount list file not found: ${csvPath}`);
      return null;
    }

    const csvContent = await fs.promises.readFile(csvPath, 'utf8');
    const records = csvContent.split('\n')
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
          status: status.trim(),
        };
      });

    const mountedRecords = records
      .filter(record => 
        record.targetPath === cleanNasShare && 
        record.status === 'mounted'
      )
      .sort((a, b) => new Date(b.mountTime) - new Date(a.mountTime));

    if (mountedRecords.length > 0) {
      const latestMount = mountedRecords[0];
      console.log(`Found existing mount for ${nasshare}:`, latestMount);
      
      if (fs.existsSync(latestMount.mountPoint)) {
        return {
          mountId: latestMount.mountId.trim(),
          mountPoint: latestMount.mountPoint.trim(),
          targetPath: latestMount.targetPath.trim(),
          listName: latestMount.listName.trim(),
          mountTime: latestMount.mountTime.trim(),
          status: latestMount.status.trim()
        };
      } else {
        console.log(`Mount point no longer exists: ${latestMount.mountPoint}`);
        return null;
      }
    }

    console.log(`No active mount found for ${nasshare}`);
    return null;

  } catch (error) {
    console.error('Error reading mount list:', error);
    return null;
  }
}

async function createNewMountPoint(mountpoint, mountId, formattedSharePath) {
  const localMountPoint = path.join(
    mountpoint,
    mountId,
    formattedSharePath
  );
  console.log(`Generated unique mount point: ${localMountPoint}`);

  if (fs.existsSync(localMountPoint)) {
    console.log(`Mount point directory exists: ${localMountPoint}`);
    
    if (await isMountPoint(localMountPoint)) {
      console.log(`Directory is already mounted: ${localMountPoint}`);
      try {
        await execPromise(`sudo umount -f "${localMountPoint}"`);
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

async function processFilesInBatches(processId, activeProcesses, unprocessedFiles, localMountPoint, localSmbShareDir, username, password, csvFilePath, existingFileData) {
  const batchSize = BATCH_SIZE;
  const totalFiles = unprocessedFiles.length;
  let processedDocs = [];

  // Import handleLocalFilesCache if available
  let handleLocalFilesCache;
  try {
    const filesUtils = require('../utils/files');
    handleLocalFilesCache = filesUtils.handleLocalFilesCache;
  } catch (e) {
    console.log('handleLocalFilesCache not available, skipping cache operations');
  }

  for (let i = 0; i < totalFiles; i += batchSize) {
    if (activeProcesses.get(processId).shouldStop) {
      console.log(`Process ${processId} stopped.`);
      activeProcesses.set(processId, { 
        ...activeProcesses.get(processId), 
        status: 'interrupted', 
        progress: ((i / totalFiles) * 100).toFixed(2),
        result: null, 
        timestamp: Date.now() 
      });
      break;
    }

    const currentBatch = unprocessedFiles.slice(i, i + batchSize);
    processedDocs = await processBatchConcurrent(
      currentBatch, 
      String(localMountPoint), 
      localSmbShareDir, 
      { username, password }, 
      BATCH_SIZE * 180000
    );
    
    activeProcesses.set(processId, { 
      ...activeProcesses.get(processId), 
      status: 'running', 
      progress: ((i / totalFiles) * 100).toFixed(2),
      result: null, 
      timestamp: Date.now() 
    });

    if (Array.isArray(processedDocs) && processedDocs.length > 0) {
      console.log("the processed document is", processedDocs);
      processedDocs.forEach(docArray => {
        docArray.forEach(async (doc) => {
          if (doc) {
            try {
              if (handleLocalFilesCache) {
                await handleLocalFilesCache(doc, 'write');
                await handleLocalFilesCache(doc, 'read');
              }
            } catch (error) {
              console.error("Error handling local file cache:", error);
            }
            
            let file_path = doc.targetFilename;
            file_path = file_path.replace(/^\\+|^\//, '');
            file_path = file_path.replace(/[\/\\]/g, '/');
            console.log("the processed document file path:", file_path);
            
            const updatedRecord = {
              file_path: file_path,
              processed: true,
              hash_value: doc.hash_value,
            };

            const index = existingFileData.findIndex(record => record.file_path === file_path);
            if (index !== -1) {
              existingFileData[index] = updatedRecord;
            } else {
              existingFileData.push(updatedRecord);
            }
          }
        });
      });
      
      if (existingFileData && Array.isArray(existingFileData) && existingFileData.length > 0) {
        await saveToCsv(existingFileData, csvFilePath);
      } else {
        console.log('Skipping CSV save: No file data to write');
      }
    }
    
    console.log(`Processed batch ${Math.floor(i / batchSize) + 1} and saved to file_data.csv`);
  }

  activeProcesses.set(processId, { 
    ...activeProcesses.get(processId), 
    status: 'completed', 
    progress: 100, 
    result: 'Process completed successfully!', 
    timestamp: Date.now() 
  });
  
  return { success: true, reason: 'Files processed successfully', documents: processedDocs };
}

async function mountSmbShare(processId, activeProcesses, nasshare, username, password, ignorePaths, mountpoint = MOUNT_DIRECTORY) {
  const fileData = [];
  const pLimit = (await import('p-limit')).default;

  if (!nasshare || typeof nasshare !== 'string') {
    throw new Error("Invalid nasshare: must be a non-empty string.");
  }

  let formattedSharePath = nasshare.replace(/^\/+|^\\+/, '');
  formattedSharePath = formattedSharePath.replace(/[\/\\]/g, '/');
  let formattedSmbSharePath = formattedSharePath.replace(/[\/\\]/g, '\\');
  formattedSmbSharePath = formattedSmbSharePath.startsWith('\\') ? formattedSmbSharePath.substring(1) : formattedSmbSharePath;

  try {
    // Import mountToSmbShare from utils
    const { mountToSmbShare } = require("../utils/smb");
    
    let mountedRecord = await findExistingMount(nasshare);
    let csvFilePath;
    let localMountPoint;
    
    if (mountedRecord) {
      csvFilePath = mountedRecord.listName;
      localMountPoint = mountedRecord.mountPoint;
      console.log(`Using existing mount point: ${localMountPoint}`);
      
      if (!await isMountPoint(localMountPoint)) {     
        await mountToSmbShare(nasshare, username, password, localMountPoint, mountedRecord.mountId, csvFilePath);
      }
    } else {
      const mountId = uuidv4();
      csvFilePath = path.join(MOUNT_DIRECTORY, `${mountId}-${SMB_FILELIST}`);
      localMountPoint = await createNewMountPoint(mountpoint, mountId, formattedSharePath);
      
      try {
        await mountToSmbShare(nasshare, username, password, localMountPoint, mountId, csvFilePath);
      } catch (mountError) {
        throw new Error(`Failed to mount SMB share: ${mountError.message}`);
      }
      console.log(`Mounted SMB share at ${localMountPoint}`);
    }

    const localSmbShareDir = normalizePath(path.join(HOT_DIRECTORY, normalizePath(formattedSharePath)));
    if (!fs.existsSync(csvFilePath)) {
      if (!fs.existsSync(localSmbShareDir)) {
        fs.mkdirSync(localSmbShareDir, { recursive: true });
      }
    }
    
    let existingFileData = [];
    if (!fs.existsSync(csvFilePath)) {     
      const allFiles = await listFilesInDirectory(localMountPoint, localMountPoint, ignorePaths); 
      await saveToCsv(allFiles.map(file => ({ file_path: file, processed: false, hash_value: '' })), csvFilePath);          
      console.log(`listFilesInDirectory done`);
    }

    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    existingFileData = csvData.split('\n').slice(1).map(line => {
      const [file_path, processed, hash_value] = line.split(',');
      return { file_path, processed: processed === 'true', hash_value };
    });   

    const unprocessedFiles = existingFileData.filter(record => {
      const fileExtension = path.extname(record.file_path).toLowerCase();
      if (ignorePaths && ignorePaths.length > 0) {
        return !record.processed && !ignorePaths.includes(fileExtension) && SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension);
      }
      return !record.processed && SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension);
    });

    processFilesInBatches(processId, activeProcesses, unprocessedFiles, localMountPoint, localSmbShareDir, username, password, csvFilePath, existingFileData);
    return { success: true, reason: 'Start file processing successfully', documents: [] };
    
  } catch (err) {
    console.error('Error processing files:', err);
    activeProcesses.set(processId, { 
      ...activeProcesses.get(processId), 
      status: 'failed', 
      progress: 0, 
      result: `Error: ${err.message}`,
      timestamp: Date.now() 
    });
    return { success: false, reason: 'Error processing files: ' + err.message, documents: [] };
  }
}

module.exports = { mountSmbShare };
