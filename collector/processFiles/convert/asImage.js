const { v4 } = require("uuid");
const fs = require("fs");
const { tokenizeString } = require("../../utils/tokenizer");
const {
  createdDate,
  trashFile,
  writeImageToServer,
} = require("../../utils/files");
const { default: slugify } = require("slugify");
const path = require("path");
const sharp = require('sharp'); // You'll need to install sharp: npm install sharp
const { Image } = require('image-js'); // Import the image-js library
const fsp = require('fs-promise');
const TGA = require('tga');
const PNG = require('pngjs').PNG;
const { logMemoryUsage,enableDebugLogging} = require('../../utils/memoryMonitor');
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);
const OCRLoader = require("../../utils/OCRLoader");
// Enable with environment variable
enableDebugLogging(process.env.DEBUG_MEMORY === 'true');

// TGA to PNG conversion function
function tga2png(filePath, savePath) {
  let tga = null;
  let png = null;
  let bufs = [];

  return new Promise((resolve, reject) => {
      logMemoryUsage('Start TGA Conversion');
      
      fsp.readFile(filePath)
          .then(buf => {
              logMemoryUsage('After TGA File Read');
              let width, height;
              try {
                  tga = new TGA(buf);
                  
                  // Validate TGA data first
                  if (!tga) {
                      throw new Error('Failed to create TGA object');
                  }

                  // Log TGA information for debugging
                  console.log('TGA Info:', {
                      hasHeader: !!tga.header,
                      headerWidth: tga?.header?.width,
                      headerHeight: tga?.header?.height,
                      hasPixels: !!tga.pixels,
                      pixelsLength: tga.pixels?.length
                  });

                  // Validate header in detail
                  if (!tga.header || 
                      typeof tga.header.width !== 'number' || 
                      typeof tga.header.height !== 'number' ||
                      tga.header.width <= 0 ||
                      tga.header.height <= 0) {
                      throw new Error('Invalid TGA header structure');
                  }
                  width = tga.header.width;
                  height = tga.header.height;
                  png = new PNG({
                      width: width,
                      height: height
                  });
                  
                  // Validate pixel data
                  if (!tga.pixels || !tga.pixels.length) {
                      throw new Error('No pixel data in TGA file');
                  }

                  png.data = Buffer.from(tga.pixels);
                  tga.pixels = null; // Clear pixel data

                  logMemoryUsage('Before PNG Packing');

                  const packStream = png.pack();
                  packStream.on('data', d => {
                      bufs.push(d);
                  });
                  
                  packStream.on('end', () => {
                      logMemoryUsage('After PNG Pack');
                      
                      let buffer = Buffer.concat(bufs);
                      bufs = [];
                      
                      if (savePath) {
                          fsp.writeFile(savePath, buffer)
                              .then(() => {
                                  buffer = null;
                                  logMemoryUsage('After PNG Write');
                                  
                                  resolve({
                                      width: width,
                                      height: height
                                  });
                              })
                              .catch(err => {
                                  console.error('Write file failed:', err);
                                  reject(new Error(`Failed to write PNG: ${err.message}`));
                              })
                              .finally(() => {
                                  tga = null;
                                  png = null;
                                  if (global.gc) global.gc();
                              });
                      }
                  });
              } catch (err) {
                  console.error('TGA processing failed:', err);
                  reject(new Error(`TGA processing failed: ${err.message}`));
              }
          })
          .catch(err => {
              console.error('Read file failed:', err);
              reject(new Error(`Failed to read TGA file: ${err.message}`));
          })
          .finally(() => {
              tga = null;
              png = null;
              bufs = [];
              if (global.gc) global.gc();
              logMemoryUsage('End TGA Conversion');
          });
  });
}

async function validateImage(filePath) {
    try {
      await sharp(filePath).metadata(); // This will throw an error if the image is corrupted
      console.log(`Image is valid: ${filePath}`);
      return true;
    } catch (error) {
      console.error(`Invalid image: ${filePath}`);
      return false;
    }
}

async function convertWithSharp(fullFilePath, pngFilePath) {
  const metadata = await sharp(fullFilePath).metadata();
  await sharp(fullFilePath)
      .png({
          quality: 100,
          compressionLevel: 9
      })
      .toFile(pngFilePath);
  return metadata;
}

