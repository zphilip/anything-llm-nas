const { viewRedisFiles } = require("../utils/files");
const { REDIS_KEYS, redisHelper } = require("../utils/files/redis");

async function handleFileAdd(data) {
    if (data && data.action === "add") {
        const { folderName, fileName } = data;
        const filePath = `${folderName}/${fileName}`;

        // Get the file metadata from Redis
        const fileMetadata = await redisHelper.getFileMetadata(folderName, fileName);
        if (!fileMetadata) {
            console.error(`❌ File metadata not found for ${filePath}`);
            return;
        }

        redisHelper.updateDirectoryAfterFileChange(true); // Mark directory as changed

        // Get the current directory data from Redis
        let directory = await redisHelper.getDirectoryData();
        if (!directory) {
            directory = { name: "documents", type: "folder", items: [] };
            console.log("❌ Directory not found. Creating a new empty directory.");
        }

        // Fetch processed directory structure from viewRedisFiles
        const processedMetadata = await viewRedisFiles([filePath]); // This is a full directory object
        console.log(`✅ add new ${processedMetadata.items.length} files.`);
        // Use either depth-first or breadth-first merge function
        directory = mergeDirectories(directory, processedMetadata); // For depth-first
        // directory = mergeDirectoriesBreadthFirst(directory, processedMetadata); // For breadth-first

        // Save updated directory data
        await redisHelper.saveDirectoryData(directory);

        // Delete metadata from Redis after processing
        await redisHelper.redis.del(`${REDIS_KEYS.FILE_METADATA}${folderName}:${fileName}`);
        console.log(`✅ Metadata for ${fileName} deleted from Redis.`);
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
