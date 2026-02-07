// processFiles.js
const HOT_DIRECTORY = require("path").resolve(__dirname, "../hotdir");
const SMB_FILELIST = 'file_data.csv';
const { v4: uuidv4 } = require('uuid'); // Import UUID library
const path = require('path'); // Ensure you have this import at the top
const SMB2 = require('@marsaud/smb2');
const fs = require('fs'); // Import fs 
const util = require('util');
const { promisify } = require('util');
const fsCopyFile = promisify(fs.copyFile); // Promisify copyFile for async/await
// Use modern webcrypto API
const crypto = globalThis.crypto || require('crypto').webcrypto;
const { exec } = require('child_process'); // Ensure this line is present
const { createObjectCsvWriter } = require('csv-writer');
const execPromise = util.promisify(exec); // Promisify exec for async/await
//const dfd = require("danfojs-node"); // Import Danfo.js
const { logMemoryUsage ,enableDebugLogging} = require('../utils/memoryMonitor');
// Enable with environment variable
enableDebugLogging(process.env.DEBUG_MEMORY === 'true');
// Add delay helper at the top of file
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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

// 1. Add garbage collection helper
const forceGC = async () => {
  if (global.gc) {
    global.gc();
  }
};

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '3');
const CONCURRENT_OPERATIONS = parseInt(process.env.CONCURRENT_OPERATIONS || '3');
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1048576'); // 1MB

// Function to list files using smbclient
function listFilesWithSmbClient(targetNAS, username, password, smbSharePath) {
  return new Promise((resolve, reject) => {
      // Command to list files recursively
      const command = `smbclient //192.168.1.10/Pictures  -U ${username}%${password} -c "recurse; ls" -m SMB3 > smbclient_output.txt 2>&1`;
      console.log(`Executing command: ${command}`); // Debug log
      exec(command, (error) => {
        if (error) {
            console.error(`Error executing command: ${command}`);
            return reject(`Error listing files: ${error.message}`);
        }

        // Read the output from the file
        fs.readFile('smbclient_output.txt', 'utf8', (readError, data) => {
            if (readError) {
                console.error(`Error reading output file: ${readError.message}`);
                return reject(`Error reading output file: ${readError.message}`);
            }

            // Parse the output
            const files = parseSmbClientOutput(data);
            resolve(files);
        });
    });
  });
}

// Function to parse the output of smbclient
function parseSmbClientOutput(output) {
  const files = [];
  const lines = output.split('\n');

  for (const line of lines) {
      // Check if the line contains a file or directory
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (match) {
          const filePath = match[5]; // The file path is in the last group
          filePath = filePath.replace(/[\/\\]/g, '\\'); 
          files.push(filePath);
      }
  }

  return files;
}

// Function to mount the SMB share
function mountSmbShare(targetNAS, username, password, smbSharePath, localMountPoint) {
    return new Promise((resolve, reject) => {
        const command = `sudo mount -t cifs \\${targetNAS}\${smbSharePath} ${localMountPoint} -o username=${username},password=${password},vers=3.0`;
        //const command = `sudo mount.cifs //${targetNAS}/${smbSharePath} ${localMountPoint} -o username=${username},password=${password},vers=3.0`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return reject(`Error mounting SMB share: ${stderr}`);
            }
            resolve(stdout);
        });
    });
}

// Function to list all files in a directory recursively
async function listFilesInMountedDirectory(directory) {
  const allFiles = [];

  const files = fs.readdirSync(directory);
  for (const file of files) {
      const fullPath = path.join(directory, file);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
          // Recursively list files in the subdirectory
          const subDirFiles = await listFilesInDirectory(fullPath);
          allFiles.push(...subDirFiles);
      } else {
          allFiles.push(fullPath); // Add the full file path
      }
  }

  return allFiles;
}

