# Migration Documentation: SMB/NAS and Enhanced Image Features

## Overview
This document records the migration of SMB/NAS file processing and enhanced image processing features from **mything-llm (v0.2.0)** to **anything-llm (v1.9.1)**.

**Migration Date:** 2024  
**Migrated Features:**
1. SMB/NAS share mounting and file processing
2. Enhanced image processing with EXIF metadata and BlurHash
3. Redis-based file caching (optional)
4. Process management for long-running operations
5. Extended file format support (RAW camera formats, CSV, JSON, TGA)

---

## Table of Contents
1. [Architecture Changes](#architecture-changes)
2. [New Dependencies](#new-dependencies)
3. [New Modules and Files](#new-modules-and-files)
4. [Modified Existing Files](#modified-existing-files)
5. [Environment Configuration](#environment-configuration)
6. [API Endpoints](#api-endpoints)
7. [Setup Instructions](#setup-instructions)
8. [Usage Examples](#usage-examples)
9. [Troubleshooting](#troubleshooting)
10. [Optional Features](#optional-features)

---

## 1. Architecture Changes

### Core Components Added
```
collector/
├── mountSmbShare/          # NEW: Main SMB mounting orchestration
│   └── index.js            # 670 lines - file processing pipeline
├── utils/
│   ├── smb/                # NEW: SMB utilities
│   │   └── index.js        # Mount management, CSV tracking
│   ├── blurhash/           # NEW: Image placeholder generation
│   │   └── index.js        # BlurHash encoding/validation
│   ├── memoryMonitor/      # NEW: Memory usage monitoring
│   │   └── index.js        # Color-coded memory logging
│   └── files/
│       └── redis.js        # NEW: Optional Redis caching
├── storage/
│   └── cache/              # NEW: Redis backup storage
│       └── README.md
└── mountpoint/             # NEW: SMB mount points
    └── README.md
```

### Process Management
- Map-based tracking for long-running operations
- Process status monitoring with 60s cleanup interval
- 5-minute process expiration
- Stop individual or all processes

### Memory Management
- Automatic garbage collection calls
- Color-coded memory thresholds:
  - **NORMAL:** < 300MB (green)
  - **WARNING:** 300-500MB (yellow)
  - **HIGH:** 500-750MB (orange)
  - **CRITICAL:** > 750MB (red)
- Explicit cleanup after batch processing

---

## 2. New Dependencies

### Added to `collector/package.json`

#### SMB/File Processing
```json
{
  "@marsaud/smb2": "^0.18.0",      // SMB2/CIFS protocol
  "csv-writer": "^1.6.0",           // CSV file writing
  "p-limit": "^6.2.0",              // Concurrency control
  "uuid": "^9.0.0"                  // Unique identifiers
}
```

#### Image Processing
```json
{
  "blurhash": "^2.0.5",             // Image placeholders
  "canvas": "^2.11.2",              // Canvas for image ops
  "exifreader": "^4.26.2",          // EXIF metadata extraction
  "exif-parser": "^0.1.12",         // Alternative EXIF parser
  "image-js": "^0.36.1",            // Image manipulation
  "pngjs": "^7.0.0",                // PNG processing
  "tga": "^1.0.8"                   // TGA format support
}
```

#### Caching (Optional)
```json
{
  "bcrypt": "^5.1.1",               // Password hashing for Redis
  "ioredis": "^5.1.0"               // Redis client
}
```

#### Video Processing (Future)
```json
{
  "fluent-ffmpeg": "^2.1.3"         // Video processing
}
```

### Version Updates
- `openai`: `^4.52.0` → `^4.73.0`
- `@lancedb/lancedb`: `^0.5.4` → `^0.14.0`

---

## 3. New Modules and Files

### 3.1 `collector/mountSmbShare/index.js`
**Purpose:** SMB share mounting and file processing orchestration

**Key Functions:**
- `mountSmbShare(shareConfig, options)` - Main entry point
- `listFilesInDirectory(smbClient, directory)` - Recursive file listing
- `copyFileFromSmbToLocal(smbClient, remotePath, localPath)` - File download
- `processSingleFile(filePath, options)` - Individual file processing
- `processBatchConcurrent(files, options)` - Concurrent batch processing
- `processFilesInBatches(files, batchSize, options)` - Batch orchestration

**Features:**
- Unicode filename support (UTF-8 with buffer fallback)
- CSV progress tracking (`mountpoints.csv`)
- Concurrency control with `p-limit`
- Process state management (running/stopped)
- Automatic cleanup and memory management

**Configuration:**
```javascript
const shareConfig = {
  host: "192.168.1.100",
  shareName: "shared",
  username: "user",
  password: "pass",
  domain: "WORKGROUP",        // Optional
  path: "/documents"          // Optional subdirectory
};

const options = {
  processId: "uuid-v4",
  batchSize: 10,              // Files per batch
  concurrency: 3,             // Concurrent downloads
  parseOnly: false,
  ocr: { langList: ["eng"] },
  chunkSource: "nas-share"
};
```

### 3.2 `collector/utils/smb/index.js`
**Purpose:** SMB mounting utilities and mount point management

**Key Functions:**
- `mountToSmbShare(shareConfig)` - Mount SMB share to local filesystem
- `unmountSmbShare(mountPoint)` - Unmount and cleanup
- `saveMountPointsToCSV(mountPoint, status, shareConfig)` - Persist mount info
- `isMountPoint(path)` - Verify mount point
- `createNewMountPoint()` - Generate UUID-based mount directory

**Mount Command:**
```bash
mount -t cifs //host/shareName mountpoint -o username=user,password=pass,iocharset=utf8
```

**CSV Tracking Format:**
```csv
UUID,MountPoint,Status,Host,ShareName,MountedAt,UnmountedAt
abc-123,/app/mountpoint/abc-123,mounted,192.168.1.100,shared,2024-01-15T10:30:00Z,
```

### 3.3 `collector/utils/blurhash/index.js`
**Purpose:** Generate BlurHash placeholders for images

**Key Functions:**
- `calculateBlurHash(imagePath, componentX=4, componentY=3)` - Generate hash
- `isValidBlurHash(blurHash)` - Validate hash format

**Implementation:**
```javascript
const sharp = require('sharp');
const { encode } = require('blurhash');

async function calculateBlurHash(imagePath, componentX = 4, componentY = 3) {
  const image = await sharp(imagePath)
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encode(
    new Uint8ClampedArray(image.data),
    image.info.width,
    image.info.height,
    componentX,
    componentY
  );
}
```

**Usage:**
```javascript
const blurHash = await calculateBlurHash('/path/to/image.jpg');
// Example output: "LGF5]+Yk^6#M@-5c,1J5@[or[Q6."
```

### 3.4 `collector/utils/memoryMonitor/index.js`
**Purpose:** Monitor and log memory usage with color-coded output

**Key Functions:**
- `logMemoryUsage(label)` - Log current memory with color coding
- `logAndCollect(label)` - Log and trigger garbage collection
- `enableDebugLogging()` - Enable detailed memory logs

**Thresholds:**
```javascript
const MEMORY_THRESHOLDS = {
  NORMAL: 300 * 1024 * 1024,    // 300 MB
  WARNING: 500 * 1024 * 1024,   // 500 MB
  HIGH: 750 * 1024 * 1024,      // 750 MB
  CRITICAL: 1000 * 1024 * 1024  // 1 GB
};
```

### 3.5 `collector/utils/files/redis.js`
**Purpose:** Optional Redis caching for file metadata

**Key Class: RedisHelper**
```javascript
class RedisHelper {
  constructor(config = {})
  async connect()
  async saveFileMetadata(fileKey, metadata)
  async getFileMetadata(fileKey)
  async saveDirectoryData(dirKey, fileList)
  async getDirectoryData(dirKey)
  async close()
}
```

**Features:**
- Graceful degradation if Redis unavailable
- Auto-persistence to JSON backup every 60s
- Connection retry strategy (50 attempts, 5s delay)
- TTL support for cached entries

**Environment:**
```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=optional
REDIS_DB=0
```

---

## 4. Modified Existing Files

### 4.1 `collector/index.js`
**Added Endpoints:**

#### POST `/mountNASShare`
Mount SMB share and process files
```javascript
// Request Body
{
  "host": "192.168.1.100",
  "shareName": "shared",
  "username": "user",
  "password": "pass",
  "domain": "WORKGROUP",      // Optional
  "path": "/documents",        // Optional
  "batchSize": 10,             // Optional, default 10
  "concurrency": 3,            // Optional, default 3
  "parseOnly": false,          // Optional
  "ocr": {
    "langList": ["eng", "chi_sim"]
  }
}

// Response
{
  "success": true,
  "message": "NAS share mounting started",
  "processId": "550e8400-e29b-41d4-a716-446655440000",
  "shareInfo": {
    "host": "192.168.1.100",
    "shareName": "shared",
    "path": "/documents"
  }
}
```

#### GET `/processStatus/:processId`
Check process status
```javascript
// Response
{
  "processId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",        // "running" | "completed" | "stopped" | "failed"
  "progress": {
    "filesProcessed": 45,
    "totalFiles": 100,
    "currentFile": "document.pdf",
    "errors": []
  },
  "startedAt": "2024-01-15T10:30:00Z",
  "lastUpdate": "2024-01-15T10:35:00Z"
}
```

#### POST `/processStopNASShare`
Stop specific process
```javascript
// Request Body
{
  "processId": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "message": "Process stopped successfully",
  "processId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### POST `/processStopAll`
Stop all running processes
```javascript
// Response
{
  "success": true,
  "message": "All processes stopped",
  "stoppedCount": 3,
  "processIds": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660e8400-e29b-41d4-a716-446655440001",
    "770e8400-e29b-41d4-a716-446655440002"
  ]
}
```

**Added Process Management:**
```javascript
// Global process tracking
const runningProcesses = new Map();

// Cleanup interval (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [processId, process] of runningProcesses.entries()) {
    if (now - process.lastUpdate > 300000) { // 5 min
      runningProcesses.delete(processId);
    }
  }
}, 60000);
```

### 4.2 `collector/utils/files/index.js`
**Added Functions:**

#### `writeToServerDocumentsWithChunks(data, filename, options)`
Stream large files in 1MB chunks to prevent memory overflow
```javascript
const CHUNK_SIZE = 1024 * 1024; // 1 MB

// Handles files larger than 10MB with streaming
if (fileSize > 10 * CHUNK_SIZE) {
  await streamFileInChunks(filePath, destPath);
}
```

#### `handleLocalFilesCache(dirPath, options)`
Integrate Redis caching for file metadata
```javascript
const redisHelper = new RedisHelper();
const cachedData = await redisHelper.getDirectoryData(dirPath);

if (cachedData && !options.forceRefresh) {
  return cachedData; // Return cached result
}

// Process and cache
const result = await processDirectory(dirPath);
await redisHelper.saveDirectoryData(dirPath, result);
```

### 4.3 `collector/utils/constants.js`
**Added Constants:**

#### API_BASE
```javascript
const API_BASE = process.env.VITE_API_BASE || "/api";
```

#### Extended MIME Types (17 new formats)
```javascript
const ACCEPTED_MIMES = {
  // ... existing types ...
  
  // CSV/JSON
  "text/csv": [".csv"],
  "application/json": [".json"],
  
  // Images
  "image/webp": [".webp"],
  "image/jpeg": [".jpeg"],
  "image/x-tga": [".tga"],
  
  // RAW Camera Formats
  "image/x-nikon-nef": [".nef"],        // Nikon
  "image/x-canon-cr2": [".cr2"],        // Canon
  "image/x-sony-arw": [".arw"],         // Sony
  "image/x-olympus-orf": [".orf"],      // Olympus
  "image/x-panasonic-rw2": [".rw2"],    // Panasonic
  "image/x-fuji-raf": [".raf"],         // Fujifilm
  "image/x-adobe-dng": [".dng"],        // Adobe DNG
  "image/x-pentax-pef": [".pef"],       // Pentax
  "image/x-samsung-srw": [".srw"],      // Samsung
};
```

#### File Converters
```javascript
const SUPPORTED_FILETYPE_CONVERTERS = {
  // ... existing converters ...
  
  ".csv": asCSV,
  ".json": asJSON,
  ".webp": asImage,
  ".jpeg": asImage,
  ".tga": asImage,
  ".nef": asImage,
  ".cr2": asImage,
  ".arw": asImage,
  ".orf": asImage,
  ".rw2": asImage,
  ".raf": asImage,
  ".dng": asImage,
  ".pef": asImage,
  ".srw": asImage,
};
```

### 4.4 `collector/processSingleFile/convert/asImage.js`
**Enhanced with EXIF and BlurHash:**

**Added Dependencies:**
```javascript
// Optional: BlurHash and EXIF support
let calculateBlurHash, ExifReader, exifParser;
try {
  const blurhashModule = require("../../utils/blurhash");
  calculateBlurHash = blurhashModule.calculateBlurHash;
} catch (e) {
  console.log('BlurHash not available - image placeholders disabled');
}

try {
  ExifReader = require('exifreader');
  exifParser = require('exif-parser');
} catch (e) {
  console.log('EXIF readers not available - metadata extraction limited');
}
```

**Added Metadata Extraction:**
```javascript
async function extractImageMetadata(fullFilePath) {
  const metadata = {
    camera: null,        // "Canon EOS 5D Mark IV"
    lens: null,          // "EF24-70mm f/2.8L II USM"
    dateTime: null,      // "2024:01:15 10:30:45"
    location: null,      // { latitude: "37.7749", longitude: "-122.4194" }
    settings: {
      iso: null,         // "400"
      fNumber: null,     // "f/2.8"
      exposureTime: null,// "1/250"
      focalLength: null  // "50mm"
    }
  };
  
  // Extract using ExifReader
  const tags = ExifReader.load(fullFilePath);
  // ... extraction logic ...
  
  return metadata;
}
```

**Enhanced Document Output:**
```javascript
const data = {
  // ... existing fields ...
  
  // Enhanced metadata
  ...(blurHash && { blurHash }),
  ...(imageMetadata.camera && { camera: imageMetadata.camera }),
  ...(imageMetadata.lens && { lens: imageMetadata.lens }),
  ...(imageMetadata.location && { location: imageMetadata.location }),
  ...(imageMetadata.settings && { cameraSettings: imageMetadata.settings }),
};
```

---

## 5. Environment Configuration

### Required Variables
```env
# Server Configuration
SERVER_PORT=8888
NODE_ENV=development

# API Configuration
VITE_API_BASE=/api

# OCR Settings (optional)
OCR_DEFAULT_LANG=eng

# Process Management
PROCESS_CLEANUP_INTERVAL=60000    # 60 seconds
PROCESS_EXPIRATION=300000         # 5 minutes
```

### Optional Variables
```env
# Redis Caching
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_ENABLE=false

# Memory Monitoring
MEMORY_DEBUG=false
GC_INTERVAL=30000                 # 30 seconds

# SMB Defaults
SMB_DEFAULT_BATCH_SIZE=10
SMB_DEFAULT_CONCURRENCY=3
SMB_MOUNT_TIMEOUT=30000           # 30 seconds
```

### Feature Flags
```env
# Enable/Disable Features
ENABLE_BLURHASH=true
ENABLE_EXIF_EXTRACTION=true
ENABLE_REDIS_CACHE=false
ENABLE_MEMORY_MONITORING=true
ENABLE_RAW_FORMATS=true
```

---

## 6. API Endpoints

### Complete Endpoint List

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/mountNASShare` | Mount SMB share and process files | No |
| GET | `/processStatus/:processId` | Get process status | No |
| POST | `/processStopNASShare` | Stop specific process | No |
| POST | `/processStopAll` | Stop all processes | No |

### Error Responses

**400 Bad Request:**
```json
{
  "success": false,
  "message": "Missing required fields: host, shareName, username"
}
```

**404 Not Found:**
```json
{
  "success": false,
  "message": "Process not found",
  "processId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "message": "Failed to mount NAS share",
  "error": "Connection timeout",
  "details": "Could not reach host 192.168.1.100"
}
```

---

## 7. Setup Instructions

### 7.1 Install Dependencies
```bash
cd /app/anything-llm/collector
npm install
```

### 7.2 Create Required Directories
```bash
mkdir -p mountpoint
mkdir -p storage/cache
```

### 7.3 Configure Environment
```bash
cp .env.example .env
# Edit .env with your settings
```

### 7.4 Install System Dependencies (Linux)
```bash
# CIFS utilities for SMB mounting
sudo apt-get update
sudo apt-get install -y cifs-utils

# Image processing libraries
sudo apt-get install -y libvips-dev

# Optional: FFmpeg for video processing
sudo apt-get install -y ffmpeg
```

### 7.5 Set Permissions
```bash
# Allow mounting without root (add user to sudoers)
sudo visudo
# Add: username ALL=(ALL) NOPASSWD: /bin/mount, /bin/umount

# Or use fstab entries for persistent mounts
```

### 7.6 Start Server
```bash
# Development
npm run dev

# Production
npm start
```

---

## 8. Usage Examples

### 8.1 Mount and Process SMB Share

**Basic Example:**
```javascript
// Mount share and process all files
const response = await fetch('http://localhost:8888/mountNASShare', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    host: '192.168.1.100',
    shareName: 'documents',
    username: 'admin',
    password: 'secret123',
    path: '/contracts/2024'
  })
});

const { processId } = await response.json();
console.log('Process started:', processId);
```

**Advanced Example with Options:**
```javascript
const response = await fetch('http://localhost:8888/mountNASShare', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    host: '192.168.1.100',
    shareName: 'photos',
    username: 'photographer',
    password: 'password',
    domain: 'STUDIO',
    path: '/2024/events',
    batchSize: 20,           // Process 20 files per batch
    concurrency: 5,          // 5 concurrent downloads
    parseOnly: false,
    ocr: {
      langList: ['eng', 'fra', 'deu']
    },
    chunkSource: 'studio-photos-2024'
  })
});
```

### 8.2 Monitor Process Progress

**Poll for Status:**
```javascript
async function monitorProcess(processId) {
  const interval = setInterval(async () => {
    const response = await fetch(
      `http://localhost:8888/processStatus/${processId}`
    );
    const status = await response.json();
    
    console.log(`Progress: ${status.progress.filesProcessed}/${status.progress.totalFiles}`);
    console.log(`Current: ${status.progress.currentFile}`);
    
    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(interval);
      console.log('Process finished:', status.status);
    }
  }, 5000); // Check every 5 seconds
}
```

### 8.3 Stop Process

**Stop Specific Process:**
```javascript
await fetch('http://localhost:8888/processStopNASShare', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    processId: '550e8400-e29b-41d4-a716-446655440000'
  })
});
```

**Stop All Processes:**
```javascript
const response = await fetch('http://localhost:8888/processStopAll', {
  method: 'POST'
});
const { stoppedCount } = await response.json();
console.log(`Stopped ${stoppedCount} processes`);
```

### 8.4 Process Images with Enhanced Metadata

**Upload Image and Extract Metadata:**
```javascript
// The asImage converter automatically extracts:
// - EXIF metadata (camera, lens, settings, GPS)
// - BlurHash placeholder
// - Date/time information

