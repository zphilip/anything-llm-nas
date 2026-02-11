process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();
const { viewLocalFiles, normalizePath, isWithin, purgeEntireVectorCache } = require("../utils/files");
const { purgeDocument, purgeFolder } = require("../utils/files/purgeDocument");
const { getVectorDbClass } = require("../utils/helpers");
const { updateENV, dumpENV } = require("../utils/helpers/updateENV");
const {
  reqBody,
  makeJWT,
  userFromSession,
  multiUserMode,
  queryParams,
} = require("../utils/http");
const { handleAssetUpload, handlePfpUpload } = require("../utils/files/multer");
const { v4 } = require("uuid");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const fs = require("fs");
const path = require("path");
const {
  getDefaultFilename,
  determineLogoFilepath,
  fetchLogo,
  validFilename,
  renameLogoFile,
  removeCustomLogo,
  LOGO_FILENAME,
  isDefaultFilename,
} = require("../utils/files/logo");
const { Telemetry } = require("../models/telemetry");
const { WelcomeMessages } = require("../models/welcomeMessages");
const { ApiKey } = require("../models/apiKeys");
const { getCustomModels } = require("../utils/helpers/customModels");
const { WorkspaceChats } = require("../models/workspaceChats");
const {
  flexUserRoleValid,
  ROLES,
  isMultiUserSetup,
} = require("../utils/middleware/multiUserProtected");
const { fetchPfp, determinePfpFilepath } = require("../utils/files/pfp");
const { exportChatsAsType } = require("../utils/helpers/chat/convertTo");
const { EventLogs } = require("../models/eventLogs");
const { CollectorApi } = require("../utils/collectorApi");
const {
  recoverAccount,
  resetPassword,
  generateRecoveryCodes,
} = require("../utils/PasswordRecovery");
const { SlashCommandPresets } = require("../models/slashCommandsPresets");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const {
  chatHistoryViewable,
} = require("../utils/middleware/chatHistoryViewable");
const {
  simpleSSOEnabled,
  simpleSSOLoginDisabled,
} = require("../utils/middleware/simpleSSOEnabled");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { SystemPromptVariables } = require("../models/systemPromptVariables");
const { VALID_COMMANDS } = require("../utils/chats");