// Function to save file information to a CSV file
async function saveToCsv(fileData, outputPath) {
  const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
          { id: 'file_path', title: 'file_path' },
          { id: 'processed', title: 'processed' },
          { id: 'hash_value', title: 'hash_value' },
      ],
  });

  await csvWriter.writeRecords(fileData);
}

// Function to copy a file from SMB using smbclient
async function copyFileFromSmb(targetFilename, smbSharePath, username, password, hotDirectory) {
  const prefix = uuidv4();
  let tempFilePath = null;
  let formattedLocalPath = null;

  try {
    // Initial path setup
    const originalFileName = path.basename(targetFilename);
    const newFileName = `${prefix}_${originalFileName}`;
    // Don't include originalDir - hotDirectory already contains the full path
    const newFilePath = path.join(hotDirectory, newFileName);
    formattedLocalPath = newFilePath.replace(/[\/\\]/g, '/');

    if (RESERVED_FILES.includes(newFileName)) {
      return {
        success: false,
        reason: "Reserved filename",
        documents: [],
      };
    }

    // Create directory
    const targetDir = path.dirname(formattedLocalPath);
    await fs.promises.mkdir(targetDir, { recursive: true });

    // Use temp file
    tempFilePath = `${formattedLocalPath}.tmp`;

    const command = `smbclient "\\${smbSharePath}" -U "${username}%${password}" -c 'get "${targetFilename}" "${tempFilePath}"'`;
    
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Set timeout for command execution
        const timeout = 30000; // 30 seconds
        const execResult = await Promise.race([
          execPromise(command),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Command timeout')), timeout)
          )
        ]);

        // Verify temp file
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size === 0) {
          throw new Error('Copy resulted in empty file');
        }

        // Move temp to final location
        await fs.promises.rename(tempFilePath, formattedLocalPath);
        console.log(`Successfully copied to: ${formattedLocalPath}`);
        
        // Clear references
        tempFilePath = null;

        await delay(1000);
        return formattedLocalPath;

      } catch (error) {
        attempt++;
        console.error(`Attempt ${attempt} failed:`, error.message);
        
        // Cleanup temp file
        await cleanupTempFile(tempFilePath);
        
        if (attempt >= maxRetries) {
          throw new Error(`Copy failed after ${maxRetries} attempts`);
        }

        // Exponential backoff
        await new Promise(resolve => 
          setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000))
        );
      }
    }
  } catch (error) {
    console.error(`Copy failed for ${targetFilename}:`, error);
    throw error;
  } finally {
    // Final cleanup
    await cleanupTempFile(tempFilePath);
    if (global.gc) global.gc();
  }
}

// Helper for temp file cleanup
async function cleanupTempFile(tempPath) {
  if (tempPath && fs.existsSync(tempPath)) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (error) {
      console.warn('Temp file cleanup failed:', error);
    }
  }
}

// Function to read a file from SMB and write it to a local path
async function copyFileFromSmbToLocal(smb2Client, targetFilename, hotDirectory) {
  
  const prefix = uuidv4();
  const originalFileName = path.basename(targetFilename);
  const newFileName = `${prefix}_${originalFileName}`;
  // Don't include originalDir - hotDirectory already contains the full path
  const newFilePath = path.join(hotDirectory, newFileName);
  
  console.log(`targetFilename : ${targetFilename}`);
  if (RESERVED_FILES.includes(newFileName))
    return {
      success: false,
      reason: "Filename is a reserved filename and cannot be processed.",
      documents: [],
    };

  const formattedLocalPath = newFilePath.replace(/[\/\\]/g, '/');
  console.log(`formattedLocalPath : ${formattedLocalPath}`);
  // Ensure the target directory exists
  const targetDir = path.dirname(formattedLocalPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true }); // Create the directory if it doesn't exist
  }

  let fileData;
  targetFilename = targetFilename.replace(/[\/\\]/g, '\\');
  // Open the file and perform operations
  // const fileHandle = await smb2Client.open(targetFilename);
  try {
    console.log(`[MEMORY] Before reading file from SMB:`, process.memoryUsage());
    fileData = await smb2Client.readFile(targetFilename); // Read the file from SMB
    console.log(`Read file from SMB: ${targetFilename}`);
    console.log(`[MEMORY] After reading file from SMB:`, process.memoryUsage());
  } catch (error) {
    console.error(`Error reading file from SMB: ${error.message}`);
    throw new Error("Error reading file from SMB.");
  }

  // Write the file data to the local directory
  try {
    console.log(`[MEMORY] Before writing file to local directory:`, process.memoryUsage());
    // Ensure the file is written with UTF-8 encoding
    fs.writeFileSync(formattedLocalPath, fileData, { encoding: 'utf8' }); // Write the file to the local path
    console.log(`Copied file to: ${formattedLocalPath}`);
    console.log(`[MEMORY] After writing file to local directory:`, process.memoryUsage());
    return formattedLocalPath;
  } catch (error) {
    console.error(`Error writing file to local directory: ${error.message}`);
    throw new Error("Error writing file to local directory.");
  }
}

