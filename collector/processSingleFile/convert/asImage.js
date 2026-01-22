const { v4 } = require("uuid");
const { tokenizeString } = require("../../utils/tokenizer");
const {
  createdDate,
  trashFile,
  writeToServerDocuments,
} = require("../../utils/files");
const OCRLoader = require("../../utils/OCRLoader");
const { default: slugify } = require("slugify");
const fs = require("fs");
const path = require("path");

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

/**
 * Extract EXIF metadata from image file
 * @param {string} fullFilePath - Path to image file
 * @returns {Object} - Extracted metadata
 */
async function extractImageMetadata(fullFilePath) {
  const metadata = {
    camera: null,
    lens: null,
    dateTime: null,
    location: null,
    settings: null,
  };

  if (!ExifReader || !exifParser) return metadata;

  try {
    const tags = ExifReader.load(fullFilePath);
    
    // Camera info
    if (tags.Make && tags.Model) {
      metadata.camera = `${tags.Make.description} ${tags.Model.description}`;
    }
    
    // Lens info
    if (tags.LensModel) {
      metadata.lens = tags.LensModel.description;
    }
    
    // Date/Time
    if (tags.DateTimeOriginal) {
      metadata.dateTime = tags.DateTimeOriginal.description;
    }
    
    // GPS Location
    if (tags.GPSLatitude && tags.GPSLongitude) {
      metadata.location = {
        latitude: tags.GPSLatitude.description,
        longitude: tags.GPSLongitude.description,
      };
    }
    
    // Camera settings
    metadata.settings = {
      iso: tags.ISOSpeedRatings?.description,
      fNumber: tags.FNumber?.description,
      exposureTime: tags.ExposureTime?.description,
      focalLength: tags.FocalLength?.description,
    };
  } catch (error) {
    console.warn(`EXIF extraction failed: ${error.message}`);
  }

  return metadata;
}

/**
 * Process image for multimodal embedding (base64 encoding)
 * Used when useOCR = false
 */
async function processAsImageEmbedding({ fullFilePath, filename, options, metadata }) {
  console.log(`-- Working ${filename} (Image Embedding mode) --`);
  
  // Read image and convert to base64
  const imageBuffer = fs.readFileSync(fullFilePath);
  const base64Image = imageBuffer.toString('base64');
  const extension = filename.split('.').pop().toLowerCase();
  
  if (!base64Image?.length) {
    console.error(`Resulting base64 content was empty for ${filename}.`);
    trashFile(fullFilePath);
    return {
      success: false,
      reason: `No image content found in ${filename}.`,
      documents: [],
    };
  }
  
  // Extract EXIF metadata if available
  const imageMetadata = await extractImageMetadata(fullFilePath);
  console.log(`[DEBUG] Image metadata extracted:`, JSON.stringify(imageMetadata, null, 2));
  
  // Generate BlurHash if available
  let blurHash = null;
  if (calculateBlurHash) {
    try {
      blurHash = await calculateBlurHash(fullFilePath);
      if (blurHash) {
        console.log(`Generated BlurHash for ${filename}`);
      }
    } catch (error) {
      console.warn(`BlurHash generation failed: ${error.message}`);
    }
  }
  
  // Build description from metadata
  const descriptionParts = [];
  descriptionParts.push(`The photo has the title "${fullFilePath}"`);
  if (imageMetadata.dateTime) {
    descriptionParts.push(`and was created at ${imageMetadata.dateTime}`);
  }
  const metadataParts = [];
  if (imageMetadata.camera) metadataParts.push(`Camera: ${imageMetadata.camera}`);
  if (metadataParts.length > 0) {
    descriptionParts.push(`. ${metadataParts.join(', ')}`);
  }
  const metadataDescription = descriptionParts.join(' ') + '.';
  
  const data = {
    id: v4(),
    url: "file://" + fullFilePath,
    title: metadata.title || filename,
    docAuthor: metadata.docAuthor || imageMetadata.camera || "Unknown",
    description: metadataDescription,
    docSource: metadata.docSource || "an image file uploaded by the user.",
    chunkSource: metadata.chunkSource || "image-upload",
    published: imageMetadata.dateTime || createdDate(fullFilePath),
    wordCount: 0,  // Image embeddings don't have word count
    pageContent: base64Image,
    token_count_estimate: tokenizeString(base64Image).length,
    extension: extension,
    fileType: "image",  // Mark as image for multimodal embedding
    embeddingMode: "server-decided",
    imageBase64: base64Image,
    // Enhanced metadata
    ...(blurHash && { blurHash }),
    ...(imageMetadata.camera && { camera: imageMetadata.camera }),
    ...(imageMetadata.lens && { lens: imageMetadata.lens }),
    ...(imageMetadata.location && { location: imageMetadata.location }),
    ...(imageMetadata.settings && { cameraSettings: imageMetadata.settings }),
  };

  const document = writeToServerDocuments({
    data,
    filename: `${slugify(filename)}-${data.id}`,
    options: { parseOnly: options.parseOnly },
  });
  trashFile(fullFilePath);
  console.log(`[SUCCESS]: ${filename} converted & ready for image embedding.\n`);
  return { success: true, reason: null, documents: [document] };
}

