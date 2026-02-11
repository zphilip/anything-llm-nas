import { ArrowsDownUp } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import Workspace from "../../../../models/workspace";
import System from "../../../../models/system";
import showToast from "../../../../utils/toast";
import Directory from "./Directory";
import WorkspaceDirectory from "./WorkspaceDirectory";
import EmbeddingProgressModal from "@/components/Modals/EmbeddingProgressModal";

// OpenAI Cost per token
// ref: https://openai.com/pricing#:~:text=%C2%A0/%201K%20tokens-,Embedding%20models,-Build%20advanced%20search

const MODEL_COSTS = {
  "text-embedding-ada-002": 0.0000001, // $0.0001 / 1K tokens
  "text-embedding-3-small": 0.00000002, // $0.00002 / 1K tokens
  "text-embedding-3-large": 0.00000013, // $0.00013 / 1K tokens
};

export default function DocumentSettings({ workspace, systemSettings }) {
  const [highlightWorkspace, setHighlightWorkspace] = useState(false);
  const [availableDocs, setAvailableDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workspaceDocs, setWorkspaceDocs] = useState([]);
  const [selectedItems, setSelectedItems] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [movedItems, setMovedItems] = useState([]);
  const [embeddingsCost, setEmbeddingsCost] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [totalFiles, setTotalFiles] = useState(0);
  const [availableFilesCount, setAvailableFilesCount] = useState(0);
  const [embeddedFilesCount, setEmbeddedFilesCount] = useState(0);
  const [showEmbeddingProgress, setShowEmbeddingProgress] = useState(false);
  const [embeddingSessionId, setEmbeddingSessionId] = useState(null);

  async function fetchKeys(refetchWorkspace = false, rescan = false) {
    setLoading(true);
    const response = await System.localFiles(rescan);
    console.log('[Documents] API response:', response);
    console.log('[Documents] response.totalFiles:', response?.totalFiles);
    console.log('[Documents] response.localFiles:', response?.localFiles);
    
    // Check if response is a summary (too large to send full data)
    if (response?.warning && response?.folders) {
      console.warn('[Documents] Received summary response:', response.warning);
      console.log('[Documents] Folders summary:', response.folders);
      setTotalFiles(response.totalFiles || 0);
      
      // Build a placeholder structure showing folder summaries
      const placeholderDocs = {
        name: "documents",
        type: "folder",
        items: response.folders.map(folder => ({
          name: folder.name,
          type: "folder",
          items: [], // Empty, will be loaded on demand
          _summary: true,
          _itemCount: folder.itemCount,
        }))
      };
      
      setAvailableDocs(placeholderDocs);
      setWorkspaceDocs({ name: "documents", type: "folder", items: [] });
      setLoading(false);
      
      alert(`Directory contains ${response.totalFiles} files across ${response.folderCount} folder(s). This is too large to display all at once. Please use the search feature or contact support to enable pagination.`);
      return;
    }
    
    const localFiles = response?.localFiles || response;
    const totalFilesCount = response?.totalFiles || 0;
    
    console.log('[Documents] Total files count:', totalFilesCount);
    console.log('[Documents] localFiles structure:', localFiles);
    setTotalFiles(totalFilesCount);
    
    // Add null check for localFiles
    if (!localFiles || !localFiles.items) {
      console.warn('No local files found or invalid structure');
      setAvailableDocs({ name: "documents", type: "folder", items: [] });
      setWorkspaceDocs({ name: "documents", type: "folder", items: [] });
      setTotalFiles(0);
      setLoading(false);
      return;
    }
    
    const currentWorkspace = refetchWorkspace
      ? await Workspace.bySlug(workspace.slug)
      : workspace;

    const documentsInWorkspace =
      currentWorkspace.documents.map((doc) => doc.docpath) || [];

    // Documents that are not in the workspace
    const availableDocs = {
      ...localFiles,
      items: localFiles.items.map((folder) => {
        if (folder.items && folder.type === "folder") {
          return {
            ...folder,
            items: folder.items.filter(
              (file) =>
                file.type === "file" &&
                !documentsInWorkspace.includes(`${folder.name}/${file.name}`)
            ),
          };
        } else {
          return folder;
        }
      }),
    };

    // Documents that are already in the workspace
    const workspaceDocs = {
      ...localFiles,
      items: localFiles.items.map((folder) => {
        if (folder.items && folder.type === "folder") {
          return {
            ...folder,
            items: folder.items.filter(
              (file) =>
                file.type === "file" &&
                documentsInWorkspace.includes(`${folder.name}/${file.name}`)
            ),
          };
        } else {
          return folder;
        }
      }),
    };

    // Calculate counts
    const availableCount = availableDocs.items.reduce(
      (sum, folder) => sum + (folder.items?.length || 0),
      0
    );
    const embeddedCount = workspaceDocs.items.reduce(
      (sum, folder) => sum + (folder.items?.length || 0),
      0
    );

    setAvailableDocs(availableDocs);
    setWorkspaceDocs(workspaceDocs);
    setAvailableFilesCount(availableCount);
    setEmbeddedFilesCount(embeddedCount);
    setLoading(false);
  }

  useEffect(() => {
    fetchKeys(true);
  }, []);

  const updateWorkspace = async (e, forceReEmbed = false) => {
    e.preventDefault();
    setLoading(true);
    showToast("Starting document embedding...", "info", { autoClose: false });
    setLoadingMessage("This may take a while for large documents");

    const changesToSend = {
      adds: movedItems.map((item) => `${item.folderName}/${item.name}`),
      forceReEmbed: forceReEmbed,
      useSession: true, // Enable session mode for progress tracking
    };

    setSelectedItems({});
    setHasChanges(false);
    setHighlightWorkspace(false);
    
    await Workspace.modifyEmbeddings(workspace.slug, changesToSend)
      .then((res) => {
        if (res.sessionId) {
          // Session mode - show progress modal
          setEmbeddingSessionId(res.sessionId);
          setShowEmbeddingProgress(true);
          showToast("Embedding started - tracking progress", "success", { clear: true });
          setLoading(false);
          setLoadingMessage("");
        } else if (!!res.message) {
          // Error
          showToast(`Error: ${res.message}`, "error", { clear: true });
          setLoading(false);
          setLoadingMessage("");
        } else {
          // Legacy sync mode
          showToast("Workspace updated successfully.", "success", { clear: true });
          setLoading(false);
          setLoadingMessage("");
        }
      })
      .catch((error) => {
        showToast(`Workspace update failed: ${error}`, "error", { clear: true });
        setLoading(false);
        setLoadingMessage("");
      });

    setMovedItems([]);
  };

  const handleEmbeddingProgressClose = async (completed) => {
    setShowEmbeddingProgress(false);
    setEmbeddingSessionId(null);
    if (completed) {
      showToast("Documents embedded successfully!", "success");
    }
    await fetchKeys(true); // Refresh workspace
  };

  const moveSelectedItemsToWorkspace = () => {
    setHighlightWorkspace(false);
    setHasChanges(true);

    const newMovedItems = [];

    for (const itemId of Object.keys(selectedItems)) {
      for (const folder of availableDocs.items) {
        const foundItem = folder.items.find((file) => file.id === itemId);
        if (foundItem) {
          newMovedItems.push({ ...foundItem, folderName: folder.name });
          break;
        }
      }
    }

    let totalTokenCount = 0;
    newMovedItems.forEach((item) => {
      const { cached, token_count_estimate } = item;
      if (!cached) {
        totalTokenCount += token_count_estimate;
      }
    });

    // Do not do cost estimation unless the embedding engine is OpenAi.
    if (systemSettings?.EmbeddingEngine === "openai") {
      const COST_PER_TOKEN =
        MODEL_COSTS[
          systemSettings?.EmbeddingModelPref || "text-embedding-ada-002"
        ];

      const dollarAmount = (totalTokenCount / 1000) * COST_PER_TOKEN;
      setEmbeddingsCost(dollarAmount);
    }

    setMovedItems([...movedItems, ...newMovedItems]);

    let newAvailableDocs = JSON.parse(JSON.stringify(availableDocs));
    let newWorkspaceDocs = JSON.parse(JSON.stringify(workspaceDocs));

    for (const itemId of Object.keys(selectedItems)) {
      let foundItem = null;
      let foundFolderIndex = null;

      newAvailableDocs.items = newAvailableDocs.items.map(
        (folder, folderIndex) => {
          const remainingItems = folder.items.filter((file) => {
            const match = file.id === itemId;
            if (match) {
              foundItem = { ...file };
              foundFolderIndex = folderIndex;
            }
            return !match;
          });

          return {
            ...folder,
            items: remainingItems,
          };
        }
      );

      if (foundItem) {
        newWorkspaceDocs.items[foundFolderIndex].items.push(foundItem);
      }
    }

    setAvailableDocs(newAvailableDocs);
    setWorkspaceDocs(newWorkspaceDocs);
    setSelectedItems({});
  };

  return (
    <div className="flex upload-modal -mt-6 z-10 relative">
      <Directory
        files={availableDocs}
        setFiles={setAvailableDocs}
        loading={loading}
        loadingMessage={loadingMessage}
        setLoading={setLoading}
        workspace={workspace}
        fetchKeys={fetchKeys}
        selectedItems={selectedItems}
        setSelectedItems={setSelectedItems}
        updateWorkspace={updateWorkspace}
        highlightWorkspace={highlightWorkspace}
        setHighlightWorkspace={setHighlightWorkspace}
        moveToWorkspace={moveSelectedItemsToWorkspace}
        setLoadingMessage={setLoadingMessage}
        totalFiles={totalFiles}
        availableFilesCount={availableFilesCount}
      />
      <div className="upload-modal-arrow">
        <ArrowsDownUp className="text-white text-base font-bold rotate-90 w-11 h-11" />
      </div>
      <WorkspaceDirectory
        workspace={workspace}
        files={workspaceDocs}
        highlightWorkspace={highlightWorkspace}
        loading={loading}
        loadingMessage={loadingMessage}
        setLoadingMessage={setLoadingMessage}
        setLoading={setLoading}
        fetchKeys={fetchKeys}
        hasChanges={hasChanges}
        saveChanges={updateWorkspace}
        embeddingCosts={embeddingsCost}
        movedItems={movedItems}
        embeddedFilesCount={embeddedFilesCount}
      />
      
      {/* Embedding Progress Modal */}
      <EmbeddingProgressModal
        isOpen={showEmbeddingProgress}
        onClose={handleEmbeddingProgressClose}
        sessionId={embeddingSessionId}
        workspace={workspace}
      />
    </div>
  );
}
