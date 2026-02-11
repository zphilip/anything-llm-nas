const fs = require("fs");
const path = require("path");
const { v5: uuidv5 } = require("uuid");
const { Document } = require("../../models/documents");
const { DocumentSyncQueue } = require("../../models/documentSyncQueue");
const documentsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../storage/documents`)
    : path.resolve(process.env.STORAGE_DIR, `documents`);
const directUploadsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../storage/direct-uploads`)
    : path.resolve(process.env.STORAGE_DIR, `direct-uploads`);
const vectorCachePath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../storage/vector-cache`)
    : path.resolve(process.env.STORAGE_DIR, `vector-cache`);
const hotdirPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../../collector/hotdir`)
    : path.resolve(process.env.STORAGE_DIR, `../../collector/hotdir`);

// Cache file for storing directory structure
// Use STORAGE_DIR when provided, otherwise fall back to relative ./storage
const storageBasePath = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(__dirname, '../../storage');
const CACHE_FILE = path.join(storageBasePath, 'cache', 'localFiles.json');
// Per-folder cache directory (stores small metadata-only caches)
const FOLDER_CACHE_DIR = path.join(storageBasePath, 'cache', 'folders');

// Batch size for processing files
const BATCH_SIZE = 100;

// Should take in a folder that is a subfolder of documents
// eg: youtube-subject/video-123.json
async function fileData(filePath = null) {
  if (!filePath) throw new Error("No docPath provided in request");
  const fullFilePath = path.resolve(documentsPath, normalizePath(filePath));
  if (!fs.existsSync(fullFilePath) || !isWithin(documentsPath, fullFilePath))
    return null;

  const data = fs.readFileSync(fullFilePath, "utf8");
  return JSON.parse(data);
}