async function asImage({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  // Check if user wants OCR text extraction or image embedding
  const useOCR = options?.useOCR === true;
  
  if (!useOCR) {
    // Use image processing instead of OCR - same as processFiles/convert/asImage.js
    return await processAsImageEmbedding({ fullFilePath, filename, options, metadata });
  }
  
  // Original OCR processing
  let content = await new OCRLoader({
    targetLanguages: options?.ocr?.langList,
  }).ocrImage(fullFilePath);

  if (!content?.length) {
    console.error(`Resulting text content was empty for ${filename}.`);
    trashFile(fullFilePath);
    return {
      success: false,
      reason: `No text content found in ${filename}.`,
      documents: [],
    };
  }

  console.log(`-- Working ${filename} (OCR mode) --`);
  
  // Extract EXIF metadata if available
  const imageMetadata = await extractImageMetadata(fullFilePath);
  console.log(`[DEBUG] Image metadata extracted:`, JSON.stringify(imageMetadata, null, 2));
  
  // Generate BlurHash if available
  let blurHash = null;
  if (calculateBlurHash) {
    try {
      blurHash = await calculateBlurHash(fullFilePath);
      if (blurHash) {
        console.log(`Generated BlurHash for ${filename}`);
      }
    } catch (error) {
      console.warn(`BlurHash generation failed: ${error.message}`);
    }
  }
  
  // Build description from metadata (similar to mythingllm approach)
  const descriptionParts = [];
  descriptionParts.push(`The photo has the title "${fullFilePath}"`);
  if (imageMetadata.dateTime) {
    descriptionParts.push(`and was created at ${imageMetadata.dateTime}`);
  }
  const metadataParts = [];
  if (imageMetadata.camera) metadataParts.push(`Camera: ${imageMetadata.camera}`);
  if (imageMetadata.dimensions) metadataParts.push(`Dimensions: ${imageMetadata.dimensions}`);
  if (imageMetadata.fileSize) metadataParts.push(`Size: ${imageMetadata.fileSize}`);
  if (metadataParts.length > 0) {
    descriptionParts.push(`. ${metadataParts.join(', ')}`);
  }
  const metadataDescription = descriptionParts.join(' ') + '.';
  
  
  const data = {
    id: v4(),
    url: "file://" + fullFilePath,
    title: metadata.title || filename,
    docAuthor: metadata.docAuthor || imageMetadata.camera || "Unknown",
    description: metadataDescription,  // Metadata-based description
    docSource: metadata.docSource || "image file uploaded by the user.",
    chunkSource: metadata.chunkSource || "image-upload",
    published: imageMetadata.dateTime || createdDate(fullFilePath),
    wordCount: content.split(" ").length,
    pageContent: content,
    token_count_estimate: tokenizeString(content),
    fileType: "text",  // OCR-extracted text from image
    // Enhanced metadata
    ...(blurHash && { blurHash }),
    ...(imageMetadata.camera && { camera: imageMetadata.camera }),
    ...(imageMetadata.lens && { lens: imageMetadata.lens }),
    ...(imageMetadata.location && { location: imageMetadata.location }),
    ...(imageMetadata.settings && { cameraSettings: imageMetadata.settings }),
  };

  const document = writeToServerDocuments({
    data,
    filename: `${slugify(filename)}-${data.id}`,
    options: { parseOnly: options.parseOnly },
  });
  trashFile(fullFilePath);
  console.log(`[SUCCESS]: ${filename} converted & ready for embedding.\n`);
  return { success: true, reason: null, documents: [document] };
}

module.exports = asImage;
