import { pipeline, env } from "@xenova/transformers";

// Configure environment
env.allowLocalModels = false;
env.useBrowserCache = true;

// Global pipeline instance
let embedPipeline = null;

// Initialize the pipeline
async function initializePipeline(
  modelName = "Xenova/all-MiniLM-L6-v2"
) {
  if (!embedPipeline) {
    console.log("Initializing embedding model:", modelName);
    self.postMessage({ status: "initiate" });
    try {
      embedPipeline = await pipeline("feature-extraction", modelName);
      self.postMessage({ status: "ready" });
    } catch (error) {
      console.error("Failed to initialize pipeline:", error);
      self.postMessage({ status: "error", error: error.message });
    }
  }
  return embedPipeline;
}

// Generate embeddings and search
async function performSearch(
  text,
  namespaces,
  distanceMetric,
  headers,
  searchId,
  limit = 20,
  threshold = 0.5
) {
  try {
    const pipe = await initializePipeline();

    if (!pipe) {
      throw new Error("Pipeline not initialized");
    }

    // Generate embedding
    const embedding = await pipe(text, {
      pooling: "mean",
      normalize: true,
    });
    const embeddingArray = Array.from(embedding.data);

    // Call backend search API
    const apiBase = self.location.origin;
    const response = await fetch(`${apiBase}/api/search/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        search: text,
        embedding: embeddingArray,
        namespaces,
        distanceMetric,
        limit,
        threshold,
      }),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    const results = await response.json();

    self.postMessage({
      status: "complete",
      output: results.results || results,
      searchId,
    });
  } catch (error) {
    console.error("Worker error:", error);
    self.postMessage({
      status: "error",
      error: error.message,
      searchId,
    });
  }
}

// Listen for messages from main thread
self.addEventListener("message", async (event) => {
  const {
    text,
    namespaces,
    distanceMetric,
    headers,
    searchId,
    limit,
    threshold,
  } = event.data;

  await performSearch(
    text,
    namespaces,
    distanceMetric,
    headers,
    searchId,
    limit,
    threshold
  );
});