async function viewLocalFiles(rescan = false) {
// Threshold (ms) for logging detailed per-file timings. Set via RESYNC_SLOW_MS env.
const RESYNC_SLOW_MS = parseInt(process.env.RESYNC_SLOW_MS || "2000");

  try {
    console.log('[SERVER MEMORY] viewLocalFiles START:', process.memoryUsage());
    // Create cache directory if it doesn't exist
    const overallStart = process.hrtime();
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // // Try to read from cache if rescan is false
    // if (!rescan && fs.existsSync(CACHE_FILE)) {
    //   try {
    //     console.log('[SERVER MEMORY] Before reading cache file:', process.memoryUsage());
    //     const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    //     console.log('[SERVER MEMORY] After reading cache file:', process.memoryUsage());
    //     console.log('✅ Loaded directory structure from cache');
    //     return cachedData;
    //   } catch (error) {
    //     console.warn('⚠️ Error reading cache file, rescanning:', error.message);
    //   }
    // }

    // New: Assemble directory from per-folder Redis keys to avoid loading full tree
    if (!rescan) {
      try {
        const { redisHelper } = require("./redis");
        // If documentsPath doesn't exist yet, create it and return empty directory
        if (!fs.existsSync(documentsPath)) fs.mkdirSync(documentsPath, { recursive: true });

        const directory = {
          name: "documents",
          type: "folder",
          items: [],
        };

        for (const file of fs.readdirSync(documentsPath)) {
          const folderPath = path.resolve(documentsPath, file);
          if (!fs.lstatSync(folderPath).isDirectory()) continue;
          // Try to get per-folder data from Redis
          const tRedisStart = process.hrtime();
          let subdocs = await redisHelper.getFolderData(file);
          const tRedis = process.hrtime(tRedisStart);
          console.log(`[RESYNC] getFolderData '${file}' took ${tRedis[0]}s ${Math.round(tRedis[1]/1e6)}ms - ${subdocs ? 'HIT' : 'MISS'}`);
          
          if (subdocs) {
            // Redis HIT - sync to disk cache to keep them in sync
            const itemCount = subdocs.items?.length || 0;
            console.log(`[CACHE SYNC] Redis has ${itemCount} items for '${file}'`);
            try {
              saveFolderCache(file, subdocs);
              console.log(`[CACHE SYNC] Synced Redis data (${itemCount} items) for '${file}' to disk cache`);
            } catch (err) {
              console.warn(`[CACHE SYNC] Failed to sync '${file}' to disk:`, err.message);
            }
          }
          if (!subdocs) {
            // Fallback: scan the folder and build its data (only for this folder)
            const folderScanStart = process.hrtime();
            subdocs = { name: file, type: 'folder', items: [] };
            const subfiles = fs.readdirSync(folderPath);
            const filenames = {};
            const liveSyncAvailableForFolder = await DocumentSyncQueue.enabled();
            const smallTaskFns = [];
            const largeTaskFns = [];
            for (let i = 0; i < subfiles.length; i++) {
              const subfile = subfiles[i];
              const cachefilename = `${file}/${subfile}`;
              if (path.extname(subfile) !== ".json") continue;
              const fullPath = path.join(folderPath, subfile);
              let stat = null;
              try { stat = fs.statSync(fullPath); } catch (e) {}
              const isLarge = stat && stat.size >= FILE_READ_SIZE_THRESHOLD;
              const task = () => fileToPickerData({
                pathToFile: fullPath,
                liveSyncAvailable: liveSyncAvailableForFolder,
                cachefilename,
              });
              if (isLarge) largeTaskFns.push(task); else smallTaskFns.push(task);
              filenames[cachefilename] = subfile;
            }
            const pStart = process.hrtime();
            let lastSeen = 0;
            const runProgress = (completed, total) => {
              const delta = completed - lastSeen;
              lastSeen = completed;
              if (completed % 50 === 0 || completed === total) {
                console.log(`${new Date().toISOString()} [RESYNC] folder '${file}' progress ${completed}/${total}`);
              }
            };

            // Run small tasks in parallel, then large tasks sequentially to reduce IO contention
            const smallResults = (smallTaskFns.length > 0)
              ? (await runWithConcurrency(smallTaskFns, RESYNC_CONCURRENCY, runProgress))
              : [];
            const largeResults = (largeTaskFns.length > 0)
              ? (await runWithConcurrency(largeTaskFns, RESYNC_LARGE_CONCURRENCY, runProgress))
              : [];

            const results = [...smallResults, ...largeResults]
              .filter((i) => !!i)
              .filter((i) => hasRequiredMetadata(i));
            const pElapsed = process.hrtime(pStart);
            const folderScanElapsed = process.hrtime(folderScanStart);
            console.log(`[RESYNC] scanned folder '${file}' files=${subfiles.length} processed=${results.length} scan ${folderScanElapsed[0]}s ${Math.round(folderScanElapsed[1]/1e6)}ms (processing ${Math.round(pElapsed[1]/1e6)}ms)`);
            subdocs.items.push(...results);

            // Attach pinned and watched info
            const pinnedWorkspacesByDocument = await getPinnedWorkspacesByDocument(filenames);
            const watchedDocumentsFilenames = await getWatchedDocumentFilenames(filenames);
            for (const item of subdocs.items) {
              item.pinnedWorkspaces = pinnedWorkspacesByDocument[item.name] || [];
              item.watched = watchedDocumentsFilenames.hasOwnProperty(item.name) || false;
            }

            // Save per-folder data to Redis and disk (keep in sync)
            try {
              const tSaveStart = process.hrtime();
              await redisHelper.saveFolderData(file, subdocs);
              const tSave = process.hrtime(tSaveStart);
              console.log(`[RESYNC] saveFolderData '${file}' took ${tSave[0]}s ${Math.round(tSave[1]/1e6)}ms`);
            } catch (err) {
              console.warn('Failed to save folder data to Redis for', file, err && err.message ? err.message : err);
            }
            try {
              saveFolderCache(file, subdocs);
              console.log(`[CACHE SYNC] Synced '${file}' to disk cache`);
            } catch (err) {
              // best-effort sync
            }
          } else {
            // If we got folder data from Redis, ensure pinned/watched info is current
            const filenames = {};
            for (const item of subdocs.items) {
              filenames[`${file}/${item.name}`] = item.name;
            }
            const tPinnedStart = process.hrtime();
            const pinnedWorkspacesByDocument = await getPinnedWorkspacesByDocument(filenames);
            const tPinned = process.hrtime(tPinnedStart);
            const tWatchedStart = process.hrtime();
            const watchedDocumentsFilenames = await getWatchedDocumentFilenames(filenames);
            const tWatched = process.hrtime(tWatchedStart);
            console.log(`[RESYNC] folder '${file}' pinnedQuery ${tPinned[0]}s ${Math.round(tPinned[1]/1e6)}ms watchedQuery ${tWatched[0]}s ${Math.round(tWatched[1]/1e6)}ms`);
            for (const item of subdocs.items) {
              item.pinnedWorkspaces = pinnedWorkspacesByDocument[item.name] || [];
              item.watched = watchedDocumentsFilenames.hasOwnProperty(item.name) || false;
            }
          }

          directory.items.push(subdocs);
        }

        // Make sure custom-documents is always the first folder in picker
        directory.items = [
          directory.items.find((folder) => folder.name === "custom-documents"),
          ...directory.items.filter((folder) => folder.name !== "custom-documents"),
        ].filter((i) => !!i);

        console.log('✅ Loaded directory structure from per-folder Redis keys');
        return directory;
      } catch (error) {
        console.warn('⚠️ Error assembling directory from per-folder Redis, rescanning:', error.message);
      }
    }
    
    if (!fs.existsSync(documentsPath)) fs.mkdirSync(documentsPath);
    console.log('[SERVER MEMORY] Before directory scan:', process.memoryUsage());
    const liveSyncAvailable = await DocumentSyncQueue.enabled();
    const directory = {
      name: "documents",
      type: "folder",
      items: [],
    };
    // First pass: enumerate folders and count total files to process
    const folders = fs.readdirSync(documentsPath).filter((f) => {
      if (path.extname(f) === ".md") return false;
      const folderPath = path.resolve(documentsPath, f);
      return fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory();
    });

    const perFolderFiles = {};
    let totalFiles = 0;
    for (const folderName of folders) {
      const folderPath = path.resolve(documentsPath, folderName);
      try {
        const subfiles = fs.readdirSync(folderPath).filter((sf) => path.extname(sf) === ".json");
        perFolderFiles[folderName] = subfiles;
        totalFiles += subfiles.length;
      } catch (err) {
        perFolderFiles[folderName] = [];
      }
    }

    console.log(`[RESYNC] Starting full directory scan: folders=${folders.length} totalFiles=${totalFiles}`);

    // Global progress counter across folders
    let globalCompleted = 0;

    for (const file of folders) {
      const folderPath = path.resolve(documentsPath, file);
      const subdocs = {
        name: file,
        type: "folder",
        items: [],
      };

      const subfiles = perFolderFiles[file] || [];
      const filenames = {};

      if (subfiles.length === 0) {
        directory.items.push(subdocs);
        continue;
      }

      // Build tasks for this folder, split by file size to avoid IO contention
      const smallTaskFns = [];
      const largeTaskFns = [];
      for (const subfile of subfiles) {
        const fullPath = path.join(folderPath, subfile);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch (e) {}
        const isLarge = stat && stat.size >= FILE_READ_SIZE_THRESHOLD;
        const task = () => processSingleFile(folderPath, file, subfile, liveSyncAvailable);
        if (isLarge) largeTaskFns.push(task); else smallTaskFns.push(task);
      }

      let lastSeen = 0;
      const progressCb = (completed, total) => {
        const delta = completed - lastSeen;
        lastSeen = completed;
        globalCompleted += delta;
        if (globalCompleted % 50 === 0 || globalCompleted === totalFiles) {
          console.log(`${new Date().toISOString()} [RESYNC] progress ${globalCompleted}/${totalFiles}`);
        }
      };

      const smallResults = (smallTaskFns.length > 0) ? (await runWithConcurrency(smallTaskFns, RESYNC_CONCURRENCY, progressCb)) : [];
      const largeResults = (largeTaskFns.length > 0) ? (await runWithConcurrency(largeTaskFns, RESYNC_LARGE_CONCURRENCY, progressCb)) : [];

      const processed = [...smallResults, ...largeResults].filter(Boolean).filter(i => hasRequiredMetadata(i));

      processed.forEach(item => {
        filenames[`${file}/${item.name}`] = item.name;
      });

      await processBatch(processed, filenames, subdocs);

      // Persist per-folder cache to disk for faster startup next time
      try { saveFolderCache(file, subdocs); } catch (err) {}

      if (subdocs.items.length > 0) directory.items.push(subdocs);
    }

  // Make sure custom-documents is always the first folder in picker
  directory.items = [
    directory.items.find((folder) => folder.name === "custom-documents"),
    ...directory.items.filter((folder) => folder.name !== "custom-documents"),
  ].filter((i) => !!i);

  // // Save to cache file
  // try {
  //   console.log('[SERVER MEMORY] Before writing cache file:', process.memoryUsage());
  //   fs.writeFileSync(CACHE_FILE, JSON.stringify(directory, null, 2), 'utf8');
  //   console.log('[SERVER MEMORY] After writing cache file:', process.memoryUsage());
  //   console.log('💾 Directory structure saved to cache');
  // } catch (error) {
  //   console.error('❌ Error saving cache file:', error.message);
  // }

  // Legacy full-directory save is disabled; per-folder data is used instead.
  console.log('[SERVER MEMORY] viewLocalFiles END:', process.memoryUsage());

  return directory;
  } catch (error) {
    console.error("❌ Error in viewLocalFiles:", error);
    throw error;
  }
}

