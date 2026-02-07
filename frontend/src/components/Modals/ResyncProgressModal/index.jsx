import React, { useState, useEffect, useRef } from "react";
import ModalWrapper from "@/components/ModalWrapper";
import System from "@/models/system";
import { X, Pause, XCircle } from "@phosphor-icons/react";

/**
 * ResyncProgressModal - Real-time progress display for incremental document resync
 * 
 * Features:
 * - Live progress updates via Server-Sent Events (SSE)
 * - Batch-based file processing with incremental rendering
 * - Pause/cancel controls
 * - Performance metrics (speed, ETA, slowest files)
 * - Scrollable file list showing recently processed files
 */
export default function ResyncProgressModal({ isOpen, onClose, sessionId }) {
  const [status, setStatus] = useState(null);
  const [recentFiles, setRecentFiles] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const eventSourceRef = useRef(null);
  const recentFilesContainerRef = useRef(null);
  const lastSessionIdRef = useRef(null);

  // Reset state when opening with a new session
  useEffect(() => {
    if (isOpen && sessionId && sessionId !== lastSessionIdRef.current) {
      // Reset all state for new session
      setStatus(null);
      setRecentFiles([]);
      setIsPaused(false);
      setIsCancelled(false);
      lastSessionIdRef.current = sessionId;
    }
  }, [isOpen, sessionId]);

  // Connect to SSE stream for real-time progress updates
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    // Connect to SSE endpoint
    const connectSSE = async () => {
      try {
        const eventSource = await System.connectToResyncProgress(sessionId);
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleProgressEvent(data);
          } catch (err) {
            console.error('Failed to parse SSE event:', err);
          }
        };

        eventSource.onerror = (error) => {
          console.error('SSE connection error:', error);
          eventSource.close();
          eventSourceRef.current = null;
        };
      } catch (error) {
        console.error('Failed to connect to resync progress stream:', error);
      }
    };

    connectSSE();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isOpen, sessionId]);

  // Poll for status updates (fallback + initial state)
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    let interval = null;
    
    const pollStatus = async () => {
      try {
        const data = await System.getResyncStatus(sessionId);
        if (data) {
          setStatus(data);
          
          // Stop polling once process reaches terminal status
          if (data.status === 'completed' || data.status === 'failed' || data.status === 'interrupted' || data.status === 'expired') {
            if (interval) {
              console.log(`[ResyncProgressModal] Stopping polling - status: ${data.status}`);
              clearInterval(interval);
              interval = null;
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch resync status:', error);
      }
    };

    // Initial fetch
    pollStatus();

    // Poll every 2 seconds as fallback
    interval = setInterval(pollStatus, 2000);
    return () => {
      if (interval) {
        console.log('[ResyncProgressModal] Cleanup - clearing polling interval');
        clearInterval(interval);
      }
    };
  }, [isOpen, sessionId]);

  const handleProgressEvent = (event) => {
    const { type, data } = event;

    switch (type) {
      case 'progress':
        setStatus(prev => ({ ...prev, ...data }));
        break;

      case 'batchComplete':
        setStatus(prev => ({ ...prev, ...data.session }));
        
        // Add batch files to recent files list
        if (data.filesProcessed && data.filesProcessed.length > 0) {
          setRecentFiles(prev => {
            const newFiles = [...data.filesProcessed, ...prev].slice(0, 100); // Keep last 100
            return newFiles;
          });

          // Auto-scroll to bottom
          setTimeout(() => {
            if (recentFilesContainerRef.current) {
              recentFilesContainerRef.current.scrollTop = 0; // Scroll to top (newest files)
            }
          }, 100);
        }
        break;

      case 'complete':
        setStatus(prev => ({ ...prev, status: 'completed', ...data }));
        setTimeout(() => {
          onClose(true); // true = completed successfully
        }, 2000);
        break;

      case 'failed':
        setStatus(prev => ({ ...prev, status: 'failed', error: data.error }));
        break;

      case 'paused':
        setStatus(prev => ({ ...prev, status: 'paused' }));
        setIsPaused(true);
        break;

      case 'resumed':
        setStatus(prev => ({ ...prev, status: 'running' }));
        setIsPaused(false);
        break;

      case 'cancelled':
        setStatus(prev => ({ ...prev, status: 'cancelled' }));
        setIsCancelled(true);
        setTimeout(() => {
          onClose(false); // false = cancelled
        }, 1500);
        break;

      default:
        console.warn('Unknown event type:', type);
    }
  };

  const handlePause = async () => {
    if (!sessionId) return;
    try {
      await System.pauseResync(sessionId);
      setIsPaused(true);
    } catch (error) {
      console.error('Failed to pause resync:', error);
    }
  };

  const handleResume = async () => {
    if (!sessionId) return;
    try {
      await System.resumeResync(sessionId);
      setIsPaused(false);
    } catch (error) {
      console.error('Failed to resume resync:', error);
    }
  };

  const handleCancel = async () => {
    if (!sessionId) return;
    try {
      await System.cancelResync(sessionId);
      setIsCancelled(true);
    } catch (error) {
      console.error('Failed to cancel resync:', error);
    }
  };

  const formatDuration = (ms) => {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) return `${minutes}m ${secs}s`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const formatSpeed = (speed) => {
    if (!speed) return '0 files/s';
    if (speed < 1) return `${(speed * 60).toFixed(1)} files/min`;
    return `${speed.toFixed(1)} files/s`;
  };

  if (!isOpen || !status) return null;

  const progress = status.progress || 0;
  const filesProcessed = status.filesProcessed || 0;
  const totalFiles = status.totalFiles || 0;
  const currentBatch = status.currentBatch || 0;
  // Speed and ETA are at top level of status, not in metrics
  const speed = parseFloat(status.speed) || 0;
  const eta = (status.estimatedTimeRemaining || 0) * 1000; // Convert seconds to ms for formatDuration
  const isComplete = status.status === 'completed';
  const isFailed = status.status === 'failed';

  return (
    <ModalWrapper isOpen={isOpen}>
      <div className="relative w-full max-w-2xl max-h-full overflow-hidden bg-theme-bg-secondary rounded-lg shadow-lg border border-theme-modal-border">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-theme-modal-border">
          <h3 className="text-xl font-semibold text-white">
            {isComplete ? 'Resync Complete!' : isFailed ? 'Resync Failed' : 'Resyncing Documents'}
          </h3>
          <button
            onClick={() => onClose(isComplete)}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-300">
              <span>{filesProcessed.toLocaleString()} / {totalFiles.toLocaleString()} files</span>
              <span>{progress.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-theme-settings-input-bg rounded-full h-3 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  isComplete ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'bg-primary-button'
                }`}
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-4 p-4 bg-theme-settings-input-bg rounded-lg">
            <div>
              <div className="text-xs text-gray-400 mb-1">Batch</div>
              <div className="text-lg font-semibold text-white">#{currentBatch}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Speed</div>
              <div className="text-lg font-semibold text-white">{formatSpeed(speed)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">ETA</div>
              <div className="text-lg font-semibold text-white">{formatDuration(eta)}</div>
            </div>
          </div>

          {/* Current Folder */}
          {status.currentFolder && (
            <div className="p-3 bg-theme-settings-input-bg rounded-lg">
              <div className="text-xs text-gray-400 mb-1">Current Folder</div>
              <div className="text-sm text-white font-mono truncate">{status.currentFolder}</div>
            </div>
          )}

          {/* Recent Files List */}
          {recentFiles.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-400">Recently Processed Files</div>
              <div
                ref={recentFilesContainerRef}
                className="max-h-48 overflow-y-auto bg-theme-settings-input-bg rounded-lg p-3 space-y-1"
              >
                {recentFiles.map((file, idx) => (
                  <div key={`${file}-${idx}`} className="text-xs text-gray-300 font-mono truncate">
                    {file}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error Display */}
          {isFailed && status.error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <div className="text-sm text-red-400 font-semibold mb-1">Error</div>
              <div className="text-xs text-red-300">{status.error}</div>
            </div>
          )}

          {/* Slowest Files (if available) */}
          {status.metrics?.slowestFiles && status.metrics.slowestFiles.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-400">Slowest Files</div>
              <div className="bg-theme-settings-input-bg rounded-lg p-3 space-y-1">
                {status.metrics.slowestFiles.slice(0, 5).map((item, idx) => (
                  <div key={idx} className="flex justify-between text-xs">
                    <span className="text-gray-300 font-mono truncate flex-1 mr-2">{item?.fileName || 'Unknown'}</span>
                    <span className="text-gray-400">{item?.timeMs ? `${item.timeMs.toFixed(0)}ms` : 'N/A'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {!isComplete && !isFailed && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-theme-modal-border">
            {isPaused ? (
              <button
                onClick={handleResume}
                disabled={isCancelled}
                className="flex items-center gap-2 px-4 py-2 bg-green-500/10 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Pause size={18} className="rotate-90" />
                <span>Resume</span>
              </button>
            ) : (
              <button
                onClick={handlePause}
                disabled={isCancelled}
                className="flex items-center gap-2 px-4 py-2 bg-theme-settings-input-bg text-white rounded-lg hover:bg-theme-sidebar-subitem-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Pause size={18} />
                <span>Pause</span>
              </button>
            )}
            <button
              onClick={handleCancel}
              disabled={isCancelled}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <XCircle size={18} />
              <span>{isCancelled ? 'Cancelled' : 'Cancel'}</span>
            </button>
          </div>
        )}

        {/* Complete/Failed Footer */}
        {(isComplete || isFailed) && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-theme-modal-border">
            <button
              onClick={() => onClose(isComplete)}
              className="px-6 py-2 bg-primary-button text-white rounded-lg hover:bg-primary-button-hover transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </ModalWrapper>
  );
}