let smbClientLock = false; // Lock variable
const waitingQueue = []; // Queue for waiting workers

async function processFileData(smb2Client, smbSharePathFull, targetFilename, localSmbShareDir, options = {}) {
  let fullFilePath = '';
  
  try {
    // Normalize path
    targetFilename = targetFilename.replace(/^\\+|^\//, '');
    targetFilename = targetFilename.replace(/[\/\\]/g, '/');
    const normalizedTargetPath = normalizePath(targetFilename);
    console.log(`Processing file: ${normalizedTargetPath}`);

    // Wait for SMB lock
    await new Promise(resolve => {
      const attemptLock = async () => {
        while (smbClientLock) {
          await new Promise(res => setTimeout(res, 100));
        }
        smbClientLock = true;
        resolve();
      };
      attemptLock();
    });

    try {
      // Check if file exists
      if (!await smb2Client.exists(targetFilename)) {
        console.warn(`File does not exist: ${targetFilename}`);
        return {
          success: false,
          reason: "File does not exist in upload directory.",
          documents: [],
        };
      }

      // Copy file using smbclient with retries
      fullFilePath = await copyFileFromSmb(
        targetFilename,
        smbSharePathFull,
        options.username,
        options.password,
        localSmbShareDir
      );

      // Copy file using smbclient with retries
      //fullFilePath = await copyFileFromSmbToLocal(
      //  smb2Client,
      //  targetFilename,
      //  localSmbShareDir
      //);

      console.log(`File copied successfully to: ${fullFilePath}`);

      // Verify file was copied
      if (!fs.existsSync(fullFilePath)) {
        throw new Error("File copy failed - file not found after copy");
      }

      // Check file extension
      const fileExtension = path.extname(fullFilePath).toLowerCase();
      if (fullFilePath.includes(".") && !fileExtension) {
        return {
          success: false,
          reason: "No file extension found. This file cannot be processed.",
          documents: [],
        };
      }

      // Determine how to process the file
      let processFileAs = fileExtension;
      if (!SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension)) {
        if (isTextType(fullFilePath)) {
          console.log(
            `\x1b[33m[Collector]\x1b[0m Processing ${fileExtension} as .txt`
          );
          processFileAs = ".txt";
        } else {
          trashFile(fullFilePath);
          return {
            success: false,
            reason: `Unsupported file extension: ${fileExtension}`,
            documents: [],
          };
        }
      }

      // Process the file
      const FileTypeProcessor = require(SUPPORTED_FILETYPE_CONVERTERS[processFileAs]);
      return await FileTypeProcessor({
        fullFilePath,
        filename: path.basename(fullFilePath),
        options,
      });

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
  } finally {
    smbClientLock = false; // Release lock
    
    // Cleanup temp file if copy failed
    if (fullFilePath && !fs.existsSync(fullFilePath)) {
      const tempPath = `${fullFilePath}.tmp`;
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (error) {
          console.warn("Failed to cleanup temp file:", error);
        }
      }
    }
  }
}

