/**
 * Utility functions for Image Search
 */

/**
 * Format file size in human readable format
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

/**
 * Format distance score for display
 * @param {number} distance
 * @param {string} metric
 * @returns {string}
 */
export function formatDistance(distance, metric = "cosine") {
  if (distance === null || distance === undefined) return "N/A";
  
  const formatted = distance.toFixed(4);
  
  switch (metric) {
    case "cosine":
      return `${formatted} (higher = more similar)`;
    case "l2":
    case "euclidean":
      return `${formatted} (lower = more similar)`;
    case "dot":
      return `${formatted}`;
    default:
      return formatted;
  }
}

/**
 * Truncate text to max length
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(text, maxLength = 50) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

/**
 * Get file extension from filename
 * @param {string} filename
 * @returns {string}
 */
export function getFileExtension(filename) {
  if (!filename) return "";
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}
