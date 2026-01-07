const fs = require("fs");
const path = require("path");
const { MimeDetector } = require("./mime");

// Optional Redis caching support
let redisHelper = null;
try {
  const redisModule = require("./redis");
  redisHelper = redisModule.redisHelper;
} catch (e) {
  // Redis not available, caching disabled
}

/**
 * The folder where documents are stored to be stored when
 * processed by the collector.
 */
const documentsFolder =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../../server/storage/documents`)
    : path.resolve(process.env.STORAGE_DIR, `documents`);

/**
 * The folder where direct uploads are stored to be stored when
 * processed by the collector. These are files that were DnD'd into UI
 * and are not to be embedded or selectable from the file picker.
 */
const directUploadsFolder =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../../server/storage/direct-uploads`)
    : path.resolve(process.env.STORAGE_DIR, `direct-uploads`);

/**
 * Checks if a file is text by checking the mime type and then falling back to buffer inspection.
 * This way we can capture all the cases where the mime type is not known but still parseable as text
 * without having to constantly add new mime type overrides.
 * @param {string} filepath - The path to the file.
 * @returns {boolean} - Returns true if the file is text, false otherwise.
 */
function isTextType(filepath) {
  if (!fs.existsSync(filepath)) return false;
  const result = isKnownTextMime(filepath);
  if (result.valid) return true; // Known text type - return true.
  if (result.reason !== "generic") return false; // If any other reason than generic - return false.
  return parseableAsText(filepath); // Fallback to parsing as text via buffer inspection.
}

/**
 * Checks if a file is known to be text by checking the mime type.
 * @param {string} filepath - The path to the file.
 * @returns {boolean} - Returns true if the file is known to be text, false otherwise.
 */
function isKnownTextMime(filepath) {
  try {
    const mimeLib = new MimeDetector();
    const mime = mimeLib.getType(filepath);
    if (mimeLib.badMimes.includes(mime))
      return { valid: false, reason: "bad_mime" };

    const type = mime.split("/")[0];
    if (mimeLib.nonTextTypes.includes(type))
      return { valid: false, reason: "non_text_mime" };
    return { valid: true, reason: "valid_mime" };
  } catch (e) {
    return { valid: false, reason: "generic" };
  }
}

/**
 * Checks if a file is parseable as text by forcing it to be read as text in utf8 encoding.
 * If the file looks too much like a binary file, it will return false.
 * @param {string} filepath - The path to the file.
 * @returns {boolean} - Returns true if the file is parseable as text, false otherwise.
 */
function parseableAsText(filepath) {
  try {
    const fd = fs.openSync(filepath, "r");
    const buffer = Buffer.alloc(1024); // Read first 1KB of the file synchronously
    const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);

    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const nullCount = (content.match(/\0/g) || []).length;
    const controlCount = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || [])
      .length;

    const threshold = bytesRead * 0.1;
    return nullCount + controlCount < threshold;
  } catch {
    return false;
  }
}

function trashFile(filepath) {
  if (!fs.existsSync(filepath)) return;

  try {
    const isDir = fs.lstatSync(filepath).isDirectory();
    if (isDir) return;
  } catch {
    return;
  }

  fs.rmSync(filepath);
  return;
}

function createdDate(filepath) {
  try {
    const { birthtimeMs, birthtime } = fs.statSync(filepath);
    if (birthtimeMs === 0) throw new Error("Invalid stat for file!");
    return birthtime.toLocaleString();
  } catch {
    return "unknown";
  }
}

/**
 * Writes a document to the server documents folder.
 * @param {Object} params - The parameters for the function.
 * @param {Object} params.data - The data to write to the file. Must look like a document object.
 * @param {string} params.filename - The name of the file to write to.
 * @param {string|null} params.destinationOverride - A forced destination to write to - will be honored if provided.
 * @param {Object} params.options - The options for the function.
 * @param {boolean} params.options.parseOnly - If true, the file will be written to the direct uploads folder instead of the documents folder. Will be ignored if destinationOverride is provided.
 * @returns {Object} - The data with the location added.
 */