/**
 * Gets the documents by folder name.
 * @param {string} folderName - The name of the folder to get the documents from.
 * @returns {Promise<{folder: string, documents: any[], code: number, error: string}>} - The documents by folder name.
 */
async function getDocumentsByFolder(folderName = "") {
  if (!folderName) {
    return {
      folder: folderName,
      documents: [],
      code: 400,
      error: "Folder name must be provided.",
    };
  }

  const folderPath = path.resolve(documentsPath, normalizePath(folderName));
  if (
    !isWithin(documentsPath, folderPath) ||
    !fs.existsSync(folderPath) ||
    !fs.lstatSync(folderPath).isDirectory()
  ) {
    return {
      folder: folderName,
      documents: [],
      code: 404,
      error: `Folder "${folderName}" does not exist.`,
    };
  }

  const documents = [];
  const filenames = {};
  const files = fs.readdirSync(folderPath);
  for (const file of files) {
    if (path.extname(file) !== ".json") continue;
    const filePath = path.join(folderPath, file);
    const rawData = fs.readFileSync(filePath, "utf8");
    const cachefilename = `${folderName}/${file}`;
    const { pageContent, ...metadata } = JSON.parse(rawData);
    documents.push({
      name: file,
      type: "file",
      ...metadata,
      cached: await cachedVectorInformation(cachefilename, true),
    });
    filenames[cachefilename] = file;
  }

  // Get pinned and watched information for each document in the folder
  const pinnedWorkspacesByDocument =
    await getPinnedWorkspacesByDocument(filenames);
  const watchedDocumentsFilenames =
    await getWatchedDocumentFilenames(filenames);
  for (let doc of documents) {
    doc.pinnedWorkspaces = pinnedWorkspacesByDocument[doc.name] || [];
    doc.watched = Object.prototype.hasOwnProperty.call(
      watchedDocumentsFilenames,
      doc.name
    );
  }

  return { folder: folderName, documents, code: 200, error: null };
}

/**
 * Searches the vector-cache folder for existing information so we dont have to re-embed a
 * document and can instead push directly to vector db.
 * @param {string} filename - the filename to check for cached vector information
 * @param {boolean} checkOnly - if true, only check if the file exists, do not return the cached data
 * @returns {Promise<{exists: boolean, chunks: any[]}>} - a promise that resolves to an object containing the existence of the file and its cached chunks
 */
async function cachedVectorInformation(filename = null, checkOnly = false) {
  if (!filename) return checkOnly ? false : { exists: false, chunks: [] };

  const digest = uuidv5(filename, uuidv5.URL);
  const file = path.resolve(vectorCachePath, `${digest}.json`);
  const exists = fs.existsSync(file);

  if (checkOnly) return exists;
  if (!exists) return { exists, chunks: [] };

  console.log(
    `Cached vectorized results of ${filename} found! Using cached data to save on embed costs.`
  );
  const rawData = fs.readFileSync(file, "utf8");
  return { exists: true, chunks: JSON.parse(rawData) };
}

// vectorData: pre-chunked vectorized data for a given file that includes the proper metadata and chunk-size limit so it can be iterated and dumped into Pinecone, etc
// filename is the fullpath to the doc so we can compare by filename to find cached matches.
async function storeVectorResult(vectorData = [], filename = null) {
  if (!filename) return;
  console.log(
    `Caching vectorized results of ${filename} to prevent duplicated embedding.`
  );
  if (!fs.existsSync(vectorCachePath)) fs.mkdirSync(vectorCachePath);

  const digest = uuidv5(filename, uuidv5.URL);
  const writeTo = path.resolve(vectorCachePath, `${digest}.json`);
  fs.writeFileSync(writeTo, JSON.stringify(vectorData), "utf8");
  return;
}

// Purges a file from the documents/ folder.
async function purgeSourceDocument(filename = null) {
  if (!filename) return;
  const filePath = path.resolve(documentsPath, normalizePath(filename));

  if (
    !fs.existsSync(filePath) ||
    !isWithin(documentsPath, filePath) ||
    !fs.lstatSync(filePath).isFile()
  )
    return;

  console.log(`Purging source document of ${filename}.`);
  fs.rmSync(filePath);

  // Also remove metadata and folder index from Redis if available
  try {
    const { redisHelper, REDIS_KEYS, redis } = require("./redis");
    const folderName = path.dirname(filename);
    const fileName = path.basename(filename);
    // Remove per-file metadata key
    try {
      await redis.del(REDIS_KEYS.FILE_METADATA + `${folderName}:${fileName}`);
    } catch (e) {
      // If redis.del isn't available or fails, try using helper methods
      try {
        if (redisHelper && typeof redisHelper.removeFileFromFolder === 'function') {
          await redisHelper.removeFileFromFolder(folderName, fileName);
        }
      } catch (err) {}
    }

    // Ensure folder index is updated
    try {
      if (redisHelper && typeof redisHelper.removeFileFromFolder === 'function') {
        await redisHelper.removeFileFromFolder(folderName, fileName);
      }
    } catch (err) {
      console.warn('Failed to update Redis folder index during purge:', err.message || err);
    }
  } catch (err) {
    // Redis not available or other error - ignore
  }
  return;
}