// list files in the smb2Client connected, the directory could be the sub-directory or empty
async function listFilesInDirectory(smb2Client, directory, ignorePaths) {
  try {
      console.log(`🔎 readdir starting for directory: "${directory}"`);
      const files = await new Promise((resolve, reject) => {
          smb2Client.readdir(directory, (err, files) => {
              if (err) {
                  console.error(`❌ readdir failed for "${directory}":`, err.message);
                  return reject(err);
              }
              console.log(`✅ readdir success for "${directory}": ${files.length} items`);
              resolve(files);
          });
      });

      const displayDir = directory || '(root)';
      console.log(`📁 Scanning: ${displayDir} - Found ${files.length} items`);

      const allFiles = [];

      for (const file of files) {
          // Construct the full path for the file
          let fullPath = path.join(directory, file);
          fullPath = fullPath.replace(/[\/\\]/g, '\\'); 


          // Check if the file is a directory
          const stats = await new Promise((resolveStats, rejectStats) => {
              smb2Client.stat(fullPath, (err, stats) => {
                  if (err) {
                      return rejectStats(err);
                  }
                  resolveStats(stats);
              });
          });

          if (stats.isDirectory()) {
              // Recursively list files in the subdirectory
              const subDirFiles = await listFilesInDirectory(smb2Client, fullPath,ignorePaths);
              allFiles.push(...subDirFiles); // Add the files from the subdirectory
          } else {
              let fileExtensions = []
              if(Array.isArray(ignorePaths) && !(ignorePaths.length === 0)){
                  fileExtensions = ignorePaths.map(pattern => {
                    const match = pattern.match(/\.(\w+)$/); // Matches the file extension part
                    return match ? `.${match[1]}` : null; // Return with dot prefix
                  }).filter(Boolean); // Remove any null values (in case a pattern doesn't match)
                }
              const fileExtension = path.extname(fullPath).toLowerCase();
              // Check if the file is processed and the extension is not supported
              const isSupported = SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty((fileExtension));
              const isIgnored = fileExtensions.includes(fileExtension);
              if(!isIgnored && isSupported) {
                console.log(`  ✓ Adding file: ${path.basename(fullPath)} (ext: ${fileExtension})`);
                allFiles.push(fullPath); // Add the full file path
              } else {
                console.log(`  ✗ Skipping: ${path.basename(fullPath)} (ext: ${fileExtension}, ignored: ${isIgnored}, supported: ${isSupported})`);
              }
          }
      }

      // Save all file paths to a CSV file
      // await saveToCsv(allFiles.map(file => ({ file_path: file, processed: false, hash_value: '' })), csvFilePath);
      
      if (directory === '' || directory === '\\') {
        console.log(`✅ Total files found: ${allFiles.length}`);
      }
      
      return allFiles; // Return the path of the CSV file
  } catch (err) {
    console.error(`Error listing files in directory: ${err.message}`); // Log the error
    throw new Error(`Error listing files in directory: ${err.message}`);
  }
}


// Update the hash generation function
function generateFileHash(filePath) {
    // Use modern subtle crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(filePath);
    return crypto.subtle.digest('SHA-256', data)
        .then(hash => {
            return Array.from(new Uint8Array(hash))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        });
}

