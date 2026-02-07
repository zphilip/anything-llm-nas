const { REDIS_KEYS, redisHelper } = require("../utils/files/redis");
const { cachedVectorInformation } = require("../utils/files");
const { DocumentSyncQueue } = require("../models/documentSyncQueue");

async function handleFileAdd(data) {
    if (data && data.action === "add") {
        console.log('[SERVER MEMORY] handleFileAdd START:', process.memoryUsage());
        const { folderName, fileName } = data;
        const filePath = `${folderName}/${fileName}`;

        // Get the file metadata from Redis
        const fileMetadata = await redisHelper.getFileMetadata(folderName, fileName);
        if (!fileMetadata) {
            console.error(`❌ File metadata not found for ${filePath}`);
            return;
        }

        redisHelper.updateDirectoryAfterFileChange(true); // Mark directory as changed

        // Get the current per-folder data from Redis
        console.log('[SERVER MEMORY] Before getFolderData:', process.memoryUsage());
        let rawFolderData = await redisHelper.getFolderData(folderName);
        
        // Normalize the folder data format - getFolderData returns the object with items array
        let folderData;
        if (!rawFolderData) {
            folderData = { name: folderName, type: "folder", items: [] };
            console.log(`❌ Folder data for '${folderName}' not found. Creating new folder structure.`);
        } else if (Array.isArray(rawFolderData)) {
            // If it's an array, wrap it
            folderData = { name: folderName, type: "folder", items: rawFolderData };
        } else if (rawFolderData.items && Array.isArray(rawFolderData.items)) {
            // Already in correct format
            folderData = rawFolderData;
        } else {
            console.error(`❌ Unexpected folder data format for '${folderName}':`, typeof rawFolderData);
            return;
        }
        
        console.log('[SERVER MEMORY] After getFolderData:', process.memoryUsage());

        // OPTIMIZATION: Use metadata directly from Redis instead of re-reading file from disk
        // The fileMetadata we got from Redis already has all we need, no need to call viewRedisFiles
        console.log('[SERVER MEMORY] Before building file data:', process.memoryUsage());
        
        // Remove large fields from metadata (if present) to prevent memory bloat
        const { pageContent, imageBase64, ...cleanMetadata } = fileMetadata;
        
        // Build the file data object in the format expected by the folder cache
        const cacheFilename = `${folderName}/${fileName}`;
        
        // Quick cache lookup (no disk I/O, just checks if file exists in vector-cache)
        const cached = await cachedVectorInformation(cacheFilename, true);
        
        // Check if live sync is available for this file type
        const liveSyncAvailable = await DocumentSyncQueue.enabled();
        const canWatch = liveSyncAvailable ? DocumentSyncQueue.canWatch(cleanMetadata) : false;
        
        const newFileData = {
            name: fileName,
            type: "file",
            ...cleanMetadata,
            cached,
            canWatch
        };
        
        // Explicitly null out large fields to help GC
        if (fileMetadata.pageContent) fileMetadata.pageContent = null;
        if (fileMetadata.imageBase64) fileMetadata.imageBase64 = null;
        
        console.log('[SERVER MEMORY] After building file data:', process.memoryUsage());

        // Check if file already exists in folder
        const existingFileIndex = folderData.items.findIndex(item => item.name === newFileData.name);
        if (existingFileIndex === -1) {
            // Add new file to folder
            folderData.items.push(newFileData);
            console.log(`✅ Added new file '${newFileData.name}' to folder '${folderName}' (now ${folderData.items.length} files)`);
        } else {
            // Update existing file
            folderData.items[existingFileIndex] = newFileData;
            console.log(`✅ Updated existing file '${newFileData.name}' in folder '${folderName}'`);
        }

        // Save updated per-folder data to Redis and disk (keep in sync)
        console.log('[SERVER MEMORY] Before saveFolderData:', process.memoryUsage());
        await redisHelper.saveFolderData(folderName, folderData);
        console.log('[SERVER MEMORY] After saveFolderData:', process.memoryUsage());

        // Sync to disk cache to keep both in sync
        const { saveFolderCache } = require("../utils/files");
        saveFolderCache(folderName, folderData);
        console.log(`✅ Synced folder '${folderName}' data to disk cache`);

        // Delete metadata from Redis after processing
        // FILE_METADATA is a temporary notification - data now lives in FOLDER_DATA
        await redisHelper.redis.del(`${REDIS_KEYS.FILE_METADATA}${folderName}:${fileName}`);
        console.log(`✅ Metadata for ${fileName} deleted from Redis.`);
        
        // Aggressive memory cleanup - null out large objects to help GC
        if (rawFolderData) {
            if (Array.isArray(rawFolderData)) {
                rawFolderData.length = 0;
            } else if (rawFolderData.items) {
                // Don't null the items array as folderData still references it
                // Instead, clear references to individual large objects within items
                rawFolderData.items = null;
            }
        }
        // Null out the folderData reference after save
        if (folderData && folderData.items) {
            // Don't null items that are still cached, just clear our local reference
            folderData = null;
        }
        
        // Hint to GC that now is a good time (if --expose-gc flag is set)
        if (global.gc) {
            global.gc();
            console.log('[SERVER MEMORY] GC forced after handleFileAdd');
        }
        
        console.log('[SERVER MEMORY] handleFileAdd END:', process.memoryUsage());
    }
}


function mergeDirectoriesBreadthFirst(depthDirectory, processedDirectory) {
    if (!depthDirectory || !processedDirectory) return depthDirectory;

    // Use a queue to simulate breadth-first traversal
    const queue = [{ depthItem: depthDirectory, processedItem: processedDirectory }];
    
    while (queue.length > 0) {
        const { depthItem, processedItem } = queue.shift();

        // Go through each folder and file at this level
        processedItem.items.forEach(processedItem => {
            const matchingItemIndex = depthItem.items.findIndex(item => item.name === processedItem.name && item.type === processedItem.type);

            if (matchingItemIndex === -1) {
                // If item doesn't exist, just add it
                depthItem.items.push(processedItem);
            } else {
                // If the item is a folder, add it to the queue for level-by-level merging
                if (processedItem.type === "folder" && depthItem.items[matchingItemIndex].type === "folder") {
                    queue.push({
                        depthItem: depthItem.items[matchingItemIndex],
                        processedItem: processedItem
                    });
                }
            }
        });
    }

    return depthDirectory;
}

function mergeDirectories(depthDirectory, processedDirectory) {
    if (!depthDirectory || !processedDirectory) return depthDirectory;

    // Loop through each item in processedDirectory and attempt to merge with depthDirectory
    processedDirectory.items.forEach(processedItem => {
        const matchingItemIndex = depthDirectory.items.findIndex(item => item.name === processedItem.name && item.type === processedItem.type);

        if (matchingItemIndex === -1) {
            // If item doesn't exist, just add it
            depthDirectory.items.push(processedItem);
        } else {
            // If the item is a folder, recursively merge the contents
            if (processedItem.type === "folder" && depthDirectory.items[matchingItemIndex].type === "folder") {
                depthDirectory.items[matchingItemIndex] = mergeDirectories(depthDirectory.items[matchingItemIndex], processedItem);
            }
        }
    });

    return depthDirectory;
}



module.exports = { handleFileAdd };
