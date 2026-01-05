const { v4 } = require("uuid");
const { tokenizeString } = require("../../utils/tokenizer");
const {
  createdDate,
  trashFile,
  writeToServerDocuments,
} = require("../../utils/files");
const OCRLoader = require("../../utils/OCRLoader");
const { default: slugify } = require("slugify");

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

async function asImage({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
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

  console.log(`-- Working ${filename} --`);
  
  // Extract EXIF metadata if available
  const imageMetadata = await extractImageMetadata(fullFilePath);
  
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
  
  const data = {
    id: v4(),
    url: "file://" + fullFilePath,
    title: metadata.title || filename,
    docAuthor: metadata.docAuthor || imageMetadata.camera || "Unknown",
    description: metadata.description || "Unknown",
    docSource: metadata.docSource || "image file uploaded by the user.",
    chunkSource: metadata.chunkSource || "",
    published: imageMetadata.dateTime || createdDate(fullFilePath),
    wordCount: content.split(" ").length,
    pageContent: content,
    token_count_estimate: tokenizeString(content),
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