// Resulting document includes:
{
  "id": "abc-123",
  "title": "vacation_photo.jpg",
  "docAuthor": "Canon EOS R5",
  "published": "2024:01:15 14:30:00",
  "blurHash": "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
  "camera": "Canon EOS R5",
  "lens": "RF24-105mm F4 L IS USM",
  "location": {
    "latitude": "48.8584",
    "longitude": "2.2945"
  },
  "cameraSettings": {
    "iso": "200",
    "fNumber": "f/8.0",
    "exposureTime": "1/500",
    "focalLength": "35mm"
  },
  "pageContent": "OCR extracted text..."
}
```

---

## 9. Troubleshooting

### 9.1 SMB Mount Issues

**Problem: "Permission denied" when mounting**
```bash
# Solution 1: Add user to sudoers
sudo usermod -aG sudo $USER

# Solution 2: Set SUID bit on mount
sudo chmod u+s /bin/mount
sudo chmod u+s /bin/umount

# Solution 3: Use credentials file
echo "username=user" > ~/.smbcredentials
echo "password=pass" >> ~/.smbcredentials
chmod 600 ~/.smbcredentials
```

**Problem: "Connection timeout"**
```bash
# Test SMB connectivity
smbclient -L //192.168.1.100 -U username

# Check firewall
sudo ufw allow samba
sudo ufw allow 445/tcp