// Purges a vector-cache file from the vector-cache/ folder.
async function purgeVectorCache(filename = null) {
  if (!filename) return;
  const digest = uuidv5(filename, uuidv5.URL);
  const filePath = path.resolve(vectorCachePath, `${digest}.json`);

  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) return;
  console.log(`Purging vector-cache of ${filename}.`);
  fs.rmSync(filePath);
  return;
}

// Search for a specific document by its unique name in the entire `documents`
// folder via iteration of all folders and checking if the expected file exists.
async function findDocumentInDocuments(documentName = null) {
  if (!documentName) return null;
  for (const folder of fs.readdirSync(documentsPath)) {
    const isFolder = fs
      .lstatSync(path.join(documentsPath, folder))
      .isDirectory();
    if (!isFolder) continue;

    const targetFilename = normalizePath(documentName);
    const targetFileLocation = path.join(documentsPath, folder, targetFilename);

    if (
      !fs.existsSync(targetFileLocation) ||
      !isWithin(documentsPath, targetFileLocation)
    )
      continue;

    const fileData = fs.readFileSync(targetFileLocation, "utf8");
    const cachefilename = `${folder}/${targetFilename}`;
    const { pageContent, ...metadata } = JSON.parse(fileData);
    return {
      name: targetFilename,
      type: "file",
      ...metadata,
      cached: await cachedVectorInformation(cachefilename, true),
    };
  }

  return null;
}

/**
 * Checks if a given path is within another path.
 * @param {string} outer - The outer path (should be resolved).
 * @param {string} inner - The inner path (should be resolved).
 * @returns {boolean} - Returns true if the inner path is within the outer path, false otherwise.
 */
function isWithin(outer, inner) {
  if (outer === inner) return false;
  const rel = path.relative(outer, inner);
  return !rel.startsWith("../") && rel !== "..";
}

function normalizePath(filepath = "") {
  const result = path
    .normalize(filepath.trim())
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .trim();
  if (["..", ".", "/"].includes(result)) throw new Error("Invalid path.");
  return result;
}

// Ensure folder cache dir exists and provide helpers to save/load per-folder caches.
function ensureFolderCacheDir() {
  try {
    if (!fs.existsSync(FOLDER_CACHE_DIR)) fs.mkdirSync(FOLDER_CACHE_DIR, { recursive: true });
  } catch (err) {
    console.warn('Could not ensure folder cache dir:', err && err.message ? err.message : err);
  }
}

function folderCachePath(folderName = '') {
  ensureFolderCacheDir();
  // sanitize folderName to avoid path traversal
  const safeName = folderName.replace(/[^a-zA-Z0-9-_\.]/g, '_');
  return path.join(FOLDER_CACHE_DIR, `${safeName}.json`);
}

function saveFolderCache(folderName = '', subdocs = null) {
  if (!folderName || !subdocs) return;
  try {
    const filePath = folderCachePath(folderName);
    // Strip large fields just in case
    const cleaned = {
      name: subdocs.name,
      type: subdocs.type,
      items: (subdocs.items || []).map((it) => {
        const copy = { ...it };
        delete copy.pageContent;
        delete copy.imageBase64;
        try {
          const target = path.resolve(documentsPath, folderName, copy.name);
          if (fs.existsSync(target)) {
            const s = fs.statSync(target);
            copy.mtimeMs = s.mtimeMs;
            copy.size = s.size;
          }
        } catch (e) {}
        return copy;
      }),
    };
    fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to write folder cache for', folderName, err && err.message ? err.message : err);
  }
}

function loadFolderCache(folderName = '') {
  if (!folderName) return null;
  try {
    const filePath = folderCachePath(folderName);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // Validate cache by verifying mtimes match actual files when available
    if (!parsed || !parsed.items || !Array.isArray(parsed.items)) return null;
    const results = [];
    for (const item of parsed.items) {
      try {
        const target = path.resolve(documentsPath, folderName, item.name);
        if (!fs.existsSync(target)) continue; // skip missing files
        const stat = fs.statSync(target);
        // if the cached item has mtimeMs and it differs a lot, skip this item
        if (item.mtimeMs && Math.abs(item.mtimeMs - stat.mtimeMs) > 2000) continue;
        // update size/mtime from disk to be safe
        const copy = { ...item, mtimeMs: stat.mtimeMs, size: stat.size };
        results.push(copy);
      } catch (e) {
        continue;
      }
    }
    if (!results.length) return null;
    return { name: parsed.name, type: parsed.type, items: results };
  } catch (err) {
    console.warn('Failed to load folder cache for', folderName, err && err.message ? err.message : err);
    return null;
  }
}

// Check if the vector-cache folder is empty or not
// useful for it the user is changing embedders as this will
// break the previous cache.
function hasVectorCachedFiles() {
  try {
    return (
      fs.readdirSync(vectorCachePath)?.filter((name) => name.endsWith(".json"))
        .length !== 0
    );
  } catch {}
  return false;
}

/**
 * @param {string[]} filenames - array of filenames to check for pinned workspaces
 * @returns {Promise<Record<string, string[]>>} - a record of filenames and their corresponding workspaceIds
 */
async function getPinnedWorkspacesByDocument(filenames = []) {
  return (
    await Document.where(
      {
        docpath: {
          in: Object.keys(filenames),
        },
        pinned: true,
      },
      null,
      null,
      null,
      {
        workspaceId: true,
        docpath: true,
      }
    )
  ).reduce((result, { workspaceId, docpath }) => {
    const filename = filenames[docpath];
    if (!result[filename]) result[filename] = [];
    if (!result[filename].includes(workspaceId))
      result[filename].push(workspaceId);
    return result;
  }, {});
}

/**
 * Get a record of filenames and their corresponding workspaceIds that have watched a document
 * that will be used to determine if a document should be displayed in the watched documents sidebar
 * @param {string[]} filenames - array of filenames to check for watched workspaces
 * @returns {Promise<Record<string, string[]>>} - a record of filenames and their corresponding workspaceIds
 */
