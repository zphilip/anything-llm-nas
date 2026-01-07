# Redis Integration for File Processing

## Overview

This document describes the Redis-based file processing system that enables real-time synchronization between the collector service and the server for document management.

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Collector │  ────>  │    Redis    │  ────>  │   Server    │
│   Service   │         │   Pub/Sub   │         │   Service   │
└─────────────┘         └─────────────┘         └─────────────┘
      │                       │                        │
      │ 1. Save Metadata      │ 2. Publish Event       │ 3. Process File
      ↓                       ↓                        ↓
  File Uploaded         file:metadata:updates    Update Directory
```

## Data Flow

### 1. File Upload & Processing (Collector Side)

When a file is uploaded to the collector:

```javascript
// collector/utils/files/index.js
async function handleFileUpload(file) {
  // Process the file
  const metadata = await processFile(file);
  
  // Save metadata to Redis
  await redisHelper.saveFileMetadata(folderName, fileName, metadata);
  
  // Metadata is automatically published to 'file:metadata:updates' channel
}
```

**What happens:**
- File is processed and converted to JSON
- Metadata is stored in Redis with key: `mything:file:metadata:{folderName}:{fileName}`
- Event is published to Redis channel: `file:metadata:updates`

### 2. Redis Storage Structure

**Keys Used:**
- `mything:directory:data` - Complete directory structure
- `mything:file:metadata:{folder}:{file}` - Individual file metadata
- `mything:folder:data:{folder}` - Folder-specific data

**Channels:**
- `file:metadata:updates` - Published when new files are added

### 3. Server Subscription & Processing

The server listens for file updates and processes them:

```javascript
// server/index.js
await redisHelper.connect();
await redisHelper.loadCacheFileToRedis();
await redisHelper.subscribeToUpdates("file:metadata:updates", handleFileAdd);
```

### 4. File Processing Pipeline

When a file update event is received:

```javascript
// server/jobs/redis-watched-documents.js
async function handleFileAdd(data) {
  // 1. Get file metadata from Redis
  const fileMetadata = await redisHelper.getFileMetadata(folderName, fileName);
  
  // 2. Process file using viewRedisFiles
  const processedMetadata = await viewRedisFiles([filePath]);
  
  // 3. Merge into existing directory structure
  directory = mergeDirectories(directory, processedMetadata);
  
  // 4. Save updated directory
  await redisHelper.saveDirectoryData(directory);
  
  // 5. Clean up metadata from Redis
  await redisHelper.redis.del(metadataKey);
}
```

## Key Functions

### Collector Functions

#### `saveFileMetadata(folderName, fileName, metadata)`
Saves file metadata to Redis and publishes update event.

**Location:** `collector/utils/files/redis.js`

**Parameters:**
- `folderName` - Parent folder name
- `fileName` - File name with extension
- `metadata` - File metadata object

**Publishes:**
```json
{
  "action": "add",
  "folderName": "custom-documents",
  "fileName": "document.json"
}
```

### Server Functions

#### `viewRedisFiles(filePaths)`
Processes files from Redis metadata and returns directory structure.

**Location:** `server/utils/files/index.js`

**Parameters:**
- `filePaths` - Array of file paths (e.g., `["custom-documents/file.json"]`)

**Returns:**
```javascript
{
  name: "documents",
  type: "folder",
  items: [
    {
      name: "custom-documents",
      type: "folder",
      items: [...]
    }
  ]
}
```

#### `processSingleFile(folderPath, folderName, fileName, liveSyncAvailable)`
Processes a single file asynchronously.

**Location:** `server/utils/files/index.js`

**Features:**
- Reads file from disk
- Parses JSON metadata
- Checks vector cache status
- Adds watch capability info

#### `processBatch(batch, filenames, subdocs)`
Processes files in batches with workspace and watch information.

**Location:** `server/utils/files/index.js`

**Features:**
- Batch fetches pinned workspaces
- Batch fetches watched documents
- Updates subdirectory structure

## Configuration

### Environment Variables

```bash
# .env or docker/.env
REDIS_HOST=redis        # Redis container name or IP
REDIS_PORT=6379         # Redis port
```

### Redis Connection Settings

Both collector and server use these settings:

```javascript
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});
```

## Cache File Synchronization

### Loading Cache on Startup

When the server starts:

```javascript
async loadCacheFileToRedis() {
  if (fs.existsSync(this.CACHE_FILE)) {
    const fileData = fs.readFileSync(this.CACHE_FILE, "utf-8");
    const directory = JSON.parse(fileData);
    await this.redis.set(REDIS_KEYS.DIRECTORY_DATA, JSON.stringify(directory));
  }
}
```

### Auto-Save to File

Redis data is automatically saved to disk every 60 seconds:

```javascript
// In connect() method
setInterval(() => this.saveRedisDataToFile(), 60000);
```

**Cache File Location:** `server/storage/cache/localFiles.json`

## Error Handling

### Collector Error Handling

```javascript
try {
  await redisHelper.saveFileMetadata(folderName, fileName, data);
} catch (error) {
  console.error('Error handling cache:', error);
  // Falls back to normal operation without Redis
}
```

### Server Error Handling

```javascript
// Optional Redis support
let redisHelper = null;
try {
  const { redisHelper: helper } = require("./utils/files/redis");
  redisHelper = helper;
} catch (e) {
  console.log("⚠️ Redis support disabled:", e.message);
}
```

## Performance Optimizations

### Batch Processing

Files are processed in batches of 100 (configurable via `BATCH_SIZE`):

```javascript
const BATCH_SIZE = 100;