# Verify SMB version
mount -t cifs //host/share /mnt -o vers=3.0
```

**Problem: "Invalid argument" during mount**
```bash
# Install cifs-utils
sudo apt-get install cifs-utils

# Check kernel module
lsmod | grep cifs
sudo modprobe cifs
```

### 9.2 Memory Issues

**Problem: "Out of memory" errors**
```javascript
// Enable aggressive memory monitoring
process.env.MEMORY_DEBUG = 'true';

// Reduce batch size and concurrency
{
  "batchSize": 5,
  "concurrency": 2
}

// Force garbage collection
node --expose-gc index.js
```

### 9.3 Unicode Filename Issues

**Problem: "File not found" with non-ASCII names**
```bash
# Mount with UTF-8 charset
mount -t cifs //host/share /mnt -o iocharset=utf8,username=user

# Or use environment variable
export LANG=en_US.UTF-8
```

### 9.4 Redis Connection Issues

**Problem: Redis connection fails**
```javascript
// Redis is optional - application continues without it
// Check logs for:
"Redis not available - caching disabled"

// Test Redis connection
redis-cli ping
# Should return: PONG

// Check Redis service
sudo systemctl status redis
```

### 9.5 Image Processing Issues

**Problem: "Sharp installation failed"**
```bash
# Rebuild native dependencies
npm rebuild sharp