async function getWatchedDocumentFilenames(filenames = []) {
  return (
    await Document.where(
      {
        docpath: { in: Object.keys(filenames) },
        watched: true,
      },
      null,
      null,
      null,
      { workspaceId: true, docpath: true }
    )
  ).reduce((result, { workspaceId, docpath }) => {
    const filename = filenames[docpath];
    result[filename] = workspaceId;
    return result;
  }, {});
}

/**
 * Purges the entire vector-cache folder and recreates it.
 * @returns {void}
 */
function purgeEntireVectorCache() {
  fs.rmSync(vectorCachePath, { recursive: true, force: true });
  fs.mkdirSync(vectorCachePath);
  return;
}

/**
 * File size threshold for files that are too large to be read into memory (MB)
 *
 * If the file is larger than this, we will stream it and parse it in chunks
 * This is to prevent us from using too much memory when parsing large files
 * or loading the files in the file picker.
 * @TODO - When lazy loading for folders is implemented, we should increase this threshold (512MB)
 * since it will always be faster to readSync than to stream the file and parse it in chunks.
 */
const FILE_READ_SIZE_THRESHOLD = 150 * (1024 * 1024);

// Default concurrency for resync file processing (can be tuned via env RESYNC_CONCURRENCY)
const RESYNC_CONCURRENCY = parseInt(process.env.RESYNC_CONCURRENCY || "8");

// Threshold (ms) to consider a single file processing "slow" and emit detailed timings
const RESYNC_SLOW_MS = parseInt(process.env.RESYNC_SLOW_MS || "2000");
// Concurrency for processing large files (>= FILE_READ_SIZE_THRESHOLD). Tune via RESYNC_LARGE_CONCURRENCY.
const RESYNC_LARGE_CONCURRENCY = parseInt(process.env.RESYNC_LARGE_CONCURRENCY || "2");

// Run async task functions with a concurrency limit and optional progress callback
async function runWithConcurrency(taskFns = [], limit = 8, onProgress = null) {
  return new Promise((resolve, reject) => {
    let i = 0;
    let running = 0;
    let completed = 0;
    const results = new Array(taskFns.length);

    function runNext() {
      if (completed === taskFns.length) return resolve(results);
      while (running < limit && i < taskFns.length) {
        const idx = i++;
        running++;
        taskFns[idx]()
          .then((res) => {
            results[idx] = res;
          })
          .catch((err) => {
            results[idx] = null;
            console.error('Error in resync task:', err && err.message ? err.message : err);
          })
          .finally(() => {
            running--;
            completed++;
            if (typeof onProgress === 'function') {
              try { onProgress(completed, taskFns.length); } catch (e) {}
            }
            runNext();
          });
      }
    }

    runNext();
  });
}

/**
 * Converts a file to picker data
 * @param {string} pathToFile - The path to the file to convert
 * @param {boolean} liveSyncAvailable - Whether live sync is available
 * @returns {Promise<{name: string, type: string, [string]: any, cached: boolean, canWatch: boolean}>} - The picker data
 */
async function fileToPickerData({
  pathToFile,
  liveSyncAvailable = false,
  cachefilename = null,
}) {
  let metadata = {};
  const filename = path.basename(pathToFile);
  const tStart = process.hrtime();
  const fileStats = fs.statSync(pathToFile);
  const cachedStatus = await cachedVectorInformation(cachefilename, true);

  if (fileStats.size < FILE_READ_SIZE_THRESHOLD) {
    const rawData = fs.readFileSync(pathToFile, "utf8");
    try {
      metadata = JSON.parse(rawData);
      // Remove large fields - not needed for the picker
      delete metadata.pageContent;
      delete metadata.imageBase64;
    } catch (err) {
      console.error("Error parsing file", err);
      return null;
    }

    const tElapsed = process.hrtime(tStart);
    if (process.env.DEBUG_RESYNC === 'true') {
      console.log(`[RESYNC] fileToPickerData ${filename} size=${fileStats.size} took ${tElapsed[0]}s ${Math.round(tElapsed[1]/1e6)}ms`);
    }

    return {
      name: filename,
      type: "file",
      ...metadata,
      cached: cachedStatus,
      canWatch: liveSyncAvailable
        ? DocumentSyncQueue.canWatch(metadata)
        : false,
    };
  }

  console.log(
    `Stream-parsing ${path.basename(pathToFile)} because it exceeds the ${FILE_READ_SIZE_THRESHOLD} byte limit.`
  );
  const stream = fs.createReadStream(pathToFile, { encoding: "utf8" });
  try {
    let fileContent = "";
    metadata = await new Promise((resolve, reject) => {
      stream
        .on("data", (chunk) => {
          fileContent += chunk;
        })
        .on("end", () => {
          metadata = JSON.parse(fileContent);
          // Remove large fields - not needed for the picker
          delete metadata.pageContent;
          delete metadata.imageBase64;
          resolve(metadata);
        })
        .on("error", (err) => {
          console.error("Error parsing file", err);
          reject(null);
        });
    }).catch((err) => {
      console.error("Error parsing file", err);
    });
  } catch (err) {
    console.error("Error parsing file", err);
    metadata = null;
  } finally {
    stream.destroy();
  }

  // If the metadata is empty or something went wrong, return null
  if (!metadata || !Object.keys(metadata)?.length) {
    if (process.env.DEBUG_RESYNC === 'true') console.log(`Stream-parsing failed for ${path.basename(pathToFile)}`);
    return null;
  }

  return {
    name: filename,
    type: "file",
    ...metadata,
    cached: cachedStatus,
    canWatch: liveSyncAvailable ? DocumentSyncQueue.canWatch(metadata) : false,
  };
}

const REQUIRED_FILE_OBJECT_FIELDS = [
  "name",
  "type",
  "url",
  "title",
  "docAuthor",
  "description",
  "docSource",
  "chunkSource",
  "published",
  "wordCount",
  // token_count_estimate removed for backward compatibility with existing files
];

/**
 * Checks if a given metadata object has all the required fields
 * @param {{name: string, type: string, url: string, title: string, docAuthor: string, description: string, docSource: string, chunkSource: string, published: string, wordCount: number}} metadata - The metadata object to check (fileToPickerData)
 * @returns {boolean} - Returns true if the metadata object has all the required fields, false otherwise
 */
