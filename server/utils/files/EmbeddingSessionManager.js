const { v4: uuidv4 } = require('uuid');

/**
 * Session manager for document embedding operations
 * Provides pause/resume/cancel functionality and progress tracking
 */
class EmbeddingSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Create a new embedding session
   */
  createSession({ workspaceId, workspaceName, documentPaths = [], userId = null, forceReEmbed = false }) {
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      workspaceId,
      workspaceName,
      documentPaths,
      userId,
      forceReEmbed,
      status: 'running',
      progress: 0,
      totalDocuments: documentPaths.length,
      embedded: [],
      failed: [],
      errors: [],
      currentIndex: 0,
      isPaused: false,
      isCanceled: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    console.log(`[EmbeddingSession] Created session ${sessionId} for workspace ${workspaceName} with ${documentPaths.length} documents`);
    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Get active session (first running session)
   */
  getActiveSession() {
    return Array.from(this.sessions.values()).find(s => s.status === 'running');
  }

  /**
   * Update session progress
   */
  updateProgress(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    Object.assign(session, updates, { updatedAt: Date.now() });
    
    // Calculate progress percentage
    if (session.totalDocuments > 0) {
      session.progress = ((session.embedded.length + session.failed.length) / session.totalDocuments * 100).toFixed(2);
    }

    return session;
  }

  /**
   * Pause a session
   */
  pause(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;

    session.isPaused = true;
    session.status = 'paused';
    session.updatedAt = Date.now();
    console.log(`[EmbeddingSession] Paused session ${sessionId}`);
    return true;
  }

  /**
   * Resume a paused session
   */
  resume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'paused') return false;

    session.isPaused = false;
    session.status = 'running';
    session.updatedAt = Date.now();
    console.log(`[EmbeddingSession] Resumed session ${sessionId}`);
    return true;
  }

  /**
   * Cancel a session
   */
  cancel(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isCanceled = true;
    session.status = 'canceled';
    session.updatedAt = Date.now();
    console.log(`[EmbeddingSession] Canceled session ${sessionId}`);
    return true;
  }

  /**
   * Mark session as completed
   */
  complete(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'completed';
    session.progress = 100;
    session.updatedAt = Date.now();
    session.completedAt = Date.now();
    console.log(`[EmbeddingSession] Completed session ${sessionId} - ${session.embedded.length} embedded, ${session.failed.length} failed`);
    return true;
  }

  /**
   * Mark session as failed
   */
  fail(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'failed';
    session.error = error;
    session.updatedAt = Date.now();
    console.log(`[EmbeddingSession] Failed session ${sessionId}: ${error}`);
    return true;
  }

  /**
   * Delete session
   */
  deleteSession(sessionId) {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      console.log(`[EmbeddingSession] Deleted session ${sessionId}`);
    }
    return deleted;
  }

  /**
   * Clean up old sessions (older than 1 hour and completed/failed/canceled)
   */
  cleanup() {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (['completed', 'failed', 'canceled'].includes(session.status)) {
        if (now - session.updatedAt > ONE_HOUR) {
          this.deleteSession(sessionId);
        }
      }
    }
  }

  /**
   * Get session status for API response
   */
  getStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const processedCount = session.embedded.length + session.failed.length;
    const remainingDocuments = session.totalDocuments - processedCount;

    return {
      id: session.id,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      status: session.status,
      progress: parseFloat(session.progress),
      totalDocuments: session.totalDocuments,
      embeddedCount: session.embedded.length,
      failedCount: session.failed.length,
      remainingDocuments: remainingDocuments,
      currentDocument: session.currentDocument || null,
      embedded: session.embedded,
      failed: session.failed,
      errors: session.errors,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      completedAt: session.completedAt || null,
    };
  }
}

// Singleton instance
const embeddingSessionManager = new EmbeddingSessionManager();

// Cleanup every 5 minutes
setInterval(() => {
  embeddingSessionManager.cleanup();
}, 5 * 60 * 1000);

module.exports = { embeddingSessionManager, EmbeddingSessionManager };