async function convertRawWithDcraw(fullFilePath, pngFilePath) {
  console.log(`Converting RAW file with dcraw: ${fullFilePath}`);
  
  try {
    // dcraw -T outputs TIFF format which sharp supports
    // We'll create a TIFF intermediate file and then convert with sharp
    const tiffPath = pngFilePath.replace('.png', '.tiff');
    
    // Use -T flag to output TIFF format directly (no redirection needed)
    // -w: camera white balance, -q 3: high quality (AHD interpolation), -T: output TIFF
    const dcrawCmd = `dcraw -w -q 3 -T "${fullFilePath}"`;
    console.log(`Running: ${dcrawCmd}`);
    
    const { stdout, stderr } = await execPromise(dcrawCmd, {
      cwd: path.dirname(fullFilePath),
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for stderr
    });
    
    if (stderr) {
      console.log(`dcraw output: ${stderr}`);
    }
    
    // dcraw -T creates a .tiff file with the same base name
    const dcrawOutputTiff = fullFilePath.replace(/\.[^.]+$/, '.tiff');
    
    // Check if TIFF was created and has content
    if (!fs.existsSync(dcrawOutputTiff)) {
      throw new Error('dcraw failed to create TIFF output file');
    }
    
    const tiffStats = fs.statSync(dcrawOutputTiff);
    console.log(`TIFF file created: ${(tiffStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    if (tiffStats.size === 0) {
      throw new Error('dcraw created empty TIFF file');
    }
    
    // Move TIFF to expected location if different
    if (dcrawOutputTiff !== tiffPath) {
      fs.renameSync(dcrawOutputTiff, tiffPath);
    }
    
    // Convert TIFF to PNG using sharp
    const metadata = await sharp(tiffPath).metadata();
    console.log(`RAW image full resolution: ${metadata.width}x${metadata.height}`);
    
    await sharp(tiffPath)
      .png({
        quality: 100,
        compressionLevel: 9
      })
      .toFile(pngFilePath);
    
    const pngStats = fs.statSync(pngFilePath);
    console.log(`PNG created: ${(pngStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Clean up TIFF file
    fs.unlinkSync(tiffPath);
    console.log('Cleaned up temporary TIFF file');
    
    return metadata;
  } catch (error) {
    console.error(`Error converting RAW file with dcraw: ${error.message}`);
    console.error(error.stack);
    // Fallback to sharp (will extract thumbnail)
    console.log('Falling back to sharp conversion (may extract thumbnail)');
    return await convertWithSharp(fullFilePath, pngFilePath);
  }
}

async function convertWithImageJS(fullFilePath, pngFilePath) {
  const image = await Image.load(fullFilePath);
  await image.save(pngFilePath); // Save as PNG
  return {
      width: image.width,
      height: image.height
  };
}

/**
 * Describes the content of an image.
 * @param {string} imagePath - The path to the image file.
 * @param {string} [prompt="What is in this picture?"] - The prompt for the description.
 * @returns {Promise<string | CustomError>} - A promise that resolves to the description or an error.
 */
async function describe(imageContent, prompt = "What is in this picture?") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000); // Set timeout to 10 seconds

  try {
      const data = {
          model: "llava",
          prompt: prompt,
          stream: false,
          images: [imageContent],
      };

      const generateUrl = `${process.env.OLLAMA_BASE_PATH}/api/generate`;
      console.log(`generateUrl: ${generateUrl}`);
      const response = await fetch(generateUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      clearTimeout(timeoutId); // Clear the timeout if the request completes

      if (!response.ok) {
          const errorMessage = await response.text();
          throw new CustomError(`Error: ${errorMessage}`);
      }

      const result = await response.json();
      return result.response; // Adjust based on the actual response structure
  } catch (error) {
      console.error('Error in describe function:', error);
      return new CustomError(error.message);
  }
}

// Update the base64 conversion section using streams
const streamToBase64 = async (filePath) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = fs.createReadStream(filePath, {
        highWaterMark: 1024 * 1024 // Read in 1MB chunks
      });
  
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        // Clear references
        chunks.length = 0;
        resolve(base64);
      });
      stream.on('error', reject);
    });
  };
  
