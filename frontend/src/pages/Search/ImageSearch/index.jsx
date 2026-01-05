import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import Workspace from "@/models/workspace";
import { SearchBarOption } from "./SearchBar";
import { ImageGridV3 } from "./ImageGrid";
import { Pagination } from "./Pagination";
import { ModalV3 } from "./Modal";

export default function ImageSearch() {
  // Application state
  const [ready, setReady] = useState(null);
  const [processedImages, setProcessedImages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentImage, setCurrentImage] = useState(null);

  // Workspace state
  const [checkedWorkspaces, setCheckedWorkspaces] = useState({});
  const [workspaces, setWorkspaces] = useState([]);

  // Search state
  const [searchId, setSearchId] = useState(0);

  // Create a reference to the worker object
  const worker = useRef(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [totalPages, setTotalPages] = useState(1);

  // Distance metric state
  const DISTANCE = {
    EUCLIDEAN: "l2",
    COSINE: "cosine",
    DOT: "dot",
  };

  const [searchDistance, setSearchDistance] = useState(DISTANCE.EUCLIDEAN);

  // Fetch workspaces on mount
  useEffect(() => {
    const fetchWorkspaces = async () => {
      try {
        const fetchedWorkspaces = await Workspace.all();
        setWorkspaces(fetchedWorkspaces);
      } catch (error) {
        console.error("Failed to fetch workspaces:", error);
      }
    };
    fetchWorkspaces();
  }, []);

  const handleCheckboxChange = (workspaceId) => {
    const id =
      typeof workspaceId === "string" ? parseInt(workspaceId, 10) : workspaceId;
    setCheckedWorkspaces((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  // Load base64 images from server
  const loadBase64Images = async (rawImages) => {
    if (!rawImages || rawImages.length === 0) {
      console.warn("No images to process");
      return [];
    }

    setIsProcessing(true);
    try {
      const loadedImages = await Promise.all(
        rawImages.map(async (image) => {
          try {
            // Extract base64 from pageContent if it exists
            if (image.image_base64) {
              return image; // Already has base64
            }

            // Fetch from URL if needed
            const imageUrl = image.url
              .replace("file://", "")
              .replace(String(process.env.STORAGE_DIR || ""), "");
            
            const response = await fetch(imageUrl);
            if (!response.ok) {
              console.warn(`Image not found: ${imageUrl}`);
              return null;
            }

            const jsonData = await response.json();

            return {
              ...image,
              image_base64: jsonData.pageContent,
            };
          } catch (error) {
            console.error(`Error loading image ${image.image_name}:`, error);
            return null;
          }
        })
      );

      // Filter out failed loads and sort by distance
      const validImages = loadedImages
        .filter(Boolean)
        .map((img) => ({
          ...img,
          _distance:
            img._distance !== undefined && img._distance !== null
              ? img._distance
              : null,
        }))
        .sort((a, b) => {
          if (a._distance == null) return 1;
          if (b._distance == null) return -1;
          return searchDistance === DISTANCE.COSINE
            ? b._distance - a._distance
            : a._distance - b._distance;
        });

      return validImages;
    } catch (error) {
      console.error("Error processing images:", error);
      return [];
    } finally {
      setIsProcessing(false);
    }
  };

  // Initialize Web Worker
  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(
        new URL("./worker.js", import.meta.url).href,
        {
          type: "module",
        }
      );
    }

    const onMessageReceived = async (event) => {
      console.log("Received message from Web Worker:", event.data);
      switch (event.data.status) {
        case "initiate":
          setReady(false);
          break;
        case "ready":
          setReady(true);
          break;
        case "complete":
          // Only process results if they match the current search ID
          if (event.data.searchId === searchId) {
            const processedResults = await loadBase64Images(
              event.data.output
            );
            setProcessedImages(processedResults || []);
          } else {
            console.log(
              "Ignoring outdated search results",
              event.data.searchId,
              searchId
            );
          }
          break;
        case "error":
          console.error("Worker error:", event.data.error);
          setIsProcessing(false);
          setReady(true);
          break;
      }
    };

    worker.current.addEventListener("message", onMessageReceived);

    return () =>
      worker.current.removeEventListener("message", onMessageReceived);
  }, [searchId, searchDistance]);

  const search = useCallback(
    async (text) => {
      setIsProcessing(true);

      // Clear previous results
      setProcessedImages([]);

      // Increment search ID to track the current search
      const currentSearchId = searchId + 1;
      setSearchId(currentSearchId);

      if (worker.current) {
        try {
          // Get selected workspaces
          const selectedWorkspaces = Object.entries(checkedWorkspaces)
            .filter(([id, isChecked]) => isChecked)
            .map(([id]) => {
              const numericId = parseInt(id, 10);
              const workspace = workspaces.find((w) => w.id === numericId);
              if (!workspace) {
                console.warn(`Workspace with id ${numericId} not found`);
                return null;
              }

              return {
                name: workspace.name,
                similarityThreshold: workspace.similarityThreshold || 0.25,
                topN: workspace.topN || 20,
              };
            })
            .filter(Boolean);

          console.log("Selected workspaces:", selectedWorkspaces);

          // Get auth token for API calls
          const token = localStorage.getItem("anythingllm_authtoken");
          const headers = token ? { Authorization: `Bearer ${token}` } : {};

          // Send to worker
          worker.current.postMessage({
            text,
            searchId: currentSearchId,
            distanceMetric: searchDistance,
            headers: headers,
            namespaces:
              selectedWorkspaces.length > 0
                ? selectedWorkspaces.map((ws) => ({
                    name: ws.name,
                    threshold: ws.similarityThreshold,
                    limit: ws.topN,
                  }))
                : undefined,
          });
        } catch (error) {
          console.error("Error in search:", error);
          setIsProcessing(false);
        }
      }
    },
    [checkedWorkspaces, workspaces, searchDistance, searchId]
  );

  // Calculate paginated images
  const paginatedImages = useMemo(() => {
    if (!processedImages || processedImages.length === 0) return [];

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;

    return processedImages.slice(startIndex, endIndex);
  }, [processedImages, currentPage, itemsPerPage]);

  // Update total pages when items per page or total images change
  useEffect(() => {
    if (processedImages?.length) {
      setTotalPages(Math.ceil(processedImages.length / itemsPerPage));
      // Reset to page 1 when changing items per page or getting new results
      setCurrentPage(1);
    }
  }, [processedImages, itemsPerPage]);

  // Handle page change
  const handlePageChange = (pageNumber) => {
    setCurrentPage(pageNumber);
    // Scroll to top of results when changing page
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Handle items per page change
  const handleItemsPerPageChange = (newItemsPerPage) => {
    setItemsPerPage(Number(newItemsPerPage));
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      {/* Sidebar Component */}
      <Sidebar
        checkedWorkspaces={checkedWorkspaces}
        onCheckboxChange={handleCheckboxChange}
      />

      <main className="flex-1 bg-theme-bg-container p-6 relative text-white overflow-auto">
        <ModalV3
          currentImage={currentImage}
          setCurrentImage={setCurrentImage}
          searchDistance={searchDistance}
        />

        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-6">Image Search</h1>

          <SearchBarOption
            search={search}
            searchDistance={searchDistance}
            setSearchDistance={setSearchDistance}
            distanceOptions={DISTANCE}
          />

          {ready === false && (
            <div className="z-10 fixed inset-0 bg-black/50 flex items-center justify-center">
              <div className="bg-theme-bg-secondary p-8 rounded-lg shadow-xl">
                <div className="text-white text-xl font-bold text-center">
                  Loading embedding model and database...
                </div>
                <p className="text-white/70 text-sm text-center mt-2">
                  This may take a moment on first load
                </p>
              </div>
            </div>
          )}

          <div className="min-h-[400px]">
            <ImageGridV3
              images={paginatedImages}
              setCurrentImage={setCurrentImage}
              isLoading={isProcessing}
              searchDistance={searchDistance}
            />

            {/* Pagination */}
            {processedImages?.length > 0 && totalPages > 1 && (
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
                itemsPerPage={itemsPerPage}
                onItemsPerPageChange={handleItemsPerPageChange}
                totalItems={processedImages.length}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