function hasRequiredMetadata(metadata = {}) {
  return REQUIRED_FILE_OBJECT_FIELDS.every((field) =>
    metadata.hasOwnProperty(field)
  );
}

/**
 * Processes a single file asynchronously.
 * @param {string} folderPath - The path to the folder containing the file
 * @param {string} folderName - The name of the folder
 * @param {string} fileName - The name of the file
 * @param {boolean} liveSyncAvailable - Whether live sync is available
 * @returns {Promise<object|null>} - The processed file object or null if processing failed
 */
async function processSingleFile(folderPath, folderName, fileName, liveSyncAvailable) {
  const filePath = path.join(folderPath, fileName);
  const cacheFilename = `${folderName}/${fileName}`;
  const timings = {};
  const start = process.hrtime();
  try {
    // stat
    const tStatStart = process.hrtime();
    let stat = null;
    try { stat = await fs.promises.stat(filePath); } catch (e) {}
    const tStat = process.hrtime(tStatStart);
    timings.statMs = Math.round(tStat[0] * 1000 + tStat[1] / 1e6);

    // read
    const tReadStart = process.hrtime();
    const rawData = await fs.promises.readFile(filePath, "utf8");
    const tRead = process.hrtime(tReadStart);
    timings.readMs = Math.round(tRead[0] * 1000 + tRead[1] / 1e6);

    // cached lookup
    const tCachedStart = process.hrtime();
    const cached = await cachedVectorInformation(cacheFilename, true);
    const tCached = process.hrtime(tCachedStart);
    timings.cachedMs = Math.round(tCached[0] * 1000 + tCached[1] / 1e6);

    // parse
    const tParseStart = process.hrtime();
    let metadata;
    try {
      const parsed = JSON.parse(rawData);
      // Remove large fields that are not needed for the picker UI
      const { pageContent, imageBase64, ...rest } = parsed;
      metadata = rest;
      // Explicitly null out the parsed object to help GC
      parsed.pageContent = null;
      parsed.imageBase64 = null;
    } catch (parseError) {
      const tParse = process.hrtime(tParseStart);
      timings.parseMs = Math.round(tParse[0] * 1000 + tParse[1] / 1e6);
      console.error(`JSON parse error for ${fileName}:`, parseError);
      return null;
    }
    const tParse = process.hrtime(tParseStart);
    timings.parseMs = Math.round(tParse[0] * 1000 + tParse[1] / 1e6);

    // canWatch
    const tCanWatchStart = process.hrtime();
    const canWatch = liveSyncAvailable ? DocumentSyncQueue.canWatch(metadata) : false;
    const tCanWatch = process.hrtime(tCanWatchStart);
    timings.canWatchMs = Math.round(tCanWatch[0] * 1000 + tCanWatch[1] / 1e6);

    const total = process.hrtime(start);
    const totalMs = Math.round(total[0] * 1000 + total[1] / 1e6);

    // Emit detailed timing if DEBUG_RESYNC or file processing exceeded threshold
    if (process.env.DEBUG_RESYNC === 'true' || totalMs >= RESYNC_SLOW_MS) {
      console.log(`${new Date().toISOString()} [RESYNC] slow-file ${cacheFilename} size=${stat && stat.size ? stat.size : 'unknown'} totalMs=${totalMs} timings=${JSON.stringify(timings)}`);
    }

    return {
      name: fileName,
      type: "file",
      ...metadata,
      cached,
      canWatch,
    };
  } catch (err) {
    console.error(`Error processing ${fileName}:`, err);
    return null;
  }
}

/**
 * Processes files in batches with pinned workspaces and watched documents info.
 * @param {Array} batch - Array of file objects to process
 * @param {object} filenames - Mapping of cache filenames to actual filenames
 * @param {object} subdocs - The subdirectory object to add items to
 */
async function processBatch(batch, filenames, subdocs) {
  // Batch fetch workspace and watch information
  const [pinnedWorkspaces, watchedDocs] = await Promise.all([
    getPinnedWorkspacesByDocument(filenames),
    getWatchedDocumentFilenames(filenames)
  ]);

  // Update items with pinned and watched information
  batch.forEach(item => {
    item.pinnedWorkspaces = pinnedWorkspaces[item.name] || [];
    item.watched = watchedDocs.hasOwnProperty(item.name) || false;
    subdocs.items.push(item);
  });
}

/**
 * Views files from Redis metadata - processes specific files based on Redis metadata.
 * This is used when files are processed by the collector and metadata is stored in Redis.
 * @param {string[]} filePaths - Array of file paths to process (e.g., ["folder/file.json"])
 * @returns {Promise<object>} - Directory structure with processed files
 */
async function viewRedisFiles(filePaths = []) {
  try {
    // Check if the input is a valid non-empty array
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("File paths must be provided as a non-empty array");
    }

    // Initialize the base directory structure
    let directory = {
      name: "documents",
      type: "folder",
      items: []
    };

    // Check if live sync is available
    const liveSyncAvailable = await DocumentSyncQueue.enabled();

    // Group files by their parent folder
    const folderGroups = filePaths.reduce((groups, filePath) => {
      const normalizedPath = normalizePath(filePath);
      const folderName = path.dirname(normalizedPath);
      if (!groups[folderName]) {
        groups[folderName] = [];
      }
      groups[folderName].push(path.basename(normalizedPath));
      return groups;
    }, {});

    // Process each folder group
    for (const [folderName, fileNames] of Object.entries(folderGroups)) {
      try {
        const folderPath = path.resolve(documentsPath, folderName);
        
        // If the folder doesn't exist, log a warning and continue
        if (!fs.existsSync(folderPath)) {
          console.warn(`Folder ${folderName} does not exist, skipping...`);
          continue;
        }

        // Prepare a subdirectory for this folder
        const subdocs = {
          name: folderName,
          type: "folder",
          items: []
        };

        // Process files in batches
        for (let i = 0; i < fileNames.length; i += BATCH_SIZE) {
          const batch = fileNames.slice(i, i + BATCH_SIZE);
          const fileTasks = batch.map(fileName => {
            return processSingleFile(folderPath, folderName, fileName, liveSyncAvailable);
          });

          const processedFiles = (await Promise.all(fileTasks)).filter(Boolean);
          
          // Create a mapping for filenames
          const filenamesMap = {};
          processedFiles.forEach(file => {
            filenamesMap[`${folderName}/${file.name}`] = file.name;
          });

          await processBatch(processedFiles, filenamesMap, subdocs);
        }
        
        // Add or update the folder in the main directory structure
        if (subdocs.items.length > 0) {
          const existingIndex = directory.items.findIndex(item => item.name === folderName);
          if (existingIndex !== -1) {
            directory.items[existingIndex] = subdocs;
          } else {
            directory.items.push(subdocs);
          }
        }
      } catch (err) {
        console.error(`Error processing folder ${folderName}:`, err);
      }
    }

    return directory;
  } catch (error) {
    console.error("Error in viewRedisFiles:", error);
    throw error;
  }
}

