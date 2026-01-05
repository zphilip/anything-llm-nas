const API_BASE = process.env.VITE_API_BASE || "/api";
const WATCH_DIRECTORY = require("path").resolve(__dirname, "../hotdir");

const ACCEPTED_MIMES = {
  "text/plain": [".txt", ".md", ".org", ".adoc", ".rst"],
  "text/html": [".html"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  // TODO: Create asDoc.js that works for standard MS Word files.
  // "application/msword": [".doc"],

  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    ".pptx",
  ],

  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],

  "application/vnd.oasis.opendocument.text": [".odt"],
  "application/vnd.oasis.opendocument.presentation": [".odp"],

  "application/pdf": [".pdf"],
  "application/mbox": [".mbox"],

  "audio/wav": [".wav"],
  "audio/mpeg": [".mp3"],

  "video/mp4": [".mp4"],
  "video/mpeg": [".mpeg"],
  "application/epub+zip": [".epub"],
  
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/jpg": [".jpg"],
  "image/webp": [".webp"],
  
  // RAW camera formats (optional - requires additional sharp plugins)
  "image/x-nikon-nef": [".nef"],
  "image/x-canon-cr2": [".cr2"],
  "image/x-sony-arw": [".arw"],
  "image/x-olympus-orf": [".orf"],
  "image/x-panasonic-rw2": [".rw2"],
  "image/x-fuji-raf": [".raf"],
  "image/x-adobe-dng": [".dng"],
  "image/x-pentax-pef": [".pef"],
  "image/x-samsung-srw": [".srw"],
  "image/tga": [".tga"],
};

const SUPPORTED_FILETYPE_CONVERTERS = {
  ".txt": "./convert/asTxt.js",
  ".md": "./convert/asTxt.js",
  ".org": "./convert/asTxt.js",
  ".adoc": "./convert/asTxt.js",
  ".rst": "./convert/asTxt.js",
  ".csv": "./convert/asTxt.js",
  ".json": "./convert/asTxt.js",

  ".html": "./convert/asTxt.js",
  ".pdf": "./convert/asPDF/index.js",

  ".docx": "./convert/asDocx.js",
  // TODO: Create asDoc.js that works for standard MS Word files.
  // ".doc": "./convert/asDoc.js",

  ".pptx": "./convert/asOfficeMime.js",

  ".odt": "./convert/asOfficeMime.js",
  ".odp": "./convert/asOfficeMime.js",

  ".xlsx": "./convert/asXlsx.js",

  ".mbox": "./convert/asMbox.js",

  ".epub": "./convert/asEPub.js",

  ".mp3": "./convert/asAudio.js",
  ".wav": "./convert/asAudio.js",
  ".mp4": "./convert/asAudio.js",
  ".mpeg": "./convert/asAudio.js",

  ".png": "./convert/asImage.js",
  ".jpg": "./convert/asImage.js",
  ".jpeg": "./convert/asImage.js",
  ".webp": "./convert/asImage.js",
  
  // RAW formats (require additional dependencies)
  ".nef": "./convert/asImage.js",
  ".cr2": "./convert/asImage.js",
  ".arw": "./convert/asImage.js",
  ".orf": "./convert/asImage.js",
  ".rw2": "./convert/asImage.js",
  ".raf": "./convert/asImage.js",
  ".dng": "./convert/asImage.js",
  ".pef": "./convert/asImage.js",
  ".srw": "./convert/asImage.js",
  ".tga": "./convert/asImage.js",
};

module.exports = {
  API_BASE,
  SUPPORTED_FILETYPE_CONVERTERS,
  WATCH_DIRECTORY,
  ACCEPTED_MIMES,
};