# Or install with specific version
npm install --platform=linux --arch=x64 sharp
```

**Problem: "EXIF extraction failed"**
```javascript
// EXIF is optional - processing continues without it
// Check logs for:
"EXIF readers not available - metadata extraction limited"

// Verify image has EXIF data
exiftool image.jpg
```

### 9.6 Process Management Issues

**Problem: Processes not cleaning up**
```javascript
// Manually clean up
await fetch('http://localhost:8888/processStopAll', {
  method: 'POST'
});

// Check running processes
const processes = Array.from(runningProcesses.entries());
console.log('Active processes:', processes.length);
```

---

## 10. Optional Features

### 10.1 Redis Caching

**Enable Redis:**
```env
REDIS_ENABLE=true
REDIS_HOST=localhost
REDIS_PORT=6379
```

**Benefits:**
- Faster re-processing of previously seen files
- Shared cache across multiple collector instances
- Persistence of file metadata

**Disable Redis:**
```env
REDIS_ENABLE=false
# Application falls back to in-memory caching
```

### 10.2 BlurHash Generation

**Enable BlurHash:**
```env
ENABLE_BLURHASH=true
```

**Benefits:**
- Smooth image loading placeholders
- Better UX for slow connections
- Compact representation (20-30 characters)

**Disable BlurHash:**
```env
ENABLE_BLURHASH=false
# Images load without placeholders
```

### 10.3 EXIF Metadata Extraction

**Enable EXIF:**
```env
ENABLE_EXIF_EXTRACTION=true
```

**Benefits:**
- Rich photo metadata (camera, lens, settings)
- GPS location data
- Original date/time information
- Professional photo management

**Disable EXIF:**
```env
ENABLE_EXIF_EXTRACTION=false
# Basic image processing only
```

### 10.4 RAW Format Support

**Enable RAW Formats:**
```env
ENABLE_RAW_FORMATS=true
```

**Supported Formats:**
- Nikon (.nef)
- Canon (.cr2)
- Sony (.arw)
- Olympus (.orf)
- Panasonic (.rw2)
- Fujifilm (.raf)
- Adobe DNG (.dng)
- Pentax (.pef)
- Samsung (.srw)
- TGA (.tga)

**Disable RAW:**
```env
ENABLE_RAW_FORMATS=false
# Only standard image formats (jpg, png, gif)
```

### 10.5 Memory Monitoring

**Enable Detailed Monitoring:**
```env
ENABLE_MEMORY_MONITORING=true
MEMORY_DEBUG=true
```

**Console Output:**
```
[MEMORY] Batch Processing Complete - 245.3 MB (NORMAL) ✓
[MEMORY] File Download - 512.7 MB (WARNING) ⚠
[MEMORY] Before Cleanup - 834.2 MB (HIGH) ⚠⚠
[MEMORY] After GC - 198.5 MB (NORMAL) ✓
```

**Disable Monitoring:**
```env
ENABLE_MEMORY_MONITORING=false
# Reduces console noise
```

---

## Migration Checklist

### Pre-Migration
- [ ] Backup existing `anything-llm` codebase
- [ ] Document current file structure
- [ ] Note any custom modifications
- [ ] Test current functionality

### Dependencies
- [ ] Install new npm packages (`npm install`)
- [ ] Install system dependencies (cifs-utils, libvips)
- [ ] Verify Node.js version (>=18.12.1)
- [ ] Optional: Install and configure Redis

### File Structure
- [ ] Create `mountpoint/` directory
- [ ] Create `storage/cache/` directory
- [ ] Add new utility modules
- [ ] Update `.gitignore`

### Configuration
- [ ] Copy `.env.example` to `.env`
- [ ] Configure SMB credentials
- [ ] Set Redis connection (if using)
- [ ] Configure memory thresholds
- [ ] Set process management timeouts

### Testing
- [ ] Test SMB mounting with sample share
- [ ] Verify file processing pipeline
- [ ] Check memory monitoring output
- [ ] Test process stop/cleanup
- [ ] Validate image metadata extraction
- [ ] Confirm BlurHash generation
- [ ] Test Redis caching (if enabled)

### Post-Migration
- [ ] Monitor memory usage in production
- [ ] Check error logs for issues
- [ ] Verify mount point cleanup
- [ ] Document any custom configurations
- [ ] Train users on new endpoints

---

## Performance Considerations

### Recommended Settings

**Small Files (<10MB):**
```javascript
{
  "batchSize": 50,
  "concurrency": 10
}
```

**Large Files (10-100MB):**
```javascript
{
  "batchSize": 20,
  "concurrency": 5
}
```

**Very Large Files (>100MB):**
```javascript
{
  "batchSize": 5,
  "concurrency": 2
}
```

### Memory Limits

**Recommended Node.js Flags:**
```bash
node --max-old-space-size=4096 --expose-gc index.js
```

**Docker Container:**
```yaml
services:
  collector:
    image: anything-llm/collector
    environment:
      NODE_OPTIONS: "--max-old-space-size=4096 --expose-gc"
    deploy:
      resources:
        limits:
          memory: 8G
        reservations:
          memory: 4G
