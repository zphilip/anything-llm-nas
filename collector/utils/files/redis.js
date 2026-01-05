const fs = require('fs');
const path = require("path");

// Redis configuration - optional feature
let Redis;
let redis = null;
let redisHelper = null;

try {
  Redis = require('ioredis');
} catch (e) {
  console.log('Redis not available - caching features disabled');
}

const REDIS_KEYS = {
  DIRECTORY_DATA: 'anythingllm:directory:data',
  FILE_METADATA: 'anythingllm:file:metadata:',
  FOLDER_DATA: 'anythingllm:folder:data:',
};

const CACHE_FILE = path.join(__dirname, '../../storage/cache/localFiles.json');

/**
 * Redis Helper Class for optional caching functionality
 * Used for large-scale deployments to cache file metadata
 */
class RedisHelper {
  constructor(redisClient) {
    this.redis = redisClient;
    this.CACHE_FILE = CACHE_FILE;
    this.directoryChanged = false;
    console.log("🔗 Redis Connected");
  }

  async connect() {
    await this.loadCacheFileToRedis();
    setInterval(() => this.saveRedisDataToFile(), 60000);
  }

  async saveDirectoryData(data) {
    try {
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

  async loadCacheFileToRedis() {
    try {
      if (fs.existsSync(this.CACHE_FILE)) {
        const fileData = fs.readFileSync(this.CACHE_FILE, "utf-8");
        const directory = JSON.parse(fileData);
        await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify(directory));
        console.log("✅ Directory data loaded into Redis.");
      } else {
        console.log("⚠️ Cache file not found. Using an empty directory.");
        await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify({ 
          name: "documents", 
          type: "folder", 
          items: [] 
        }));
      }
    } catch (error) {
      console.error("❌ Error loading directory data:", error);
    }
  }

  async saveRedisDataToFile() {
    if (!this.directoryChanged) {
      return;
    }

    const directory = await this.getDirectoryData();
    if (!directory || !directory.items) {
      console.log("⚠️ Failed to retrieve directory data or items are missing.");
      return;
    }

    const cacheDir = path.dirname(this.CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    fs.writeFileSync(this.CACHE_FILE, JSON.stringify(directory, null, 2));
    console.log("💾 Directory data saved to cache file.");
    this.directoryChanged = false;
  }

  async saveFileMetadata(folderName, fileName, metadata) {
    try {
      const key = REDIS_KEYS.FILE_METADATA + `${folderName}:${fileName}`;
      const existingData = await this.redis.get(key);
      
      if (existingData) {
        console.log(`Metadata for ${folderName}:${fileName} already exists. Skipping save.`);
        return;
      }

      await this.redis.set(key, JSON.stringify(metadata));
      console.log(`Saved metadata for ${folderName}:${fileName}`);
      this.directoryChanged = true;
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

  async deleteFileMetadata(folderName, fileName) {
    try {
      const key = REDIS_KEYS.FILE_METADATA + `${folderName}:${fileName}`;
      await this.redis.del(key);
      console.log(`Deleted metadata for ${folderName}:${fileName}`);
      this.directoryChanged = true;
    } catch (error) {
      console.error(`Error deleting metadata for ${folderName}:${fileName}:`, error);
    }
  }
}

// Initialize Redis if available and configured
if (Redis && process.env.REDIS_HOST) {
  try {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    redis.on('error', (error) => {
      console.error('Redis connection error:', error);
    });

    redis.on('connect', () => {
      console.log('Connected to Redis for caching');
      redisHelper = new RedisHelper(redis);
      redisHelper.connect();
    });
  } catch (error) {
    console.error('Failed to initialize Redis:', error);
  }
}

module.exports = {
  redis,
  redisHelper,
  RedisHelper,
  REDIS_KEYS
};
