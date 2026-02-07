const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

/**
 * ResyncSession - tracks an active resync operation
 */
class ResyncSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = uuidv4();
    this.status = 'initializing'; // initializing, running, paused, completed, failed
    this.startTime = Date.now();
    this.endTime = null;
    this.currentFolder = null;
    this.currentFile = null;
    this.filesProcessed = 0;
    this.totalFiles = 0;
    this.currentBatch = 0;
    this.totalBatches = 0;
    this.errors = [];
    this.folders = [];
    this.batchSize = options.batchSize || 20;
    this.forceRefresh = options.forceRefresh || false;
    this.folderFilter = options.folderFilter || null; // null = all folders
    this.shouldPause = false;
    this.shouldCancel = false;
    this.processedFiles = []; // Recently processed files (keep last 50)
    this.processedFileNames = new Set(); // Track all processed file names to avoid duplicates
    this.completedFolders = new Set(); // Track which folders are fully processed
    this.currentFolderProgress = 0; // Track progress within current folder
    this.metrics = {
      avgProcessingTime: 0,
      slowestFiles: [],
      cacheHits: 0,
      cacheMisses: 0,
      totalReadTime: 0,
      totalParseTime: 0,
    };
  }

  updateProgress(data) {
    Object.assign(this, data);
    this.emit('progress', this.getStatus());
  }

  addProcessedFile(fileName, timeMs) {
    // Only increment if this is a new file (not already processed)
    const fileKey = `${this.currentFolder}/${fileName}`;
    if (!this.processedFileNames.has(fileKey)) {
      this.filesProcessed++;
      this.processedFileNames.add(fileKey);
    }
    
    this.processedFiles.unshift({ fileName, timeMs, timestamp: Date.now() });
    if (this.processedFiles.length > 50) this.processedFiles.pop();
    
    // Update metrics
    const total = this.metrics.avgProcessingTime * (this.filesProcessed - 1) + timeMs;
    this.metrics.avgProcessingTime = total / this.filesProcessed;
    
    // Track slowest files
    this.metrics.slowestFiles.push({ fileName, timeMs });
    this.metrics.slowestFiles.sort((a, b) => b.timeMs - a.timeMs);
    if (this.metrics.slowestFiles.length > 10) this.metrics.slowestFiles.pop();
  }

  addError(error) {
    this.errors.push({
      message: error.message || String(error),
      timestamp: Date.now(),
      file: this.currentFile,
      folder: this.currentFolder,
    });
  }

  getProgress() {
    return this.totalFiles > 0 
      ? Math.round((this.filesProcessed / this.totalFiles) * 100) 
      : 0;
  }

  getSpeed() {
    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    return elapsed > 0 ? (this.filesProcessed / elapsed).toFixed(2) : 0;
  }

  getEstimatedTimeRemaining() {
    const speed = parseFloat(this.getSpeed());
    if (speed === 0) return null;
    const remaining = this.totalFiles - this.filesProcessed;
    return Math.round(remaining / speed); // seconds
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      progress: this.getProgress(),
      currentFolder: this.currentFolder,
      currentFile: this.currentFile,
      filesProcessed: this.filesProcessed,
      totalFiles: this.totalFiles,
      currentBatch: this.currentBatch,
      totalBatches: this.totalBatches,
      speed: this.getSpeed(),
      estimatedTimeRemaining: this.getEstimatedTimeRemaining(),
      startTime: this.startTime,
      endTime: this.endTime,
      errors: this.errors,
      recentFiles: this.processedFiles.slice(0, 10),
      metrics: this.metrics,
    };
  }

  pause() {
    this.shouldPause = true;
    this.status = 'pausing';
  }

  resume() {
    this.shouldPause = false;
    this.shouldCancel = false;
    this.status = 'running';
    this.emit('resumed', this.getStatus());
  }

  cancel() {
    this.shouldCancel = true;
    this.status = 'cancelling';
  }

  complete() {
    this.status = 'completed';
    this.endTime = Date.now();
    this.emit('complete', this.getStatus());
  }

  fail(error) {
    this.status = 'failed';
    this.endTime = Date.now();
    this.addError(error);
    this.emit('failed', this.getStatus());
  }
}

/**
 * ResyncSessionManager - manages active resync sessions
 */
class ResyncSessionManager {
  constructor() {
    this.sessions = new Map();
    this.activeSession = null;
  }

  createSession(options = {}) {
    // Only allow one active session at a time
    if (this.activeSession && ['running', 'pausing', 'initializing'].includes(this.activeSession.status)) {
      throw new Error('A resync session is already active');
    }

    const session = new ResyncSession(options);
    this.sessions.set(session.sessionId, session);
    this.activeSession = session;
    
    // Clean up old sessions (keep last 10)
    if (this.sessions.size > 10) {
      const oldestKey = Array.from(this.sessions.keys())[0];
      this.sessions.delete(oldestKey);
    }

    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getActiveSession() {
    return this.activeSession;
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map(s => s.getStatus());
  }
}

// Singleton instance
const resyncSessionManager = new ResyncSessionManager();

module.exports = {
  ResyncSession,
  ResyncSessionManager,
  resyncSessionManager,
};