for (let i = 0; i < fileNames.length; i += BATCH_SIZE) {
  const batch = fileNames.slice(i, i + BATCH_SIZE);
  // Process batch...
}
```

### Parallel Operations

- File reads use `Promise.all()` for parallel execution
- Database queries are batched for workspace/watch info

### Change Detection

Only modified data is saved to disk:

```javascript
if (!this.directoryChanged) {
  console.log("No changes detected, skipping save.");
  return;
}
```

## Monitoring & Debugging

### Connection Events

```javascript
redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});
```

### Subscription Confirmation

```javascript
await this.subscriber.subscribe(channel);
console.log(`📡 Subscribed to Redis channel: ${channel}`);
```

### Event Logging

```javascript
console.log(`🔔 Message received on channel '${receivedChannel}':`, data);
console.log(`📡 Published metadata update for ${folderName}/${fileName}`);
```

## Troubleshooting

### Redis Connection Failed

**Symptoms:** Server logs show Redis connection errors

**Solutions:**
1. Check if Redis container is running: `docker ps | grep redis`
2. Verify Redis host/port in `.env` file
3. Check network connectivity between containers

### Files Not Appearing in UI

**Symptoms:** Files uploaded but not visible in document picker

**Debugging Steps:**
1. Check Redis for metadata: 
   ```bash
   docker exec -it redis redis-cli
   KEYS mything:file:metadata:*
   ```
2. Verify subscription is active in server logs
3. Check `handleFileAdd` is being triggered
4. Verify cache file is being updated

### Duplicate Files

**Symptoms:** Same file appears multiple times

**Solution:** Redis checks for existing metadata before saving:
```javascript
const existingData = await this.redis.get(key);
if (existingData) {
  console.log(`Metadata already exists. Skipping save.`);
  return;
}
```

## Best Practices

1. **Always use try-catch** around Redis operations
2. **Implement retry logic** for failed operations
3. **Clean up metadata** after processing to avoid memory leaks
4. **Monitor Redis memory usage** in production
5. **Use batch operations** for multiple file updates
6. **Set appropriate TTLs** for temporary data

## Testing

### Manual Testing

1. Upload a file via the collector
2. Check Redis for metadata:
   ```bash
   redis-cli GET "mything:file:metadata:custom-documents:test.json"
   ```
3. Verify server processes the file
4. Check if file appears in UI

### Integration Testing

```javascript
// Test file upload flow
const metadata = { /* file data */ };
await redisHelper.saveFileMetadata("test-folder", "test.json", metadata);

// Verify event was published
// Verify server processed the file
// Verify directory was updated
```

## Migration Notes

When upgrading from non-Redis to Redis-based system:

1. Existing files in `server/storage/documents/` are loaded on startup
2. New files use Redis flow automatically
3. Both old and new files work together seamlessly
4. No manual migration required

## Future Enhancements

- [ ] Add Redis cluster support for high availability
- [ ] Implement Redis Streams for more reliable message delivery
- [ ] Add metrics collection for monitoring
- [ ] Implement file update/deletion events
- [ ] Add support for bulk file operations
- [ ] Implement Redis-based file locking for concurrent access

## Related Files

- **Collector Redis Helper:** `collector/utils/files/redis.js`
- **Server Redis Helper:** `server/utils/files/redis.js`
- **File Processing:** `server/utils/files/index.js`
- **Event Handler:** `server/jobs/redis-watched-documents.js`
- **Server Init:** `server/index.js`
- **Environment Config:** `docker/.env`

## Support

For issues or questions:
1. Check server logs for Redis connection/subscription status
2. Verify Redis container is running and accessible
3. Review this documentation for configuration details
4. Check GitHub issues for similar problems