/**
 * Batch-based incremental resync with progress tracking
 * @param {ResyncSession} session - Active resync session
 * @returns {Promise<Object>} - Final directory structure
 */
async function incrementalResync(session) {
  try {
    session.status = 'running';
    session.emit('started', session.getStatus());

    if (!fs.existsSync(documentsPath)) fs.mkdirSync(documentsPath, { recursive: true });
    
    const directory = {
      name: "documents",
      type: "folder",
      items: [],
    };

    // Get folders to process
    let folders = fs.readdirSync(documentsPath).filter((f) => {
      if (path.extname(f) === ".md") return false;
      const folderPath = path.resolve(documentsPath, f);
      return fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory();
    });

    // Apply folder filter if specified
    if (session.folderFilter && Array.isArray(session.folderFilter)) {
      folders = folders.filter(f => session.folderFilter.includes(f));
    }

    session.folders = folders;

    // Count total files (only if not already counted - for resume support)
    const perFolderFiles = {};
    if (session.totalFiles === 0) {
      for (const folderName of folders) {
        const folderPath = path.resolve(documentsPath, folderName);
        try {
          const subfiles = fs.readdirSync(folderPath).filter((sf) => path.extname(sf) === ".json");
          perFolderFiles[folderName] = subfiles;
          session.totalFiles += subfiles.length;
        } catch (err) {
          perFolderFiles[folderName] = [];
        }
      }
    } else {
      // Already counted (resume case) - just rebuild the file list
      for (const folderName of folders) {
        const folderPath = path.resolve(documentsPath, folderName);
        try {
          const subfiles = fs.readdirSync(folderPath).filter((sf) => path.extname(sf) === ".json");
          perFolderFiles[folderName] = subfiles;
        } catch (err) {
          perFolderFiles[folderName] = [];
        }
      }
    }

    session.totalBatches = Math.ceil(session.totalFiles / session.batchSize);
    session.emit('progress', session.getStatus());

    const liveSyncAvailable = await DocumentSyncQueue.enabled();
    let { redisHelper } = require('./redis');

    // Process each folder
    for (const folderName of folders) {
      if (session.shouldCancel) {
        session.status = 'cancelled';
        session.endTime = Date.now();
        session.emit('cancelled', session.getStatus());
        return directory;
      }

      if (session.shouldPause) {
        session.status = 'paused';
        session.emit('paused', session.getStatus());
        return directory;
      }

      // Skip folders that were already completed (for resume)
      if (session.completedFolders.has(folderName)) {
        console.log(`[RESUME] Skipping already completed folder: ${folderName}`);
        continue;
      }

      // Only reset progress if switching to a new folder
      if (session.currentFolder !== folderName) {
        session.currentFolder = folderName;
        session.currentFolderProgress = 0;
      }
      
      const folderPath = path.resolve(documentsPath, folderName);
      
      // Load existing cache data when resuming to avoid re-accumulating data
      let subdocs;
      if (session.currentFolderProgress > 0) {
        // Resuming - load existing data from cache
        const cachedData = await redisHelper.getFolderData(folderName);
        subdocs = cachedData || { name: folderName, type: "folder", items: [] };
        console.log(`[RESUME] Loaded ${subdocs.items.length} existing items for ${folderName}`);
      } else {
        // Starting fresh for this folder
        subdocs = { name: folderName, type: "folder", items: [] };
      }
      
      const subfiles = perFolderFiles[folderName] || [];

      if (subfiles.length === 0) {
        directory.items.push(subdocs);
        session.completedFolders.add(folderName);
        continue;
      }

      // Process files in batches
      for (let i = session.currentFolderProgress; i < subfiles.length; i += session.batchSize) {
        if (session.shouldCancel) break;
        if (session.shouldPause) {
          session.status = 'paused';
          session.emit('paused', session.getStatus());
          return directory; // Return current progress
        }

        session.currentBatch++;
        const batch = subfiles.slice(i, i + session.batchSize);
        const batchStartTime = Date.now();

        // On resume, check which files in this batch are already in cache
        const existingFileNames = new Set(subdocs.items.map(item => item.name));
        const filesToProcess = batch.filter(fileName => {
          const baseName = path.basename(fileName, '.json');
          return !existingFileNames.has(baseName);
        });

        if (filesToProcess.length === 0) {
          console.log(`[RESUME] Batch ${session.currentBatch}: All files already cached, skipping`);
          session.currentFolderProgress = i + session.batchSize;
          continue;
        }

        // Process batch (only new files)
        const taskFns = filesToProcess.map(fileName => async () => {
          const fileStartTime = Date.now();
          session.currentFile = fileName;
          const result = await processSingleFile(folderPath, folderName, fileName, liveSyncAvailable);
          const fileTime = Date.now() - fileStartTime;
          if (result) session.addProcessedFile(fileName, fileTime);
          return result;
        });

        const results = await runWithConcurrency(taskFns, RESYNC_CONCURRENCY);
        const validResults = results.filter(Boolean).filter(i => hasRequiredMetadata(i));
        subdocs.items.push(...validResults);

        // Attach pinned/watched info for this batch
        const filenames = {};
        validResults.forEach(item => { filenames[`${folderName}/${item.name}`] = item.name; });
        const pinned = await getPinnedWorkspacesByDocument(filenames);
        const watched = await getWatchedDocumentFilenames(filenames);
        for (const item of validResults) {
          item.pinnedWorkspaces = pinned[item.name] || [];
          item.watched = watched.hasOwnProperty(item.name) || false;
        }

        // Save incremental cache after each batch (both Redis and disk)
        try {
          const itemCount = subdocs.items.length;
          // Always save to Redis to keep it in sync
          await redisHelper.saveFolderData(folderName, subdocs);
          console.log(`[CACHE] Saved ${itemCount} items to Redis for '${folderName}'`);
          // Also save to disk as backup
          saveFolderCache(folderName, subdocs);
        } catch (err) {
          // If Redis fails, still save to disk
          console.warn(`Failed to save cache for ${folderName} to Redis (${err.message}), saving to disk only`);
          try {
            saveFolderCache(folderName, subdocs);
          } catch (diskErr) {
            console.error(`Failed to save cache to disk for ${folderName}:`, diskErr.message);
          }
        }

        // Emit batch completion event
        const batchTime = Date.now() - batchStartTime;
        session.emit('batchComplete', {
          sessionId: session.sessionId,
          batchNumber: session.currentBatch,
          totalBatches: session.totalBatches,
          folder: folderName,
          filesInBatch: validResults.map(f => f.name),
          batchTime,
          ...session.getStatus()
        });

        session.updateProgress({ currentFile: null });
        session.currentFolderProgress = i + session.batchSize; // Track progress within folder
      }

      // Mark folder as completed
      session.completedFolders.add(folderName);
      session.currentFolderProgress = 0;
      directory.items.push(subdocs);
    }

    // Sort folders (custom-documents first)
    directory.items = [
      directory.items.find((folder) => folder.name === "custom-documents"),
      ...directory.items.filter((folder) => folder.name !== "custom-documents"),
    ].filter((i) => !!i);

    session.complete();
    return directory;

  } catch (error) {
    session.fail(error);
    throw error;
  }
}

