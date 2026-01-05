const sharp = require('sharp');
const { encode } = require('blurhash');

/**
 * Calculate the BlurHash for a given image path
 * BlurHash is a compact representation of a placeholder for an image
 * Useful for displaying image placeholders while the actual image loads
 * 
 * @param {string} imagePath - Path to the image file
 * @param {number} componentX - Number of components in X direction (default: 4)
 * @param {number} componentY - Number of components in Y direction (default: 3)
 * @returns {Promise<string|null>} - BlurHash string or null on error
 */
async function calculateBlurHash(imagePath, componentX = 4, componentY = 3) {
  try {
    // Read the image using sharp and resize to a small size for efficient encoding
    const imageBuffer = await sharp(imagePath)
      .resize(32, 32, { fit: 'inside' }) // Resize to 32x32 pixels
      .ensureAlpha()  // Ensure alpha channel exists
      .raw()          // Get raw pixel data
      .toBuffer({ resolveWithObject: true });
    
    // Extract image data and metadata
    const { data, info } = imageBuffer;
    const { width, height } = info;
    
    // Convert the raw pixel data to Uint8ClampedArray
    const pixels = new Uint8ClampedArray(data);
    
    // Generate the BlurHash with specified components
    const blurHash = encode(pixels, width, height, componentX, componentY);
    
    return blurHash;
  } catch (error) {
    console.error(`Error calculating blurhash for ${imagePath}:`, error);
    return null;
  }
}

/**
 * Validate if a string is a valid BlurHash
 * @param {string} hash - The hash string to validate
 * @returns {boolean} - True if valid BlurHash format
 */
function isValidBlurHash(hash) {
  if (!hash || typeof hash !== 'string') return false;
  
  // BlurHash should be at least 6 characters
  if (hash.length < 6) return false;
  
  // First character encodes the number of components
  const sizeFlag = hash.charCodeAt(0);
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  
  // Expected length based on components
  const expectedLength = 4 + 2 * numX * numY;
  
  return hash.length === expectedLength;
}

module.exports = {
  calculateBlurHash,
  isValidBlurHash,
};
