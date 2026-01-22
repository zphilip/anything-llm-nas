const { encode } = require('blurhash');
const sharp = require('sharp');

/**
 * Calculate BlurHash for an image file
 * @param {string} imagePath - Path to the image file
 * @param {number} componentX - BlurHash X components (default: 4)
 * @param {number} componentY - BlurHash Y components (default: 3)
 * @returns {Promise<string>} - BlurHash string
 */
async function calculateBlurHash(imagePath, componentX = 4, componentY = 3) {
  try {
    // Resize image to small size for BlurHash calculation (faster)
    const image = await sharp(imagePath)
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = image;
    
    // Calculate BlurHash
    const blurHash = encode(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      componentX,
      componentY
    );

    return blurHash;
  } catch (error) {
    console.error(`Error calculating BlurHash: ${error.message}`);
    throw error;
  }
}

module.exports = {
  calculateBlurHash,
};