// Function to process a single file
async function processSingleFile(smb2Client, smbSharePathFull, localSmbShareDir, record, existingFileData, fileData, options) {
  let { file_path, hash_value } = record;
  file_path = file_path.replace(/[\/\\]/g, '\\');
  file_path = `\\${file_path}`;
  console.log(`Processing file: ${file_path}`);

  // Process the file
  const result = await processFileData(smb2Client, smbSharePathFull, file_path, localSmbShareDir, options);
  if (!result.success) {
      console.warn(`Error processing file ${file_path}: ${result.reason}`);
      return null; // Skip to the next file
  }

  // Generate hash for the file path
  hash_value = generateFileHash(file_path);

  // Update the record in existingFileData
  file_path = file_path.replace(/^\\+|^\//, '')
  const updatedRecord = {
      file_path: file_path,
      processed: true,
      hash_value: hash_value,
  };
  console.log()
  const index = existingFileData.findIndex(record => record.file_path === file_path);
  if (index !== -1) {
      existingFileData[index] = updatedRecord; // Update the existing record
  } else {
      fileData.push(updatedRecord); // If not found, add to new file data
  }

  return result.documents; // Return processed documents
}

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Batch timeout')), ms));

const processBatchWithTimeout = async (batch, smb2Client, smbSharePathFull, localSmbShareDir, existingFileData, fileData, {username, password}, batchTimeout = 5000) => {
    // Import p-limit dynamically
    const pLimit = (await import('p-limit')).default; // Use dynamic import
    const limit = pLimit(CONCURRENT_OPERATIONS); // Set the maximum number of concurrent executions
    try {
      // Create the promises for the batch
      const promises = batch.map(record => {
        return limit(() => processSingleFile(smb2Client, smbSharePathFull, localSmbShareDir, record, existingFileData, fileData, {username, password}));
      });

      // Race the batch promises against a timeout
      const processedDocs = await Promise.race([
        Promise.all(promises),    // Process all files in the batch
        timeout(batchTimeout)      // Timeout if the batch takes too long
      ]);
      // Cleanup after each file
      logMemoryUsage(); // Log after batch
      await forceGC();
      // Add the processed documents (files) to the existing file data
      return processedDocs; // Return the processed documents (files)
    } catch (error) {
      if (error.message === 'Batch timeout') {
        console.log(`Batch timed out!`);
      } else {
        console.error(`Error processing batch: ${error}`);
      }
      return []; // If there was an error, return an empty array
    }
};

async function processFiles(processId,activeProcesses, smbSharePath, username, password,ignorePaths) {
    logMemoryUsage(); 
    //const { username, password, smbSharePath } = options; // Expecting options to contain username, password, and smbSharePath
    const fileData = []; // Array to hold file information
    // Import p-limit dynamically
    const pLimit = (await import('p-limit')).default; // Use dynamic import

    // Validate inputs
    //if (!targetNAS || typeof targetNAS !== 'string') {
    //    throw new Error("Invalid targetNAS: must be a non-empty string.");
    //}
    if (!smbSharePath || typeof smbSharePath !== 'string') {
        throw new Error("Invalid smbSharePath: must be a non-empty string.");
    }

    // Combine targetNAS with smbSharePath to create the full SMB share path
    // Remove leading slashes and backslashes
    let formattedSharePath = smbSharePath.replace(/^\/+|^\\+/, ''); // Remove leading slashes and backslashes
    formattedSharePath = formattedSharePath.replace(/[\/\\]/g, '/'); //replace all to '/' as unix format
    
    // Parse the share path to separate share from subdirectory
    // Format: //server/share/subdir1/subdir2 -> share: //server/share, subdir: subdir1/subdir2
    const pathParts = formattedSharePath.split('/');
    let sharePath = '';
    let subDirectory = '';
    
    if (pathParts.length >= 2) {
      // First two parts are server/share
      sharePath = pathParts.slice(0, 2).join('\\');
      // Remaining parts are subdirectory
      if (pathParts.length > 2) {
        subDirectory = pathParts.slice(2).join('\\');
      }
    } else {
      sharePath = formattedSharePath.replace(/\//g, '\\');
    }
    
    const localMountPoint = normalizePath(`/tmp/${formattedSharePath}`); // Local mount point
    const smbSharePathFull = `\\\\${sharePath}`;
    
    console.log('Connecting to SMB share:', smbSharePathFull);
    if (subDirectory) {
      console.log('Starting directory:', subDirectory);
    }

    let smb2Client
    try {
        console.log('🔌 Creating SMB2 client...');
        // Create an SMB2 client
        smb2Client = new SMB2({
            share: smbSharePathFull, // The SMB share path (e.g., //NAS_IP_Address/Shared/Path)
            username: username,
            password: password,
            domain: '',                 // Add domain if needed
            port: 445,                 // Standard SMB port        
        });
        console.log('✅ SMB2 client created successfully');
    } catch (err) {
        console.error('❌ Failed to create SMB2 client:', err.message);
        // In case of failure, return the error response with the format you specified
        return {
            success: false,
            reason: 'Error open connect to share path: ' + err.message,
            documents: []
        };
    }
    
    try {
        // Check if the CSV file exists and read its contents
        const localSmbShareDir = normalizePath(path.join(HOT_DIRECTORY, normalizePath(formattedSharePath)));
        const csvFilePath = path.join(localSmbShareDir, SMB_FILELIST);
        let existingFileData = [];
        if (!fs.existsSync(csvFilePath)) {
            // Ensure the target directory exists
            if (!fs.existsSync(localSmbShareDir)) {
              fs.mkdirSync(localSmbShareDir, { recursive: true }); // Create the directory if it doesn't exist
            }
            console.log(`🔍 Starting SMB file discovery...`);
            if (Array.isArray(ignorePaths) && ignorePaths.length > 0) {
              const ignoreExts = ignorePaths.map(p => p.match(/\.(\w+)$/)?.[1]).filter(Boolean);
              console.log(`⚙️  Ignoring extensions: [${ignoreExts.join(', ')}]`);
            }
            
            console.log(`📂 Calling listFilesInDirectory with subDirectory: "${subDirectory}"`);
            // Start listing from the subdirectory if specified
            const allFiles = await listFilesInDirectory(smb2Client, subDirectory, ignorePaths);
            console.log(`✅ listFilesInDirectory completed. Found ${allFiles.length} files`);
            // Save all file paths to a CSV file
            await saveToCsv(allFiles.map(file => ({ file_path: file, processed: false, hash_value: '' })), csvFilePath);
            console.log(`💾 Saved file list to CSV`);
            logMemoryUsage();
        }
        //const df = await dfd.readCSV(csvFilePath);
        //existingFileData = df.toJSON();
        console.log(`📖 Reading CSV from: ${csvFilePath}`);
        const csvData = fs.readFileSync(csvFilePath, 'utf8');
        logMemoryUsage();

        existingFileData = csvData.split('\n').slice(1).map(line => { // Skip the first line
          const [file_path, processed, hash_value] = line.split(',');
          return { file_path, processed: processed === 'true', hash_value };
        });
        console.log(`📖 CSV loaded: ${existingFileData.length} records`);
        if (existingFileData.length > 0) {
          const firstRecord = existingFileData[0];
          console.log(`📋 Sample record: ${JSON.stringify(firstRecord)}`);
          const processedCount = existingFileData.filter(r => r.processed).length;
          console.log(`📊 Processed: ${processedCount}, Unprocessed: ${existingFileData.length - processedCount}`);
        }   

        // Filter out processed files
        // const unprocessedFiles = existingFileData.filter(record => !record.processed);
        
        console.log(`🔍 Filtering unprocessed files...`);
        // Filter out processed files and unsupported file extensions
        const unprocessedFiles = existingFileData.filter(record => {
          const fileExtension = path.extname(record.file_path).toLowerCase();
          // Check if the file is processed and the extension is not supported
          return !record.processed && SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty((fileExtension));
        });
        console.log(`✅ Found ${unprocessedFiles.length} unprocessed files out of ${existingFileData.length} total`);

        // Process each file
        // Set up p-limit
        const limit = pLimit(5); // Set the maximum number of concurrent executions

        const batchSize = BATCH_SIZE; // Number of files to process in each batch
        const totalFiles = unprocessedFiles.length; // Total number of unprocessed files
        let processedDocs = [];
        let currentProgress = 0;
        
        console.log(`🚀 Starting batch processing: ${totalFiles} files, batch size: ${batchSize}`);
        
        if (totalFiles === 0) {
          console.log(`✅ No files to process - all files already processed`);
          activeProcesses.set(processId, { ...activeProcesses.get(processId), status: 'completed', progress: 100, result: 'No new files to process - all files already processed!' ,timestamp: Date.now()});
          return { success: true, reason: 'No new files to process', documents: [] };
        }
        
        for (let i = 0; i < totalFiles; i += batchSize) {
            console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(totalFiles / batchSize)} (files ${i + 1}-${Math.min(i + batchSize, totalFiles)})`);
            console.log(`[MEMORY] Before processing batch:`, process.memoryUsage());
            // Check if the process should stop
            if (activeProcesses.get(processId).shouldStop) {
              console.log(`⛔ Process ${processId} stopped.`);
              activeProcesses.set(processId, { ...activeProcesses.get(processId), status: 'interrupted', progress: ((i / totalFiles) * 100).toFixed(2), result: null ,timestamp: Date.now()});
              break;
            }
            console.log(`⏳ Processing batch with timeout...`);
            // Slice the array to get the current batch
            const currentBatch = unprocessedFiles.slice(i, i + batchSize);
            // Create an array of promises with concurrency control
            // const promises = currentBatch.map(record => {
            //    return limit(() => processSingleFile(smb2Client, smbSharePathFull, record, existingFileData, fileData, {username, password}));
            //});

            // Process the current batch with a timeout
            processedDocs = await processBatchWithTimeout(currentBatch, smb2Client, smbSharePathFull, localSmbShareDir, existingFileData, fileData, {username, password}, 60000); // 10 seconds timeout per batch
            console.log(`[MEMORY] After processing batch:`, process.memoryUsage());
            console.log(`✅ Batch completed: ${processedDocs.length} files processed`);
            
            currentProgress = ((i / totalFiles) * 100).toFixed(2);
            activeProcesses.set(processId, { ...activeProcesses.get(processId), status: 'running', progress: currentProgress, result: null, timestamp: Date.now()});
            // Wait for all promises in the current batch to finish
            // const documents = await Promise.all(promises);

            // Combine existing and new file data
            const combinedFileData = [...existingFileData, ...fileData];

            // Save all file data to a CSV file after processing the current batch
            await saveToCsv(combinedFileData, csvFilePath);
            logMemoryUsage(); // Log after reading CSV
            console.log(`Processed batch ${Math.floor(i / batchSize) + 1} and saved to file_data.csv`);
        }
        // Return success response
        activeProcesses.set(processId, { ...activeProcesses.get(processId), status: 'completed', progress: 100, result: 'Process completed successfully!' ,timestamp: Date.now()});
        return { success: true, reason: 'Files processed successfully', documents: processedDocs };
    } catch (err) {
        console.error('❌ Error processing files:', err);
        console.error('❌ Error stack:', err.stack);
        console.error('❌ Error name:', err.name);
        // Get current process state to preserve progress if available
        const currentProcess = activeProcesses.get(processId);
        const progress = (currentProcess && currentProcess.progress) || 0;
        activeProcesses.set(processId, { ...currentProcess, status: 'failed', progress: progress, result: `Error: ${err.message}`,timestamp: Date.now() });
        return { success: false, reason: 'Error processing files: ' + err.message, documents: [] }; // Return error response
    } finally {
        // Mark process as completed
        // activeProcesses.delete(id);
        logMemoryUsage(); // Log after reading CSV
        smb2Client.disconnect(); // Close the SMB client connection
    }
}

module.exports = { processFiles };