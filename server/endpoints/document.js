const { Document } = require("../models/documents");
const { normalizePath, documentsPath, isWithin } = require("../utils/files");
const { reqBody } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const fs = require("fs");
const path = require("path");

function documentEndpoints(app) {
  if (!app) return;
  app.post(
    "/document/create-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const storagePath = path.join(documentsPath, normalizePath(name));
        if (!isWithin(path.resolve(documentsPath), path.resolve(storagePath)))
          throw new Error("Invalid folder name.");

        if (fs.existsSync(storagePath)) {
          response.status(500).json({
            success: false,
            message: "Folder by that name already exists",
          });
          return;
        }

        fs.mkdirSync(storagePath, { recursive: true });
        response.status(200).json({ success: true, message: null });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to create folder: ${e.message} `,
        });
      }
    }
  );

  app.post(
    "/document/move-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { files } = reqBody(request);
        const docpaths = files.map(({ from }) => from);
        const documents = await Document.where({ docpath: { in: docpaths } });

        const embeddedFiles = documents.map((doc) => doc.docpath);
        const moveableFiles = files.filter(
          ({ from }) => !embeddedFiles.includes(from)
        );

        const movePromises = moveableFiles.map(({ from, to }) => {
          const sourcePath = path.join(documentsPath, normalizePath(from));
          const destinationPath = path.join(documentsPath, normalizePath(to));

          return new Promise((resolve, reject) => {
            if (
              !isWithin(documentsPath, sourcePath) ||
              !isWithin(documentsPath, destinationPath)
            )
              return reject("Invalid file location");

            fs.rename(sourcePath, destinationPath, async (err) => {
              if (err) {
                console.error(`Error moving file ${from} to ${to}:`, err);
                return reject(err);
              }

              // Keep Redis file metadata and folder indexes in sync
              try {
                const { redisHelper, REDIS_KEYS, redis } = require("../utils/files/redis");
                const srcFolder = path.dirname(from);
                const srcFile = path.basename(from);
                const dstFolder = path.dirname(to);
                const dstFile = path.basename(to);

                // Attempt to move per-file metadata if it exists
                try {
                  const metadata = await redisHelper.getFileMetadata(srcFolder, srcFile);
                  if (metadata) {
                    await redisHelper.saveFileMetadata(dstFolder, dstFile, metadata);
                    // Remove old metadata key
                    try {
                      await redis.del(REDIS_KEYS.FILE_METADATA + `${srcFolder}:${srcFile}`);
                    } catch (e) {
                      console.warn('Failed to delete old file metadata key in Redis:', e.message);
                    }
                  }
                } catch (e) {
                  console.warn('Failed to move file metadata in Redis:', e.message);
                }

                // Update folder indexes
                try {
                  await redisHelper.removeFileFromFolder(srcFolder, srcFile);
                } catch (e) {
                  console.warn('Failed to remove file from source folder index in Redis:', e.message);
                }

                try {
                  // Use minimal metadata entry for folder index to avoid loading file content
                  const fileEntry = { name: dstFile, type: 'file' };
                  await redisHelper.addFileToFolder(dstFolder, fileEntry);
                } catch (e) {
                  console.warn('Failed to add file to destination folder index in Redis:', e.message);
                }
              } catch (e) {
                console.warn('Redis sync skipped due to error:', e.message);
              }

              resolve();
            });
          });
        });

        Promise.all(movePromises)
          .then(() => {
            const unmovableCount = files.length - moveableFiles.length;
            if (unmovableCount > 0) {
              response.status(200).json({
                success: true,
                message: `${unmovableCount}/${files.length} files not moved. Unembed them from all workspaces.`,
              });
            } else {
              response.status(200).json({
                success: true,
                message: null,
              });
            }
          })
          .catch((err) => {
            console.error("Error moving files:", err);
            response
              .status(500)
              .json({ success: false, message: "Failed to move some files." });
          });
      } catch (e) {
        console.error(e);
        response
          .status(500)
          .json({ success: false, message: "Failed to move files." });
      }
    }
  );
}

module.exports = { documentEndpoints };