```

---

## Security Considerations

### SMB Credentials

**Never commit credentials:**
```bash
# Use environment variables
SMB_USERNAME=admin
SMB_PASSWORD=secret

# Or credentials file
~/.smbcredentials
```

**Encrypt sensitive data:**
```javascript
const bcrypt = require('bcrypt');
const hashedPassword = await bcrypt.hash(password, 10);
```

### File Access

**Restrict mount points:**
```javascript
const ALLOWED_MOUNT_BASE = '/app/mountpoint';
const mountPoint = path.join(ALLOWED_MOUNT_BASE, uuid);

// Prevent directory traversal
if (!mountPoint.startsWith(ALLOWED_MOUNT_BASE)) {
  throw new Error('Invalid mount point');
}
```

### Process Isolation

**Limit process lifetime:**
```javascript
const PROCESS_EXPIRATION = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_PROCESSES = 10;
```

---

## Support and Contact

For issues or questions:
1. Check this documentation
2. Review error logs in `collector/logs/`
3. Check mount point status in `mountpoint/mountpoints.csv`
4. Review Redis backup in `storage/cache/redis_backup.json`

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-01 | Initial migration from mything-llm v0.2.0 |
| | | - SMB/NAS mounting and processing |
| | | - Enhanced image processing (EXIF, BlurHash) |
| | | - Redis caching support |
| | | - Process management system |
| | | - Extended file format support |

---

## License

This migration maintains the original license of anything-llm.

---

**End of Migration Documentation**
