const Redis = require('ioredis');
const fs = require('fs');
const path = require("path");
// Redis 键常量
const REDIS_KEYS = {
  DIRECTORY_DATA: 'mything:directory:data',
  FILE_METADATA: 'mything:file:metadata:',
  FOLDER_DATA: 'mything:folder:data:',
};
const CACHE_FILE = path.join(__dirname, '../../storage/cache/localFiles.json');

// Redis 客户端实例
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000); // Backoff strategy with a max delay of 2 seconds
    return delay;
  }
});

// Redis 连接事件处理
redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});


// Redis 辅助类
class RedisHelper {
  constructor(redisClient) {
    this.redis = redisClient;
    this.subscriber = new Redis({ 
      host: process.env.REDIS_HOST || 'localhost', 
      port: process.env.REDIS_PORT || 6379 
    });
    this.publisher = new Redis({ 
      host: process.env.REDIS_HOST || 'localhost', 
      port: process.env.REDIS_PORT || 6379 
    });
    this.CACHE_FILE = CACHE_FILE;
    this.directoryChanged = false; // Flag to track changes
    this.subscribedChannels = new Map();
    console.log("🔗 Redis Connected");
  }

  async connect() {
    // Load cache file into Redis
    await this.loadCacheFileToRedis();
    // Subscribe to updates
    // await this.subscribeToUpdates();
    // Auto-save Redis data to file every 60 seconds
    setInterval(() => this.saveRedisDataToFile(), 60000);
  }
    
