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
  const { text, distanceMetric, headers, namespaces, searchId } = event.data;
  
  // Perform some heavy computation (simulated)
  const sim_result = simulateHeavyComputation();

  // Send a message back to the main script
  self.postMessage(`==Result from Web Worker: ${sim_result}`);
  // Send the output back to the main thread
  self.postMessage({ status: 'ready' });
  
  // Search images with the provided namespaces
  let threshold = 0.5; // default threshold
  if (distanceMetric === DISTANCE.COSINE) {
      threshold = 0.2;
  } else if (distanceMetric === DISTANCE.EUCLIDEAN) {
      threshold = 500;
  }
  
  const result = await Search.searchText(
      text,
      namespaces,
      200, // default limit
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