function writeToServerDocuments({
  data = {},
  filename,
  destinationOverride = null,
  options = {},
}) {
  if (!filename) throw new Error("Filename is required!");

  let destination = null;
  if (destinationOverride) destination = path.resolve(destinationOverride);
  else if (options.parseOnly) destination = path.resolve(directUploadsFolder);
  else destination = path.resolve(documentsFolder, "custom-documents");

  if (!fs.existsSync(destination))
    fs.mkdirSync(destination, { recursive: true });
  const destinationFilePath = normalizePath(
    path.resolve(destination, filename) + ".json"
  );

  fs.writeFileSync(destinationFilePath, JSON.stringify(data, null, 4), {
    encoding: "utf-8",
  });

  return {
    ...data,
    // relative location string that can be passed into the /update-embeddings api
    // that will work since we know the location exists and since we only allow
    // 1-level deep folders this will always work. This still works for integrations like GitHub and YouTube.
    location: destinationFilePath.split("/").slice(-2).join("/"),
    isDirectUpload: options.parseOnly || false,
  };
}

// When required we can wipe the entire collector hotdir and tmp storage in case
// there were some large file failures that we unable to be removed a reboot will
// force remove them.
async function wipeCollectorStorage() {
  const cleanHotDir = new Promise((resolve) => {
    const directory = path.resolve(__dirname, "../../hotdir");
    fs.readdir(directory, (err, files) => {
      if (err) resolve();

      for (const file of files) {
        if (file === "__HOTDIR__.md") continue;
        try {
          fs.rmSync(path.join(directory, file));
        } catch {}
      }
      resolve();
    });
  });

  const cleanTmpDir = new Promise((resolve) => {
    const directory = path.resolve(__dirname, "../../storage/tmp");
    fs.readdir(directory, (err, files) => {
      if (err) resolve();

      for (const file of files) {
        if (file === ".placeholder") continue;
        try {
          fs.rmSync(path.join(directory, file));
        } catch {}
      }
      resolve();
    });
  });

  await Promise.all([cleanHotDir, cleanTmpDir]);
  console.log(`Collector hot directory and tmp storage wiped!`);
  return;
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

function sanitizeFileName(fileName) {
  if (!fileName) return fileName;
  return fileName.replace(/[<>:"\/\\|?*]/g, "");
}

/**
 * Write large files to server with chunk-based streaming
 * Useful for processing large documents to avoid memory issues
 * @param {Object} data - Document data with pageContent
 * @param {string} filename - Name of the file
 * @param {string} destinationPath - Destination path (optional if using override)
 * @param {string|null} destinationOverride - Override destination path
 */
async function writeToServerDocumentsWithChunks(data = {}, filename, destinationPath = null, destinationOverride = null) {
  if (!filename) {
    throw new Error('Filename is required');
  }

  let destination = null;
  if (destinationOverride) {
    destination = path.resolve(destinationOverride);
  } else if (destinationPath) {
    destination = path.resolve(__dirname, destinationPath);
  } else {
    destination = path.resolve(documentsFolder, "custom-documents");
  }

  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const destinationFilePath = normalizePath(
    path.resolve(destination, filename) + ".json"
  );

  try {
    const writeStream = fs.createWriteStream(destinationFilePath, {
      flags: 'w',
      encoding: 'utf8',
      highWaterMark: 64 * 1024 // 64KB chunks
    });

    const writeChunk = (chunk) => {
      return new Promise((resolve, reject) => {
        const canContinue = writeStream.write(chunk);
        if (!canContinue) {
          writeStream.once('drain', resolve);
        } else {
          resolve();
        }
      });
    };

    await writeChunk('{\\n');

    const { pageContent, ...metadata } = data;
    for (const [key, value] of Object.entries(metadata)) {
      await writeChunk(`  "${key}": ${JSON.stringify(value)},\\n`);
    }

    await writeChunk('  "pageContent": "');
    
    if (pageContent && pageContent.length > 0) {
      const chunkSize = 1024 * 1024; // 1MB chunks
      for (let i = 0; i < pageContent.length; i += chunkSize) {
        const chunk = pageContent.slice(i, i + chunkSize)
          .replace(/\\\\/g, '\\\\\\\\')
          .replace(/"/g, '\\\\"')
          .replace(/\\n/g, '\\\\n')
          .replace(/\\r/g, '\\\\r')
          .replace(/\\t/g, '\\\\t');
        
        if (chunk.length > 0) {
          await writeChunk(chunk);
        }
        
        if (global.gc) global.gc();
      }
    }

    await writeChunk('"\\n}');

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    return {
      ...data,
      location: destinationFilePath.split("/").slice(-2).join("/"),
    };

  } catch (error) {
    console.error('Error writing document with chunks:', error);
    throw error;
  } finally {
    if (global.gc) global.gc();
  }
}

/**
 * Handle file metadata caching with Redis (if available)
 * Falls back to no-op if Redis is not configured
 * @param {Object} data - File metadata
 * @param {string} operation - 'read' or 'write'
 */
async function handleLocalFilesCache(data = {}, operation = 'read') {
  if (!redisHelper) {
    return operation === 'read' ? { files: [] } : data;
  }

  try {
    const folderName = path.dirname(data.location) || '';
    const fileName = path.basename(data.location);
    
    if (!fileName) {
      throw new Error('File name is required');
    }

    if (operation === 'write') {
      await redisHelper.saveFileMetadata(folderName, fileName, data);
      return data;
    } else {
      const metadata = await redisHelper.getFileMetadata(folderName, fileName);
      return metadata ? { files: [metadata] } : { files: [] };
    }
  } catch (error) {
    console.error('Error handling cache:', error);
    return operation === 'read' ? { files: [] } : data;
  }
}

/**
 * Writes image data to server storage as JSON file
 * @param {Object} data - Image data including imageBuffer and extension
 * @param {string} filename - Name of the file
 * @param {string} destinationOverride - Optional custom destination path
 * @returns {Object} - Image data with location and fullPath
 */
async function writeImageToServer(data = {}, filename, destinationOverride = null) {
  const { imageBuffer, extension } = data; // Destructure data object
  const destination = destinationOverride
    ? path.resolve(destinationOverride)
    : path.resolve(
        __dirname,
        "../../../server/storage/documents/custom-documents"
      );

  // Ensure the destination directory exists
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  // Construct the full file path
  const destinationFilePath = path.resolve(destination, filename) + ".json";

  // Write the image data as JSON
  fs.writeFileSync(destinationFilePath, JSON.stringify(data, null, 4), {
    encoding: "utf-8",
  });
  console.log(`Image saved to ${destinationFilePath}`);

  const result = {
    ...data,
    // relative location string that can be passed into the /update-embeddings api
    // that will work since we know the location exists and since we only allow
    // 1-level deep folders this will always work. This still works for integrations like GitHub and YouTube.
    location: destinationFilePath.split("/").slice(-2).join("/"),
    fullPath: destinationFilePath,
  };

  // Save metadata to Redis if available
  if (redisHelper) {
    try {
      const folderName = destination.split("/").pop(); // Get folder name (e.g., "custom-documents")
      const fileName = filename + ".json";
      await redisHelper.saveFileMetadata(folderName, fileName, result);
      console.log(`📡 Saved metadata to Redis for ${folderName}/${fileName}`);
    } catch (error) {
      console.error('Error saving metadata to Redis:', error.message);
    }
  }

  return result;
}

module.exports = {
  trashFile,
  isTextType,
  createdDate,
  writeToServerDocuments,
  writeToServerDocumentsWithChunks,
  writeImageToServer,
  handleLocalFilesCache,
  wipeCollectorStorage,
  normalizePath,
  isWithin,
  sanitizeFileName,
  documentsFolder,
  directUploadsFolder,
};