async function asImage({ fullFilePath = "", filename = "" }) {
  let extension;
  let baseName;
  let imageMetadata;
  let finalFilePath;

  try {
        logMemoryUsage('Start Image Processing');
        
        // Get file info
        extension = filename.split('.').pop().toLowerCase();
        baseName = filename.substring(1, filename.lastIndexOf('.'));
        
        // Create destination filename
        const dirPath = path.dirname(fullFilePath);   
        const newFileName = path.basename(filename, `.${extension}`) + '.png';
        const pngFilePath = path.join(dirPath, newFileName);

        logMemoryUsage('Before Image Conversion');

        // Only proceed with conversion if not already PNG
            // Check if the original file is PNG
        if (extension === 'png') {
            console.log('File is already PNG, using as is...');
            // Use the original file path without conversion
            finalFilePath = fullFilePath;
            imageMetadata = await sharp(fullFilePath).metadata();
        } else {
            // List of RAW formats that need dcraw
            const rawFormats = ['nef', 'cr2', 'crw', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'raf'];
            
            // Convert based on file type
            if (extension.toLowerCase() === 'tga') {
                    console.log('Converting TGA to PNG using custom tga2png function...');
                    imageMetadata = await tga2png(fullFilePath, pngFilePath);
            } else if (rawFormats.includes(extension.toLowerCase())) {
                    console.log(`Detected RAW format (.${extension}), using dcraw for full resolution conversion...`);
                    imageMetadata = await convertRawWithDcraw(fullFilePath, pngFilePath);
            } else {
                    try {
                        await sharp(fullFilePath).metadata(); // This will throw an error if the image is corrupted
                        console.log(`Image is valid: ${fullFilePath}`);
                        console.log('Converting to PNG using Sharp...');
                        imageMetadata = await convertWithSharp(fullFilePath, pngFilePath);
                    } catch (error) {
                        console.error(`Invalid image: ${fullFilePath}`);
                        return {
                            success: false,
                            reason: `Invalid image: ${fullFilePath}.`,
                            documents: [],
                        };
                    }
            }
            console.log(`Converted and saved as PNG: ${pngFilePath}`);
            trashFile(fullFilePath);
            finalFilePath = pngFilePath;
        }

        logMemoryUsage('After Image Conversion');

        // Read the final file and convert to base64
        // const imageBuffer = fs.readFileSync(finalFilePath);
        // const base64Image = imageBuffer.toString('base64');
        const base64Image = await streamToBase64(finalFilePath);
        logMemoryUsage('After Base64 Conversion');

        console.log(`Successfully processed image:`, {
            originalFormat: extension,
            width: imageMetadata.width,
            height: imageMetadata.height,
            base64Length: base64Image.length,
            wasConverted: extension.toLowerCase() !== 'png'
        });

        if (!base64Image?.length) {
            console.error(`Resulting base64 content was empty for ${filename}.`);
            trashFile(finalFilePath);
            return {
                success: false,
                reason: `No image content found in ${filename}.`,
                documents: [],
            };
        }

        // Build basic metadata description
        const descriptionParts = [];
        descriptionParts.push(`The photo has the title "${finalFilePath}"`);
        if (imageMetadata.dateTime) {
          descriptionParts.push(`and was created at ${imageMetadata.dateTime}`);
        }
        const metadataParts = [];
        if (imageMetadata.camera) metadataParts.push(`Camera: ${imageMetadata.camera}`);
        if (imageMetadata.width && imageMetadata.height) {
          metadataParts.push(`Dimensions: ${imageMetadata.width}x${imageMetadata.height}`);
        }
        if (metadataParts.length > 0) {
          descriptionParts.push(`. ${metadataParts.join(', ')}`);
        }
        const metadataDescription = descriptionParts.join(' ') + '.';

        // Prepare the data - the actual embedding mode will be decided by the server
        const pageContent = base64Image;
        const description = metadataDescription;
        const embeddingMode = 'server-decided'; // Mode will be determined during vectorization
        
        // Generate BlurHash for image preview
        let blurHash = null;
        try {
            const { calculateBlurHash } = require('../../utils/blurhash');
            blurHash = await calculateBlurHash(finalFilePath);
            if (blurHash) {
                console.log(`Generated BlurHash for ${filename}`);
            }
        } catch (error) {
            console.warn(`BlurHash generation failed or not available: ${error.message}`);
        }
        
        console.log(`-- Working ${filename} --`);
        const destinationPath = "/app/server/storage/documents/custom-documents";
        let id = v4();
        const destinationFilename = `${slugify(filename)}-${id}`; ;
        const destinationFilePath = path.resolve(destinationPath, destinationFilename) + ".json";
        const data = {
            id: id,
            url: "file://" + finalFilePath,
            customDocument: destinationFilePath,
            title: finalFilePath,
            docAuthor: "Unknown",
            description: description,
            docSource: "an image file uploaded by the user.",
            chunkSource: "image-upload",
            published: createdDate(finalFilePath),
            wordCount: embeddingMode === 'multimodal-embedder' ? 0 : pageContent.split(" ").length,
            pageContent: pageContent,
            token_count_estimate: tokenizeString(pageContent).length,
            extension: extension,
            fileType: "image",
            embeddingMode: embeddingMode, // Track which embedding strategy was used
            imageBase64: base64Image, // Always keep original image reference
            ...(blurHash && { blurHash }), // Add blurHash if available
        };

        logMemoryUsage('Before Writing Document');
            
        const document = await writeImageToServer(
            data,
            destinationFilename,
            destinationPath
        );

        logMemoryUsage('End Image Processing');
        return { success: true, reason: null, documents: [document] };
    }catch (err) {
        console.error("Error processing image:", {
            error: err.message,
            file: filename,
            originalFormat: extension
        });
        throw err;
    } finally {
        // Cleanup
        imageMetadata = null;
        if (global.gc) global.gc();
    }
}

module.exports = asImage;
