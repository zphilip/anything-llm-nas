import React, { useState, useEffect, useRef } from "react";
import ModalWrapper from "@/components/ModalWrapper";
import Workspace from "@/models/workspace";
import { X, Pause, Play, XCircle } from "@phosphor-icons/react";

/**
 * EmbeddingProgressModal - Real-time progress display for document embedding
 * 
 * Features:
 * - Live progress updates via polling
 * - Pause/resume/cancel controls
 * - Document-level error tracking
 * - Scrollable list of embedded and failed documents
 */
export default function EmbeddingProgressModal({ isOpen, onClose, sessionId, workspace }) {
  const [status, setStatus] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const pollIntervalRef = useRef(null);
  const lastSessionIdRef = useRef(null);

  // Reset state when opening with a new session
  useEffect(() => {
    if (isOpen && sessionId && sessionId !== lastSessionIdRef.current) {
      setStatus(null);
      setIsPaused(false);
      setIsCancelled(false);
      lastSessionIdRef.current = sessionId;
    }
  }, [isOpen, sessionId]);

  // Poll for status updates
  useEffect(() => {
    if (!isOpen || !sessionId || !workspace) return;

    const pollStatus = async () => {
      try {
        const data = await Workspace.embeddingStatus(workspace.slug, sessionId);
        if (data.success && data.status) {
          const sessionStatus = data.status;
          setStatus(sessionStatus);
          setIsPaused(sessionStatus.status === 'paused');
          setIsCancelled(sessionStatus.status === 'canceled');

          // Stop polling on terminal status
          if (['completed', 'failed', 'canceled'].includes(sessionStatus.status)) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }

            // Auto-close after completion
            if (sessionStatus.status === 'completed') {
              setTimeout(() => {
                onClose(true);
              }, 2000);
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch embedding status:', error);
      }
    };

    // Initial fetch
    pollStatus();

    // Poll every 2 seconds
    pollIntervalRef.current = setInterval(pollStatus, 2000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen, sessionId, workspace, onClose]);

  const handlePause = async () => {
    if (!sessionId || !workspace) return;
    try {
      await Workspace.pauseEmbedding(workspace.slug, sessionId);
      setIsPaused(true);
    } catch (error) {
      console.error('Failed to pause embedding:', error);
    }
  };

  const handleResume = async () => {
    if (!sessionId || !workspace) return;
    try {
      await Workspace.resumeEmbedding(workspace.slug, sessionId);
      setIsPaused(false);
    } catch (error) {
      console.error('Failed to resume embedding:', error);
    }
  };

  const handleCancel = async () => {
    if (!sessionId || !workspace) return;
    try {
      await Workspace.cancelEmbedding(workspace.slug, sessionId);
      setIsCancelled(true);
    } catch (error) {
      console.error('Failed to cancel embedding:', error);
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

  const calculateElapsedTime = () => {
    if (!status || !status.startedAt) return 0;
    return Date.now() - status.startedAt;
  };

  const calculateSpeed = () => {
    const elapsed = calculateElapsedTime();
    if (!elapsed || !status || !status.embeddedCount) return 0;
    return (status.embeddedCount / (elapsed / 1000)).toFixed(2);
  };

  const calculateETA = () => {
    const speed = parseFloat(calculateSpeed());
    if (!speed || !status || !status.remainingDocuments) return 0;
    return (status.remainingDocuments / speed) * 1000;
  };

  if (!isOpen || !status) return null;

  const progress = parseFloat(status.progress) || 0;
  const embeddedCount = status.embeddedCount || 0;
  const failedCount = status.failedCount || 0;
  const totalDocuments = status.totalDocuments || 0;
  const remainingDocuments = status.remainingDocuments || 0;
  const isComplete = status.status === 'completed';
  const isFailed = status.status === 'failed';

  return (
    <ModalWrapper isOpen={isOpen}>
      <div className="relative w-full max-w-2xl max-h-full overflow-hidden bg-theme-bg-secondary rounded-lg shadow-lg border border-theme-modal-border">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-theme-modal-border">
          <h3 className="text-xl font-semibold text-white">
            {isComplete ? 'Embedding Complete!' : isFailed ? 'Embedding Failed' : isCancelled ? 'Embedding Cancelled' : 'Embedding Documents'}
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
              <span>
                {embeddedCount.toLocaleString()} embedded
                {failedCount > 0 && `, ${failedCount} failed`} / {totalDocuments.toLocaleString()} total
              </span>
              <span>{progress.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-theme-settings-input-bg rounded-full h-3 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  isComplete ? 'bg-green-500' : isFailed ? 'bg-red-500' : isCancelled ? 'bg-gray-500' : 'bg-primary-button'
                }`}
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-4 p-4 bg-theme-settings-input-bg rounded-lg">
            <div>
              <div className="text-xs text-gray-400 mb-1">Remaining</div>
              <div className="text-lg font-semibold text-white">{remainingDocuments.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Speed</div>
              <div className="text-lg font-semibold text-white">{calculateSpeed()} docs/s</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">ETA</div>
              <div className="text-lg font-semibold text-white">{formatDuration(calculateETA())}</div>
            </div>
          </div>

          {/* Current Document */}
          {status.currentDocument && !isComplete && !isFailed && !isCancelled && (
            <div className="p-3 bg-theme-settings-input-bg rounded-lg">
              <div className="text-xs text-gray-400 mb-1">Current Document</div>
              <div className="text-sm text-white font-mono truncate">{status.currentDocument}</div>
            </div>
          )}

          {/* Status Summary */}
          {isComplete && (
            <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
              <div className="text-sm text-green-400 font-semibold mb-2">✓ Embedding Complete</div>
              <div className="text-xs text-gray-300 space-y-1">
                <div>Successfully embedded {embeddedCount} document{embeddedCount !== 1 ? 's' : ''}</div>
                {failedCount > 0 && <div className="text-yellow-400">{failedCount} document{failedCount !== 1 ? 's' : ''} failed to embed</div>}
                <div>Time elapsed: {formatDuration(calculateElapsedTime())}</div>
              </div>
            </div>
          )}

          {/* Failed Documents List */}
          {status.failed && status.failed.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm text-red-400">Failed Documents ({status.failed.length})</div>
              </div>
              <div className="max-h-32 overflow-y-auto bg-theme-settings-input-bg rounded-lg p-3 space-y-1">
                {status.failed.map((doc, idx) => (
                  <div key={idx} className="text-xs text-red-300 font-mono truncate">
                    {doc}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error Messages */}
          {status.errors && status.errors.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-red-400">Errors ({status.errors.length})</div>
              <div className="max-h-32 overflow-y-auto bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-1">
                {status.errors.map((error, idx) => (
                  <div key={idx} className="text-xs text-red-300">
                    {error}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recently Embedded Documents */}
          {status.embedded && status.embedded.length > 0 && !isComplete && (
            <div className="space-y-2">
              <div className="text-sm text-gray-400">Recently Embedded ({Math.min(status.embedded.length, 10)})</div>
              <div className="max-h-32 overflow-y-auto bg-theme-settings-input-bg rounded-lg p-3 space-y-1">
                {status.embedded.slice(-10).reverse().map((doc, idx) => (
                  <div key={idx} className="text-xs text-green-400 font-mono truncate">
                    ✓ {doc}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {!isComplete && !isFailed && !isCancelled && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-theme-modal-border">
            {isPaused ? (
              <button
                onClick={handleResume}
                className="flex items-center gap-2 px-4 py-2 bg-green-500/10 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/20 transition-colors"
              >
                <Play size={18} weight="fill" />
                <span>Resume</span>
              </button>
            ) : (
              <button
                onClick={handlePause}
                className="flex items-center gap-2 px-4 py-2 bg-theme-settings-input-bg text-white rounded-lg hover:bg-theme-sidebar-subitem-hover transition-colors"
              >
                <Pause size={18} />
                <span>Pause</span>
              </button>
            )}
            <button
              onClick={handleCancel}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/20 transition-colors"
            >
              <XCircle size={18} />
              <span>Cancel</span>
            </button>
          </div>
        )}

        {/* Terminal Status Footer */}
        {(isComplete || isFailed || isCancelled) && (
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