module.exports = {
  findDocumentInDocuments,
  cachedVectorInformation,
  viewLocalFiles,
  purgeSourceDocument,
  purgeVectorCache,
  storeVectorResult,
  fileData,
  normalizePath,
  isWithin,
  documentsPath,
  directUploadsPath,
  hasVectorCachedFiles,
  purgeEntireVectorCache,
  getDocumentsByFolder,
  hotdirPath,
  viewRedisFiles,
  incrementalResync,
  saveFolderCache,
};

// Preload per-folder caches into Redis on startup (best-effort, non-blocking)
async function preloadFolderCaches() {
  try {
    ensureFolderCacheDir();
    const folders = fs.existsSync(documentsPath) ? fs.readdirSync(documentsPath).filter((f) => fs.lstatSync(path.join(documentsPath, f)).isDirectory()) : [];
    if (!folders.length) return;
    let redisHelper = null;
    try { ({ redisHelper } = require('./redis')); } catch (e) { /* no redis */ }
    for (const folder of folders) {
      try {
        const cached = loadFolderCache(folder);
        if (cached) {
          if (redisHelper && typeof redisHelper.saveFolderData === 'function') {
            try { await redisHelper.saveFolderData(folder, cached); console.log(`[PRELOAD] saved folder '${folder}' to Redis from disk cache`); } catch (e) {}
          }
        }
      } catch (err) {
        // ignore individual failures
      }
    }
    console.log('[PRELOAD] Completed loading per-folder caches (best-effort)');
  } catch (err) {
    console.warn('Failed to preload folder caches:', err && err.message ? err.message : err);
  }
}

// Refresh a single folder: scan it, build subdocs, save to Redis and disk, return subdocs
async function refreshFolderCache(folderName = '') {
  if (!folderName) throw new Error('folderName required');
  const folderPath = path.resolve(documentsPath, normalizePath(folderName));
  if (!fs.existsSync(folderPath) || !fs.lstatSync(folderPath).isDirectory()) throw new Error('Folder does not exist');
  const subdocs = { name: folderName, type: 'folder', items: [] };
  const subfiles = fs.readdirSync(folderPath).filter((f) => path.extname(f) === '.json');
  if (!subfiles.length) return subdocs;
  const liveSyncAvailableForFolder = await DocumentSyncQueue.enabled();
  const smallTaskFns = [];
  const largeTaskFns = [];
  for (const subfile of subfiles) {
    const fullPath = path.join(folderPath, subfile);
    let stat = null;
    try { stat = fs.statSync(fullPath); } catch (e) {}
    const isLarge = stat && stat.size >= FILE_READ_SIZE_THRESHOLD;
    const task = () => fileToPickerData({ pathToFile: fullPath, liveSyncAvailable: liveSyncAvailableForFolder, cachefilename: `${folderName}/${subfile}` });
    if (isLarge) largeTaskFns.push(task); else smallTaskFns.push(task);
  }
  const smallResults = (smallTaskFns.length > 0) ? await runWithConcurrency(smallTaskFns, RESYNC_CONCURRENCY) : [];
  const largeResults = (largeTaskFns.length > 0) ? await runWithConcurrency(largeTaskFns, RESYNC_LARGE_CONCURRENCY) : [];
  const results = [...smallResults, ...largeResults].filter(Boolean).filter(i => hasRequiredMetadata(i));
  subdocs.items.push(...results);
  // attach pinned/watched
  const filenames = {};
  results.forEach(item => { filenames[`${folderName}/${item.name}`] = item.name; });
  const pinned = await getPinnedWorkspacesByDocument(filenames);
  const watched = await getWatchedDocumentFilenames(filenames);
  for (const item of subdocs.items) {
    item.pinnedWorkspaces = pinned[item.name] || [];
    item.watched = watched.hasOwnProperty(item.name) || false;
  }
  // save to redis and disk
  try { const { redisHelper } = require('./redis'); if (redisHelper && typeof redisHelper.saveFolderData === 'function') await redisHelper.saveFolderData(folderName, subdocs); } catch (e) {}
  try { saveFolderCache(folderName, subdocs); } catch (e) {}
  return subdocs;
}

// Start preload without blocking module load
setImmediate(() => { preloadFolderCaches().catch(() => {}); });

module.exports.preloadFolderCaches = preloadFolderCaches;
module.exports.refreshFolderCache = refreshFolderCache;
