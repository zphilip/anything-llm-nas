const { v4: uuidv4 } = require('uuid');
const { fileData } = require("./index");
const { getVectorDbClass } = require("../helpers");
const { embeddingSessionManager } = require("./EmbeddingSessionManager");
const prisma = require("../prisma");
const { Telemetry } = require("../../models/telemetry");
const { EventLogs } = require("../../models/eventLogs");

/**
 * Process document embedding with pause/resume/cancel support
 */
async function processEmbeddingSession(sessionId) {
  const session = embeddingSessionManager.getSession(sessionId);
  if (!session) {
    console.error(`[EmbeddingSession] Session ${sessionId} not found`);
    return;
  }

  const VectorDb = getVectorDbClass();
  const { documentPaths, workspaceId, forceReEmbed, userId } = session;

  console.log(`[EmbeddingSession] Starting session ${sessionId} with ${documentPaths.length} documents`);

  try {
    // Process documents starting from currentIndex (for resume support)
    for (let i = session.currentIndex; i < documentPaths.length; i++) {
      // Check for pause
      if (session.isPaused) {
        console.log(`[EmbeddingSession] Session ${sessionId} paused at document ${i}/${documentPaths.length}`);
        embeddingSessionManager.updateProgress(sessionId, { currentIndex: i });
        return;
      }

      // Check for cancel
      if (session.isCanceled) {
        console.log(`[EmbeddingSession] Session ${sessionId} canceled at document ${i}/${documentPaths.length}`);
        embeddingSessionManager.updateProgress(sessionId, { currentIndex: i });
        return;
      }

      const path = documentPaths[i];
      
      // Update current document
      embeddingSessionManager.updateProgress(sessionId, {
        currentDocument: path,
        currentIndex: i,
      });

      try {
        // Load document data
        const data = await fileData(path);
        if (!data) {
          const updatedSession = embeddingSessionManager.getSession(sessionId);
          embeddingSessionManager.updateProgress(sessionId, {
            failed: [...updatedSession.failed, path],
            errors: [...updatedSession.errors, `Document ${path} not found or failed to load`],
          });
          continue;
        }

        const docId = uuidv4();
        const { pageContent, imageBase64, ...metadata } = data;
        
        // Create workspace document record
        const newDoc = {
          docId,
          filename: path.split("/")[1],
          docpath: path,
          workspaceId: workspaceId,
          metadata: JSON.stringify(metadata),
        };

        // Vectorize and add to vector database
        const { vectorized, error } = await VectorDb.addDocumentToNamespace(
          session.workspaceName,
          { ...data, docId },
          path,
          forceReEmbed
        );

        if (!vectorized) {
          console.error(`[EmbeddingSession] Failed to vectorize ${metadata?.title || newDoc.filename}`);
          const updatedSession = embeddingSessionManager.getSession(sessionId);
          embeddingSessionManager.updateProgress(sessionId, {
            failed: [...updatedSession.failed, path],
            errors: [...updatedSession.errors, error || `Vectorization failed for ${metadata?.title || newDoc.filename}`],
          });
          continue;
        }

        // Save to database
        try {
          await prisma.workspace_documents.create({ data: newDoc });
          const updatedSession = embeddingSessionManager.getSession(sessionId);
          embeddingSessionManager.updateProgress(sessionId, {
            embedded: [...updatedSession.embedded, path],
            currentIndex: i + 1,
          });
          console.log(`[EmbeddingSession] ✅ Embedded ${i + 1}/${documentPaths.length}: ${metadata?.title || newDoc.filename}`);
        } catch (dbError) {
          console.error(`[EmbeddingSession] Database error for ${path}:`, dbError.message);
          const updatedSession = embeddingSessionManager.getSession(sessionId);
          embeddingSessionManager.updateProgress(sessionId, {
            failed: [...updatedSession.failed, path],
            errors: [...updatedSession.errors, `Database error: ${dbError.message}`],
          });
        }

      } catch (docError) {
        console.error(`[EmbeddingSession] Error processing ${path}:`, docError.message);
        const updatedSession = embeddingSessionManager.getSession(sessionId);
        embeddingSessionManager.updateProgress(sessionId, {
          failed: [...updatedSession.failed, path],
          errors: [...updatedSession.errors, `Processing error: ${docError.message}`],
        });
      }
    }

    // Mark as completed if not canceled
    if (!session.isCanceled) {
      embeddingSessionManager.complete(sessionId);

      // Send telemetry
      await Telemetry.sendTelemetry("documents_embedded_in_workspace", {
        LLMSelection: process.env.LLM_PROVIDER || "openai",
        Embedder: process.env.EMBEDDING_ENGINE || "inherit",
        VectorDbSelection: process.env.VECTOR_DB || "lancedb",
        TTSSelection: process.env.TTS_PROVIDER || "native",
      });

      // Log event
      await EventLogs.logEvent(
        "workspace_documents_added",
        {
          workspaceName: session.workspaceName,
          numberOfDocumentsAdded: session.embedded.length,
          numberOfDocumentsFailed: session.failed.length,
        },
        userId
      );

      console.log(`[EmbeddingSession] ✅ Session ${sessionId} completed - ${session.embedded.length} embedded, ${session.failed.length} failed`);
    }

  } catch (error) {
    console.error(`[EmbeddingSession] Fatal error in session ${sessionId}:`, error);
    embeddingSessionManager.fail(sessionId, error.message);
  }
}

/**
 * Start embedding documents in background
 */
function startEmbeddingSession(sessionId) {
  // Run in background without blocking
  processEmbeddingSession(sessionId).catch(error => {
    console.error(`[EmbeddingSession] Unhandled error in session ${sessionId}:`, error);
    embeddingSessionManager.fail(sessionId, error.message);
  });
}

module.exports = {
  processEmbeddingSession,
  startEmbeddingSession,
};
