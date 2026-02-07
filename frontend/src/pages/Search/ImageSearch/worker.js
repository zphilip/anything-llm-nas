// Import Search model for API calls
import Search from "@/models/search";

const DISTANCE = {
  EUCLIDEAN: "l2",
  COSINE: "cosine",
  DOT: "dot"
};

// Simulate computation to show worker is ready
function simulateHeavyComputation() {
  let result = 0;
  for (let i = 0; i < 1000000000; i++) {
    result += i;
  }
  return result;
}

// Listen for messages from main thread
self.onmessage = async function(event) {
  const { text, distanceMetric, headers, namespaces, searchId, maxResults = 100, threshold: userThreshold } = event.data;
  
  // Perform some heavy computation (simulated)
  const sim_result = simulateHeavyComputation();

  // Send a message back to the main script
  self.postMessage(`==Result from Web Worker: ${sim_result}`);
  // Send the output back to the main thread
  self.postMessage({ status: 'ready' });
  
  // Use user-provided threshold, or fall back to defaults
  let threshold = userThreshold;
  if (threshold === undefined || threshold === null) {
    // Fallback to defaults if not provided
    if (distanceMetric === DISTANCE.COSINE) {
        threshold = 0.2;
    } else if (distanceMetric === DISTANCE.EUCLIDEAN) {
        threshold = 2.0;
    } else if (distanceMetric === DISTANCE.DOT) {
        threshold = 0.5;
    } else {
        threshold = 0.5;
    }
  }
  
  const result = await Search.searchText(
      text,
      namespaces,
      maxResults,
      threshold,
      distanceMetric,
      headers // Pass headers to searchText        
  );

  console.log("[Worker] Search completed, results:", result?.length || 0, "items");
  console.log("[Worker] First result:", result?.[0]);

  let images = result;
  // Send the output back to the main thread
  self.postMessage({
      status: 'complete',
      output: images,
      searchId: searchId  // Return the searchId to match requests
  });
};