function systemEndpoints(app) {
  if (!app) return;

  app.get("/ping", (_, response) => {
    response.status(200).json({ online: true });
  });

  app.get("/migrate", async (_, response) => {
    response.sendStatus(200);
  });

  app.get("/env-dump", async (_, response) => {
    if (process.env.NODE_ENV !== "production")
      return response.sendStatus(200).end();
    dumpENV();
    response.sendStatus(200).end();
  });

  app.get("/setup-complete", async (_, response) => {
    try {
      const results = await SystemSettings.currentSettings();
      response.status(200).json({ results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/check-token",
    [validatedRequest],
    async (request, response) => {
      try {
        if (multiUserMode(response)) {
          const user = await userFromSession(request, response);
          if (!user || user.suspended) {
            response.sendStatus(403).end();
            return;
          }

          response.sendStatus(200).end();
          return;
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Refreshes the user object from the session from a provided token.
   * This does not refresh the token itself - if that is expired or invalid, the user will be logged out.
   * This simply keeps the user object in sync with the database over the course of the session.
   * @returns {Promise<{success: boolean, user: Object | null, message: string | null}>}
   */
  app.get(
    "/system/refresh-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!multiUserMode(response))
          return response
            .status(200)
            .json({ success: true, user: null, message: null });

        const user = await userFromSession(request, response);
        if (!user)
          return response.status(200).json({
            success: false,
            user: null,
            message: "Session expired or invalid.",
          });

        if (user.suspended)
          return response.status(200).json({
            success: false,
            user: null,
            message: "User is suspended.",
          });

        return response.status(200).json({
          success: true,
          user: User.filterFields(user),
          message: null,
        });
      } catch (e) {
        return response.status(500).json({
          success: false,
          user: null,
          message: e.message,
        });
      }
    }
  );

  app.post("/request-token", async (request, response) => {
    try {
      const bcrypt = require("bcryptjs");

      if (await SystemSettings.isMultiUserMode()) {
        if (simpleSSOLoginDisabled()) {
          response.status(403).json({
            user: null,
            valid: false,
            token: null,
            message:
              "[005] Login via credentials has been disabled by the administrator.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const existingUser = await User._get({ username: String(username) });

        if (!existingUser) {
          await EventLogs.logEvent(
            "failed_login_invalid_username",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[001] Invalid login credentials.",
          });
          return;
        }

        if (!bcrypt.compareSync(String(password), existingUser.password)) {
          await EventLogs.logEvent(
            "failed_login_invalid_password",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[002] Invalid login credentials.",
          });
          return;
        }

        if (existingUser.suspended) {
          await EventLogs.logEvent(
            "failed_login_account_suspended",
            {
              ip: request.ip || "Unknown IP",
              username: username || "Unknown user",
            },
            existingUser?.id
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[004] Account suspended by admin.",
          });
          return;
        }

        await Telemetry.sendTelemetry(
          "login_event",
          { multiUserMode: false },
          existingUser?.id
        );

        await EventLogs.logEvent(
          "login_event",
          {
            ip: request.ip || "Unknown IP",
            username: existingUser.username || "Unknown user",
          },
          existingUser?.id
        );

        // Generate a session token for the user then check if they have seen the recovery codes
        // and if not, generate recovery codes and return them to the frontend.
        const sessionToken = makeJWT(
          { id: existingUser.id, username: existingUser.username },
          process.env.JWT_EXPIRY
        );
        if (!existingUser.seen_recovery_codes) {
          const plainTextCodes = await generateRecoveryCodes(existingUser.id);
          response.status(200).json({
            valid: true,
            user: User.filterFields(existingUser),
            token: sessionToken,
            message: null,
            recoveryCodes: plainTextCodes,
          });
          return;
        }

        response.status(200).json({
          valid: true,
          user: User.filterFields(existingUser),
          token: sessionToken,
          message: null,
        });
        return;
      } else {
        const { password } = reqBody(request);
        if (
          !bcrypt.compareSync(
            password,
            bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
          )
        ) {
          await EventLogs.logEvent("failed_login_invalid_password", {
            ip: request.ip || "Unknown IP",
            multiUserMode: false,
          });
          response.status(401).json({
            valid: false,
            token: null,
            message: "[003] Invalid password provided",
          });
          return;
        }

        await Telemetry.sendTelemetry("login_event", { multiUserMode: false });
        await EventLogs.logEvent("login_event", {
          ip: request.ip || "Unknown IP",
          multiUserMode: false,
        });
        response.status(200).json({
          valid: true,
          token: makeJWT(
            { p: new EncryptionManager().encrypt(password) },
            process.env.JWT_EXPIRY
          ),
          message: null,
        });
      }
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/request-token/sso/simple",
    [simpleSSOEnabled],
    async (request, response) => {
      const { token: tempAuthToken } = request.query;
      const { sessionToken, token, error } =
        await TemporaryAuthToken.validate(tempAuthToken);

      if (error) {
        await EventLogs.logEvent("failed_login_invalid_temporary_auth_token", {
          ip: request.ip || "Unknown IP",
          multiUserMode: true,
        });
        return response.status(401).json({
          valid: false,
          token: null,
          message: `[001] An error occurred while validating the token: ${error}`,
        });
      }

      await Telemetry.sendTelemetry(
        "login_event",
        { multiUserMode: true },
        token.user.id
      );
      await EventLogs.logEvent(
        "login_event",
        {
          ip: request.ip || "Unknown IP",
          username: token.user.username || "Unknown user",
        },
        token.user.id
      );

      response.status(200).json({
        valid: true,
        user: User.filterFields(token.user),
        token: sessionToken,
        message: null,
      });
    }
  );

  app.post(
    "/system/recover-account",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, recoveryCodes } = reqBody(request);
        const { success, resetToken, error } = await recoverAccount(
          username,
          recoveryCodes
        );

        if (success) {
          response.status(200).json({ success, resetToken });
        } else {
          response.status(400).json({ success, message: error });
        }
      } catch (error) {
        console.error("Error recovering account:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/reset-password",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { token, newPassword, confirmPassword } = reqBody(request);
        const { success, message, error } = await resetPassword(
          token,
          newPassword,
          confirmPassword
        );

        if (success) {
          response.status(200).json({ success, message });
        } else {
          response.status(400).json({ success, error });
        }
      } catch (error) {
        console.error("Error resetting password:", error);
        response.status(500).json({ success: false, message: error.message });
      }
    }
  );

  app.get(
    "/system/system-vectors",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const VectorDb = getVectorDbClass();
        const vectorCount = !!query.slug
          ? await VectorDb.namespaceCount(query.slug)
          : await VectorDb.totalVectors();
        response.status(200).json({ vectorCount });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-document",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-documents",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { names } = reqBody(request);
        for await (const name of names) await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeFolder(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/clear-vector-cache",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        console.log('🗑️ Clearing entire vector cache...');
        purgeEntireVectorCache();
        console.log('✅ Vector cache cleared successfully');
        response.status(200).json({ 
          success: true, 
          message: "Vector cache cleared. Documents will be re-embedded on next addition." 
        });
      } catch (e) {
        console.error('❌ Error clearing vector cache:', e.message, e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/system/local-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        // Check for rescan parameter (explicit check for string 'true')
        const rescan = request.query.rescan === 'true';
        console.log('📂 Fetching local files, rescan:', rescan);
        
        const localFiles = await viewLocalFiles(rescan);
        
        // Save to Redis if available
        if (global.redisHelper) {
          try {
            await global.redisHelper.saveDirectoryData(localFiles);
            console.log('✅ Directory data saved to Redis');
          } catch (redisError) {
            console.warn('⚠️ Failed to save to Redis:', redisError.message);
          }
        }
        
        // Avoid sending extremely large payloads which can crash the server.
        // Deep-clean large fields from the structure (pageContent, imageBase64)
        function cleanLocalFiles(obj) {
          if (!obj || typeof obj !== 'object') return obj;
          if (Array.isArray(obj)) return obj.map(cleanLocalFiles);
          const out = {};
          for (const [k, v] of Object.entries(obj)) {
            if (k === 'pageContent' || k === 'imageBase64') continue; // strip large blobs
            if (k === 'items' && Array.isArray(v)) {
              out.items = v.map(item => {
                // shallow copy but strip large fields on each item
                const copy = { ...item };
                delete copy.pageContent;
                delete copy.imageBase64;
                // ensure nested items are cleaned
                if (Array.isArray(copy.items)) copy.items = copy.items.map(cleanLocalFiles);
                return copy;
              });
              continue;
            }
            out[k] = (typeof v === 'object') ? cleanLocalFiles(v) : v;
          }
          return out;
        }

        const MAX_LOCALFILES_JSON_BYTES = parseInt(process.env.MAX_LOCALFILES_JSON_BYTES || String(5 * 1024 * 1024)); // 5MB default
        try {
          const cleaned = cleanLocalFiles(localFiles);
          const jsonStr = JSON.stringify(cleaned);
          console.log('[/system/local-files] JSON size bytes:', jsonStr.length);
          console.log('[/system/local-files] MAX_LOCALFILES_JSON_BYTES:', MAX_LOCALFILES_JSON_BYTES);
          
          // Calculate total file count
          console.log('[/system/local-files] cleaned.items:', cleaned.items?.length);
          const totalFiles = (cleaned.items || []).reduce((total, folder) => {
            const folderFileCount = (folder.items || []).length;
            console.log(`[/system/local-files] Folder ${folder.name}: ${folderFileCount} files`);
            return total + folderFileCount;
          }, 0);
          console.log('[/system/local-files] Total files calculated:', totalFiles);
          
          if (jsonStr.length > MAX_LOCALFILES_JSON_BYTES) {
            // Build a small summary instead of returning the full structure
            const folderSummaries = (cleaned.items || []).map((f) => ({
              name: f.name,
              itemCount: (f.items || []).length,
            }));
            console.warn('[/system/local-files] Payload too large, returning summary. Folder count:', folderSummaries.length);
            if (folderSummaries.length > 0) {
              console.warn('[/system/local-files] First summary folder:', folderSummaries[0]);
            }
            response.status(200).json({
              warning: 'localFiles payload too large after cleaning, returning summary',
              folderCount: folderSummaries.length,
              totalFiles,
              folders: folderSummaries,
            });
          } else {
            response.status(200).json({ 
              localFiles: cleaned,
              totalFiles 
            });
          }
        } catch (err) {
          console.warn('Failed to stringify cleaned localFiles, returning summary instead:', err && err.message);
          const folderSummaries = (localFiles.items || []).map((f) => ({
            name: f.name,
            itemCount: (f.items || []).length,
          }));
          const totalFiles = folderSummaries.reduce((s, f) => s + f.itemCount, 0);
          response.status(200).json({
            warning: 'localFiles payload could not be serialized, returning summary',
            folderCount: folderSummaries.length,
            totalFiles,
            folders: folderSummaries,
          });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/refresh-folder-cache",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { folder } = reqBody(request);
        if (!folder) return response.status(400).json({ success: false, error: 'folder required' });
        const { refreshFolderCache } = require('../utils/files');
        try {
          const subdocs = await refreshFolderCache(folder);
          return response.status(200).json({ success: true, folder: folder, items: (subdocs.items || []).length });
        } catch (err) {
          console.error('Failed to refresh folder cache:', err && err.message ? err.message : err);
          return response.status(500).json({ success: false, error: err && err.message ? err.message : 'failed' });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // Get documents by folder name (for lazy loading large directories)
  app.get(
    "/system/local-files/:folderName",
    [validatedRequest],
    async (request, response) => {
      try {
        const { folderName } = request.params;
        if (!folderName) {
          return response.status(400).json({ 
            success: false, 
            error: 'Folder name required' 
          });
        }

        const { getDocumentsByFolder } = require('../utils/files');
        const result = await getDocumentsByFolder(folderName);
        
        if (result.code !== 200) {
          return response.status(result.code).json({
            success: false,
            error: result.error
          });
        }

        return response.status(200).json({
          success: true,
          folder: result.folder,
          documents: result.documents,
          totalFiles: result.documents.length
        });
      } catch (e) {
        console.error('[/system/local-files/:folder] Error:', e.message, e);
        response.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  );

  // Start a new incremental resync session
  app.post(
    "/system/start-resync",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { batchSize, forceRefresh, folderFilter } = reqBody(request);
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');
        const { incrementalResync } = require('../utils/files');

        try {
          const session = resyncSessionManager.createSession({
            batchSize: batchSize || 20,
            forceRefresh: forceRefresh || false,
            folderFilter: folderFilter || null,
          });

          // Start resync in background
          incrementalResync(session).catch(err => {
            console.error('Resync failed:', err);
          });

          return response.status(200).json({ 
            success: true, 
            sessionId: session.sessionId,
            status: session.getStatus()
          });
        } catch (err) {
          return response.status(400).json({ 
            success: false, 
            error: err.message 
          });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // Get resync session status
  app.get(
    "/system/resync-status/:sessionId?",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');

        if (sessionId) {
          const session = resyncSessionManager.getSession(sessionId);
          if (!session) {
            return response.status(404).json({ success: false, error: 'Session not found' });
          }
          return response.status(200).json({ success: true, status: session.getStatus() });
        } else {
          // Return active session or all sessions
          const activeSession = resyncSessionManager.getActiveSession();
          return response.status(200).json({ 
            success: true, 
            activeSession: activeSession ? activeSession.getStatus() : null,
            allSessions: resyncSessionManager.getAllSessions()
          });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // Pause active resync session
  app.post(
    "/system/pause-resync/:sessionId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');
        
        const session = resyncSessionManager.getSession(sessionId);
        if (!session) {
          return response.status(404).json({ success: false, error: 'Session not found' });
        }

        session.pause();
        return response.status(200).json({ 
          success: true, 
          status: session.getStatus() 
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // Resume paused resync session
  app.post(
    "/system/resume-resync/:sessionId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');
        
        const session = resyncSessionManager.getSession(sessionId);
        if (!session) {
          return response.status(404).json({ success: false, error: 'Session not found' });
        }

        if (session.status !== 'paused') {
          return response.status(400).json({ success: false, error: 'Session is not paused' });
        }

        session.resume();
        
        // Continue the resync from where it left off
        const { incrementalResync } = require('../utils/files');
        incrementalResync(session).catch(err => {
          console.error('Resume resync failed:', err);
          session.fail(err);
        });

        return response.status(200).json({ 
          success: true, 
          status: session.getStatus() 
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // Cancel active resync session
  app.post(
    "/system/cancel-resync/:sessionId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');
        
        const session = resyncSessionManager.getSession(sessionId);
        if (!session) {
          return response.status(404).json({ success: false, error: 'Session not found' });
        }

        session.cancel();
        return response.status(200).json({ 
          success: true, 
          status: session.getStatus() 
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // SSE endpoint for real-time resync progress
  app.get(
    "/system/resync-progress/:sessionId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { resyncSessionManager } = require('../utils/files/ResyncSessionManager');
        
        const session = resyncSessionManager.getSession(sessionId);
        if (!session) {
          return response.status(404).json({ success: false, error: 'Session not found' });
        }

        // Set up SSE
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        // Send initial status
        response.write(`data: ${JSON.stringify({ type: 'status', data: session.getStatus() })}\n\n`);

        // Listen for progress events
        const onProgress = (status) => {
          response.write(`data: ${JSON.stringify({ type: 'progress', data: status })}\n\n`);
        };

        const onBatchComplete = (data) => {
          response.write(`data: ${JSON.stringify({ type: 'batchComplete', data })}\n\n`);
        };

        const onComplete = (status) => {
          response.write(`data: ${JSON.stringify({ type: 'complete', data: status })}\n\n`);
          cleanup();
        };

        const onFailed = (status) => {
          response.write(`data: ${JSON.stringify({ type: 'failed', data: status })}\n\n`);
          cleanup();
        };

        const onPaused = (status) => {
          response.write(`data: ${JSON.stringify({ type: 'paused', data: status })}\n\n`);
        };

        const onCancelled = (status) => {
          response.write(`data: ${JSON.stringify({ type: 'cancelled', data: status })}\n\n`);
          cleanup();
        };

        session.on('progress', onProgress);
        session.on('batchComplete', onBatchComplete);
        session.on('complete', onComplete);
        session.on('failed', onFailed);
        session.on('paused', onPaused);
        session.on('cancelled', onCancelled);

        const cleanup = () => {
          session.off('progress', onProgress);
          session.off('batchComplete', onBatchComplete);
          session.off('complete', onComplete);
          session.off('failed', onFailed);
          session.off('paused', onPaused);
          session.off('cancelled', onCancelled);
        };

        // Handle client disconnect
        request.on('close', () => {
          cleanup();
        });

      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/cache-status",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { documentsPath } = require('../utils/files');
        const { redisHelper } = require('../utils/files/redis');
        const folders = fs.existsSync(documentsPath)
          ? fs.readdirSync(documentsPath).filter((f) => {
              const folderPath = path.resolve(documentsPath, f);
              return fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory();
            })
          : [];

        const results = [];
        for (const folder of folders) {
          let redisPresent = false;
          let redisCount = 0;
          try {
            const fd = await redisHelper.getFolderData(folder);
            if (fd && Array.isArray(fd.items)) {
              redisPresent = true;
              redisCount = fd.items.length;
            }
          } catch (err) {
            // ignore
          }

          const diskCachePath = path.join(__dirname, '..', 'storage', 'cache', 'folders', `${folder}.json`);
          let diskPresent = false;
          let diskCount = 0;
          let diskSize = 0;
          try {
            if (fs.existsSync(diskCachePath)) {
              diskPresent = true;
              const stat = fs.statSync(diskCachePath);
              diskSize = stat.size;
              try {
                const raw = fs.readFileSync(diskCachePath, 'utf8');
                const parsed = JSON.parse(raw);
                diskCount = Array.isArray(parsed.items) ? parsed.items.length : 0;
              } catch (err) {
                // ignore parse errors
              }
            }
          } catch (err) {
            // ignore
          }

          results.push({ folder, redisPresent, redisCount, diskPresent, diskCount, diskSize });
        }

        response.status(200).json({ folders: results });
      } catch (e) {
        console.error('Error in /system/cache-status:', e && e.message ? e.message : e);
        response.status(500).json({ error: e && e.message ? e.message : 'error' });
      }
    }
  );

  app.get(
    "/system/document-processing-status",
    [validatedRequest],
    async (_, response) => {
      try {
        const online = await new CollectorApi().online();
        response.sendStatus(online ? 200 : 503);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/accepted-document-types",
    [validatedRequest],
    async (_, response) => {
      try {
        const types = await new CollectorApi().acceptedFileTypes();
        if (!types) {
          response.sendStatus(404).end();
          return;
        }

        response.status(200).json({ types });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-env",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const { newValues, error } = await updateENV(
          body,
          false,
          response?.locals?.user?.id
        );
        response.status(200).json({ newValues, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-password",
    [validatedRequest],
    async (request, response) => {
      try {
        // Cannot update password in multi - user mode.
        if (multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        let error = null;
        const { usePassword, newPassword } = reqBody(request);
        if (!usePassword) {
          // Password is being disabled so directly unset everything to bypass validation.
          process.env.AUTH_TOKEN = "";
          process.env.JWT_SECRET = "";
        } else {
          error = await updateENV(
            {
              AuthToken: newPassword,
              JWTSecret: v4(),
            },
            true
          )?.error;
        }
        response.status(200).json({ success: !error, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/enable-multi-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          response.status(200).json({
            success: false,
            error: "Multi-user mode is already enabled.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const { user, error } = await User.create({
          username,
          password,
          role: ROLES.admin,
        });

        if (error || !user) {
          response.status(400).json({
            success: false,
            error: error || "Failed to enable multi-user mode.",
          });
          return;
        }

        await SystemSettings._updateSettings({
          multi_user_mode: true,
        });
        await BrowserExtensionApiKey.migrateApiKeysToMultiUser(user.id);

        await updateENV(
          {
            JWTSecret: process.env.JWT_SECRET || v4(),
          },
          true
        );
        await Telemetry.sendTelemetry("enabled_multi_user_mode", {
          multiUserMode: true,
        });
        await EventLogs.logEvent("multi_user_mode_enabled", {}, user?.id);
        response.status(200).json({ success: !!user, error });
      } catch (e) {
        await User.delete({});
        await SystemSettings._updateSettings({
          multi_user_mode: false,
        });

        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/system/multi-user-mode", async (_, response) => {
    try {
      const multiUserMode = await SystemSettings.isMultiUserMode();
      response.status(200).json({ multiUserMode });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/system/logo", async function (request, response) {
    try {
      const darkMode =
        !request?.query?.theme || request?.query?.theme === "default";
      const defaultFilename = getDefaultFilename(darkMode);
      const logoPath = await determineLogoFilepath(defaultFilename);
      const { found, buffer, size, mime } = fetchLogo(logoPath);

      if (!found) {
        response.sendStatus(204).end();
        return;
      }

      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      response.writeHead(200, {
        "Access-Control-Expose-Headers":
          "Content-Disposition,X-Is-Custom-Logo,Content-Type,Content-Length",
        "Content-Type": mime || "image/png",
        "Content-Disposition": `attachment; filename=${path.basename(
          logoPath
        )}`,
        "Content-Length": size,
        "X-Is-Custom-Logo":
          currentLogoFilename !== null &&
          currentLogoFilename !== defaultFilename &&
          !isDefaultFilename(currentLogoFilename),
      });
      response.end(Buffer.from(buffer, "base64"));
      return;
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/footer-data", [validatedRequest], async (_, response) => {
    try {
      const footerData =
        (await SystemSettings.get({ label: "footer_data" }))?.value ??
        JSON.stringify([]);
      response.status(200).json({ footerData: footerData });
    } catch (error) {
      console.error("Error fetching footer data:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/support-email", [validatedRequest], async (_, response) => {
    try {
      const supportEmail =
        (
          await SystemSettings.get({
            label: "support_email",
          })
        )?.value ?? null;
      response.status(200).json({ supportEmail: supportEmail });
    } catch (error) {
      console.error("Error fetching support email:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  // No middleware protection in order to get this on the login page
  app.get("/system/custom-app-name", async (_, response) => {
    try {
      const customAppName =
        (
          await SystemSettings.get({
            label: "custom_app_name",
          })
        )?.value ?? null;
      response.status(200).json({ customAppName: customAppName });
    } catch (error) {
      console.error("Error fetching custom app name:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/pfp/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const { id } = request.params;
        if (response.locals?.user?.id !== Number(id))
          return response.sendStatus(204).end();

        const pfpPath = await determinePfpFilepath(id);
        if (!pfpPath) return response.sendStatus(204).end();

        const { found, buffer, size, mime } = fetchPfp(pfpPath);
        if (!found) return response.sendStatus(204).end();

        response.writeHead(200, {
          "Content-Type": mime || "image/png",
          "Content-Disposition": `attachment; filename=${path.basename(pfpPath)}`,
          "Content-Length": size,
        });
        response.end(Buffer.from(buffer, "base64"));
        return;
      } catch (error) {
        console.error("Error processing the logo request:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all]), handlePfpUpload],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const uploadedFileName = request.randomFileName;
        if (!uploadedFileName) {
          return response.status(400).json({ message: "File upload failed." });
        }

        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;
        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(userRecord.pfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: uploadedFileName,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture uploaded successfully."
            : error || "Failed to update with new profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture upload:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );
  app.get(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (_, response) => {
      try {
        const defaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });

        response.status(200).json({
          success: true,
          defaultSystemPrompt:
            defaultSystemPrompt?.value ||
            SystemSettings.saneDefaultSystemPrompt,
          saneDefaultSystemPrompt: SystemSettings.saneDefaultSystemPrompt,
        });
      } catch (error) {
        console.error("Error fetching default system prompt:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { defaultSystemPrompt } = reqBody(request);
        const { success, error } = await SystemSettings.updateSettings({
          default_system_prompt: defaultSystemPrompt,
        });
        if (!success)
          throw new Error(
            error.message || "Failed to update default system prompt."
          );
        response.status(200).json({
          success: true,
          message: "Default system prompt updated successfully.",
        });
      } catch (error) {
        console.error("Error updating default system prompt:", error);
        response.status(500).json({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    }
  );

  app.delete(
    "/system/remove-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;

        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(oldPfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: null,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture removed successfully."
            : error || "Failed to remove profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture removal:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-logo",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      handleAssetUpload,
    ],
    async (request, response) => {
      if (!request?.file || !request?.file.originalname) {
        return response.status(400).json({ message: "No logo file provided." });
      }

      if (!validFilename(request.file.originalname)) {
        return response.status(400).json({
          message: "Invalid file name. Please choose a different file.",
        });
      }

      try {
        const newFilename = await renameLogoFile(request.file.originalname);
        const existingLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(existingLogoFilename);

        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: newFilename,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo uploaded successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo upload:", error);
        response.status(500).json({ message: "Error uploading the logo." });
      }
    }
  );

  app.get("/system/is-default-logo", async (_, response) => {
    try {
      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      const isDefaultLogo =
        !currentLogoFilename || currentLogoFilename === LOGO_FILENAME;
      response.status(200).json({ isDefaultLogo });
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/remove-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (_request, response) => {
      try {
        const currentLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(currentLogoFilename);
        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: LOGO_FILENAME,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo removed successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo removal:", error);
        response.status(500).json({ message: "Error removing the logo." });
      }
    }
  );

  app.get(
    "/system/welcome-messages",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (_, response) {
      try {
        const welcomeMessages = await WelcomeMessages.getMessages();
        response.status(200).json({ success: true, welcomeMessages });
      } catch (error) {
        console.error("Error fetching welcome messages:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/set-welcome-messages",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { messages = [] } = reqBody(request);
        if (!Array.isArray(messages)) {
          return response.status(400).json({
            success: false,
            message: "Invalid message format. Expected an array of messages.",
          });
        }

        await WelcomeMessages.saveAll(messages);
        return response.status(200).json({
          success: true,
          message: "Welcome messages saved successfully.",
        });
      } catch (error) {
        console.error("Error processing the welcome messages:", error);
        response.status(500).json({
          success: true,
          message: "Error saving the welcome messages.",
        });
      }
    }
  );

  app.get("/system/api-keys", [validatedRequest], async (_, response) => {
    try {
      if (response.locals.multiUserMode) {
        return response.sendStatus(401).end();
      }

      const apiKeys = await ApiKey.where({});
      return response.status(200).json({
        apiKeys,
        error: null,
      });
    } catch (error) {
      console.error(error);
      response.status(500).json({
        apiKey: null,
        error: "Could not find an API Key.",
      });
    }
  });

  app.post(
    "/system/generate-api-key",
    [validatedRequest],
    async (_, response) => {
      try {
        if (response.locals.multiUserMode) {
          return response.sendStatus(401).end();
        }

        const { apiKey, error } = await ApiKey.create();
        await EventLogs.logEvent(
          "api_key_created",
          {},
          response?.locals?.user?.id
        );
        return response.status(200).json({
          apiKey,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          apiKey: null,
          error: "Error generating api key.",
        });
      }
    }
  );

  // TODO: This endpoint is replicated in the admin endpoints file.
  // and should be consolidated to be a single endpoint with flexible role protection.
  app.delete(
    "/system/api-key/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode)
          return response.sendStatus(401).end();
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();

        await ApiKey.delete({ id: Number(id) });
        await EventLogs.logEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/custom-models",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { provider, apiKey = null, basePath = null } = reqBody(request);
        const { models, error } = await getCustomModels(
          provider,
          apiKey,
          basePath
        );
        return response.status(200).json({
          models,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { offset = 0, limit = 10 } = reqBody(request);
        const logs = await EventLogs.whereWithData({}, limit, offset * limit, {
          id: "desc",
        });
        const totalLogs = await EventLogs.count();
        const hasPages = totalLogs > (offset + 1) * limit;

        response.status(200).json({ logs: logs, hasPages, totalLogs });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_, response) => {
      try {
        await EventLogs.delete();
        await EventLogs.logEvent(
          "event_logs_cleared",
          {},
          response?.locals?.user?.id
        );
        response.json({ success: true });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/workspace-chats",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const chats = await WorkspaceChats.whereWithData(
          {},
          limit,
          offset * limit,
          { id: "desc" }
        );
        const totalChats = await WorkspaceChats.count();
        const hasPages = totalChats > (offset + 1) * limit;

        response.status(200).json({ chats: chats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/workspace-chats/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { id } = request.params;
        Number(id) === -1
          ? await WorkspaceChats.delete({}, true)
          : await WorkspaceChats.delete({ id: Number(id) });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/export-chats",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.manager, ROLES.admin]),
    ],
    async (request, response) => {
      try {
        const { type = "jsonl", chatType = "workspace" } = request.query;
        const { contentType, data } = await exportChatsAsType(type, chatType);
        await EventLogs.logEvent(
          "exported_chats",
          {
            type,
            chatType,
          },
          response.locals.user?.id
        );
        response.setHeader("Content-Type", contentType);
        response.status(200).send(data);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Used for when a user in multi-user updates their own profile
  // from the UI.
  app.post("/system/user", [validatedRequest], async (request, response) => {
    try {
      const sessionUser = await userFromSession(request, response);
      const { username, password, bio } = reqBody(request);
      const id = Number(sessionUser.id);

      if (!id) {
        response.status(400).json({ success: false, error: "Invalid user ID" });
        return;
      }

      const updates = {};
      if (username)
        updates.username = User.validations.username(String(username));
      if (password) updates.password = String(password);
      if (bio) updates.bio = String(bio);

      if (Object.keys(updates).length === 0) {
        response
          .status(400)
          .json({ success: false, error: "No updates provided" });
        return;
      }

      const { success, error } = await User.update(id, updates);
      response.status(200).json({ success, error });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
        response.status(200).json({ presets: userPresets });
      } catch (error) {
        console.error("Error fetching slash command presets:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (Object.keys(VALID_COMMANDS).includes(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot create a preset with a command that matches a system command",
          });
        }

        const presetData = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.create(user?.id, presetData);
        if (!preset) {
          return response
            .status(500)
            .json({ message: "Failed to create preset" });
        }
        response.status(201).json({ preset });
      } catch (error) {
        console.error("Error creating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slashCommandId } = request.params;
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (Object.keys(VALID_COMMANDS).includes(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot update a preset to use a command that matches a system command",
          });
        }

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response.status(404).json({ message: "Preset not found" });

        const updates = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.update(
          Number(slashCommandId),
          updates
        );
        if (!preset) return response.sendStatus(422);
        response.status(200).json({ preset: { ...ownsPreset, ...updates } });
      } catch (error) {
        console.error("Error updating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.delete(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slashCommandId } = request.params;
        const user = await userFromSession(request, response);

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response
            .status(403)
            .json({ message: "Failed to delete preset" });

        await SlashCommandPresets.delete(Number(slashCommandId));
        response.sendStatus(204);
      } catch (error) {
        console.error("Error deleting slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.get(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const variables = await SystemPromptVariables.getAll(user?.id);
        response.status(200).json({ variables });
      } catch (error) {
        console.error("Error fetching system prompt variables:", error);
        response.status(500).json({
          success: false,
          error: `Failed to fetch system prompt variables: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.create({
          key,
          value,
          description,
          userId: user?.id || null,
        });

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error creating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to create system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.put(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.update(Number(id), {
          key,
          value,
          description,
        });

        if (!variable) {
          return response.status(404).json({
            success: false,
            error: "Variable not found",
          });
        }

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error updating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to update system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.delete(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const success = await SystemPromptVariables.delete(Number(id));

        if (!success) {
          return response.status(404).json({
            success: false,
            error: "System prompt variable not found or could not be deleted",
          });
        }

        response.status(200).json({
          success: true,
        });
      } catch (error) {
        console.error("Error deleting system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to delete system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/validate-sql-connection",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { engine, connectionString } = reqBody(request);
        if (!engine || !connectionString) {
          return response.status(400).json({
            success: false,
            error: "Both engine and connection details are required.",
          });
        }

        const {
          validateConnection,
        } = require("../utils/agents/aibitat/plugins/sql-agent/SQLConnectors");
        const result = await validateConnection(engine, { connectionString });

        if (!result.success) {
          return response.status(200).json({
            success: false,
            error: `Unable to connect to ${engine}. Please verify your connection details.`,
          });
        }

        response.status(200).json(result);
      } catch (error) {
        console.error("SQL validation error:", error);
        response.status(500).json({
          success: false,
          error: `Unable to connect to ${engine}. Please verify your connection details.`,
        });
      }
    }
  );
}

module.exports = { systemEndpoints };