  // 目录数据操作
  async saveDirectoryData(data) {
    try {
      // Check if directory data already exists
      const existingData = await this.redis.get(REDIS_KEYS.DIRECTORY_DATA);
      if (existingData) {
        console.log('Directory data already exists.');
      }
      
      await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify(data));
      console.log('Saved directory data');
    } catch (error) {
      console.error('Error saving directory data to Redis:', error);
    }
  }

  async getDirectoryData() {
    try {
      const data = await this.redis.get(REDIS_KEYS.DIRECTORY_DATA);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error retrieving directory data from Redis:', error);
      return null;
    }
  }

  /**
 * Load the cache file into Redis on startup
 */
  async loadCacheFileToRedis() {
    try {
      if (fs.existsSync(this.CACHE_FILE)) {
        const fileData = fs.readFileSync(this.CACHE_FILE, "utf-8");
        const directory = JSON.parse(fileData);

        await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify(directory));
        console.log("✅ Directory data loaded into Redis.");
      } else {
        console.log("⚠️ Cache file not found. Using an empty directory.");
        await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify({ name: "documents", type: "folder", items: [] }));
      }
    } catch (error) {
      console.error("❌ Error loading directory data:", error);
    }
  }

  async subscribeToUpdates(channel, ...callbacks) {
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.set(channel, []);
    }
  
    // Store the callbacks for this channel
    this.subscribedChannels.get(channel).push(...callbacks);
  
    // Prevent duplicate subscription
    if (this.subscribedChannels.get(channel).length === callbacks.length) {
      this.subscriber.on("message", async (receivedChannel, message) => {
        if (this.subscribedChannels.has(receivedChannel)) {
          const data = JSON.parse(message);
          console.log(`🔔 Message received on channel '${receivedChannel}':`, data);
  
          // Execute all registered callbacks for this channel
          for (const callback of this.subscribedChannels.get(receivedChannel)) {
            try {
              await callback(data);
            } catch (error) {
              console.error(`❌ Error executing callback for channel '${receivedChannel}':`, error);
            }
          }
        }
      });
  
      await this.subscriber.subscribe(channel);
      console.log(`📡 Subscribed to Redis channel: ${channel}`);
    }
  }
  
  /**
   * Persist Redis data to the cache file
   */
  async saveRedisDataToFile() {
    if (!this.directoryChanged) {
        console.log("No changes detected in directory, skipping save.");
        return; // Skip if no changes were made
    }

    const directory = await this.getDirectoryData();
    if (!directory || !directory.items) {
        console.log("⚠️ Failed to retrieve directory data or items are missing.");
        return;
    }

    const itemCountBefore = directory.items.length;
    console.log(`📂 Directory contains ${itemCountBefore} items before saving.`);

    fs.writeFileSync(this.CACHE_FILE, JSON.stringify(directory, null, 2));
    console.log("💾 Directory data saved to cache file.");

    // Reload the data to verify saving success
    const savedData = JSON.parse(fs.readFileSync(this.CACHE_FILE, "utf-8"));
    const itemCountAfter = savedData.items?.length ?? 0;
    console.log(`✅ Cache file now contains ${itemCountAfter} items after saving.`);

    // Reset the change flag after saving
    this.directoryChanged = false;
}


  // 文件元数据操作
  async saveFileMetadata(folderName, fileName, metadata) {
    try {
      const key = REDIS_KEYS.FILE_METADATA + `${folderName}:${fileName}`;

      // Check if the metadata already exists for this file
      const existingData = await this.redis.get(key);
      if (existingData) {
        console.log(`Metadata for ${folderName}:${fileName} already exists. Skipping save.`);
        return; // Skip saving if data already exists
      }

      // Save the metadata if it doesn't exist
      await this.redis.set(key, JSON.stringify(metadata));
      console.log(`Saved metadata for ${folderName}:${fileName}`);

      // Publish event to notify other services
      // await pub.publish("file:metadata:updates", JSON.stringify({ folderName, fileName, metadata }));
      await this.publisher.publish("file:metadata:updates", JSON.stringify({
        action: "add",
        folderName: folderName,
        fileName: fileName
      }));      
      console.log(`📡 Published metadata update for ${folderName}/${fileName}`);
      
    } catch (error) {
      console.error(`Error saving metadata for ${folderName}:${fileName} to Redis:`, error);
    }
  }

  async getFileMetadata(folderName, fileName) {
    try {
      const key = REDIS_KEYS.FILE_METADATA + `${folderName}:${fileName}`;
      const data = await this.redis.get(key);
      if (!data) {
        console.warn(`⚠️ No metadata found for ${folderName}/${fileName}`);
      }      
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Error retrieving metadata for ${folderName}:${fileName} from Redis:`, error);
      return null;
    }
  }

  // 文件夹数据操作
  async saveFolderData(folderName, data) {
    try {
      const key = REDIS_KEYS.FOLDER_DATA + folderName;

      // Check if the folder data already exists
      const existingData = await this.redis.get(key);
      if (existingData) {
        console.log(`Folder data for ${folderName} already exists. Skipping save.`);
        return; // Skip saving if data already exists
      }

      // Save the folder data if it doesn't exist
      await this.redis.set(key, JSON.stringify(data));
      console.log(`Saved folder data for ${folderName}`);
    } catch (error) {
      console.error(`Error saving folder data for ${folderName} to Redis:`, error);
    }
  }

  async getFolderData(folderName) {
    try {
      const key = REDIS_KEYS.FOLDER_DATA + folderName;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Error retrieving folder data for ${folderName} from Redis:`, error);
      return null;
    }
  }

  // Similarly, update other methods that modify the directory or file data to set the change flag
  async updateDirectoryAfterFileChange() {
    // If there are changes to the directory, mark it
    this.directoryChanged = true;
  }  

  // 健康检查
  async checkHealth() {
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      console.error('Redis health check failed:', error);
      return false;
    }
  }

  // 缓存清理
  async clearCache() {
    try {
      const keys = await this.redis.keys('mything:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
        console.log(`Cleared ${keys.length} Redis cache entries`);
      }
    } catch (error) {
      console.error('Error clearing Redis cache:', error);
    }
  }

  // 设置过期时间
  async setExpiry(key, seconds) {
    try {
      await this.redis.expire(key, seconds);
    } catch (error) {
      console.error(`Error setting expiry for key ${key}:`, error);
    }
  }

  // 批量操作
  async batchSave(items = []) { // Default value to prevent errors if items are empty
    if (items.length === 0) {
      console.warn('No items provided for batch save');
      return;
    }

    const pipeline = this.redis.pipeline();
    
    items.forEach(({ key, value }) => {
      pipeline.set(key, JSON.stringify(value));
    });

    try {
      await pipeline.exec();
      console.log('Batch save completed successfully');
    } catch (error) {
      console.error('Batch save error:', error);
    }
  }

  // 关闭连接
  async close() {
    try {
      await this.redis.quit();
      console.log('Redis connection closed');
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
  }
}

// 创建并导出 RedisHelper 实例
const redisHelper = new RedisHelper(redis);

// Handle process termination (e.g., Ctrl+C)
process.on('SIGINT', async () => {
  console.log('Closing Redis connection...');
  await redisHelper.close();  // Close Redis connection properly
  process.exit();  // Exit the process
});

module.exports = {
  redis,
  redisHelper,
  RedisHelper, // Add this line
  REDIS_KEYS
};
