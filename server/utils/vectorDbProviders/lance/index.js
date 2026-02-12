const lancedb = require("@lancedb/lancedb");
const { toChunks, getEmbeddingEngineSelection, getLLMProvider, getMultimodalLLMProvider } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");
const path = require('path');

/**
 * Checks if the given input is an image based on its file extension.
 * @param {string} input - The file path or URL to check.
 * @returns {boolean} - Returns true if the input is an image, false otherwise.
 */
const isImage = function (input) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
  if (typeof input !== 'string') return false;
  const lowerInput = input.toLowerCase();
  return imageExtensions.some(extension => lowerInput.endsWith(extension));
};

/**
 * Removes UUID and .json extension from file path
 * @param {string} fullfilepath - The full file path
 * @returns {string} - The cleaned file path
 */
function removeUuidAndJson(fullfilepath) {
  return fullfilepath.replace(/-\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\.json$/, '');
}

/**
 * LancedDB Client connection object
 * @typedef {import('@lancedb/lancedb').Connection} LanceClient
 */

const LanceDb = {
  uri: `${
    !!process.env.STORAGE_DIR ? `${process.env.STORAGE_DIR}/` : "./storage/"
  }lancedb`,
  name: "LanceDb",

  /** @returns {Promise<{client: LanceClient}>} */
  connect: async function () {
    const client = await lancedb.connect(this.uri);
    return { client };
  },
  distanceToSimilarity: function (distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    // For cosine distance: similarity = 1 - distance
    // Cosine distance ranges from 0 (identical) to 2 (opposite)
    // Cosine similarity ranges from 1 (identical) to -1 (opposite)
    return Math.max(-1, Math.min(1, 1 - distance));
  },
  heartbeat: async function () {
    await this.connect();
    return { heartbeat: Number(new Date()) };
  },
  tables: async function () {
    const { client } = await this.connect();
    return await client.tableNames();
  },
  totalVectors: async function () {
    const { client } = await this.connect();
    const tables = await client.tableNames();
    let count = 0;
    for (const tableName of tables) {
      const table = await client.openTable(tableName);
      count += await table.countRows();
    }
    return count;
  },
  namespaceCount: async function (_namespace = null) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, _namespace);
    if (!exists) return 0;

    const table = await client.openTable(_namespace);
    return (await table.countRows()) || 0;
  },
  /**
   * Performs a SimilaritySearch + Reranking on a namespace.
   * @param {Object} params - The parameters for the rerankedSimilarityResponse.
   * @param {Object} params.client - The vectorDB client.
   * @param {string} params.namespace - The namespace to search in.
   * @param {string} params.query - The query to search for (plain text).
   * @param {number[]} params.queryVector - The vector of the query.
   * @param {number} params.similarityThreshold - The threshold for similarity.
   * @param {number} params.topN - the number of results to return from this process.
   * @param {string[]} params.filterIdentifiers - The identifiers of the documents to filter out.
   * @returns
   */
  rerankedSimilarityResponse: async function ({
    client,
    namespace,
    query,
    queryVector,
    topN = 4,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
  }) {
    const reranker = new NativeEmbeddingReranker();
    const collection = await client.openTable(namespace);
    const totalEmbeddings = await this.namespaceCount(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    /**
     * For reranking, we want to work with a larger number of results than the topN.
     * This is because the reranker can only rerank the results it it given and we dont auto-expand the results.
     * We want to give the reranker a larger number of results to work with.
     *
     * However, we cannot make this boundless as reranking is expensive and time consuming.
     * So we limit the number of results to a maximum of 50 and a minimum of 10.
     * This is a good balance between the number of results to rerank and the cost of reranking
     * and ensures workspaces with 10K embeddings will still rerank within a reasonable timeframe on base level hardware.
     *
     * Benchmarks:
     * On Intel Mac: 2.6 GHz 6-Core Intel Core i7 - 20 docs reranked in ~5.2 sec
     */
    const searchLimit = Math.max(
      10,
      Math.min(50, Math.ceil(totalEmbeddings * 0.1))
    );
    const vectorSearchResults = await collection
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(searchLimit)
      .toArray();

    await reranker
      .rerank(query, vectorSearchResults, { topK: topN })
      .then((rerankResults) => {
        rerankResults.forEach((item) => {
          if (this.distanceToSimilarity(item._distance) < similarityThreshold)
            return;
          const { vector: _, ...rest } = item;
          if (filterIdentifiers.includes(sourceIdentifier(rest))) {
            console.log(
              "LanceDB: A source was filtered from context as it's parent document is pinned."
            );
            return;
          }
          const score =
            item?.rerank_score || this.distanceToSimilarity(item._distance);

          result.contextTexts.push(rest.text);
          result.sourceDocuments.push({
            ...rest,
            score,
          });
          result.scores.push(score);
        });
      })
      .catch((e) => {
        console.error(e);
        console.error("LanceDB::rerankedSimilarityResponse", e.message);
      });

    return result;
  },

  /**
   * Performs a SimilaritySearch on a give LanceDB namespace.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {number[]} params.queryVector
   * @param {number} params.similarityThreshold
   * @param {number} params.topN
   * @param {string[]} params.filterIdentifiers
   * @returns
   */
  similarityResponse: async function ({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    console.log(`[COSINE] Similarity threshold: ${similarityThreshold}`);

    // Cap the limit to prevent LanceDB Arrow overflow errors
    const queryLimit = Math.min(topN, 200);

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(queryLimit)
      .toArray();

    console.log(`[MEMORY] Fetched ${response.length} cosine similarity results from LanceDB`);
    console.log(`[MEMORY] Response contains ${response.filter(r => r.imageBase64).length} items with imageBase64`);

    response.forEach((item, index) => {
      const similarity = this.distanceToSimilarity(item._distance);
      if (index < 5) {
        console.log(`  [Result ${index}] Distance: ${item._distance}, Similarity: ${similarity}`);
      }
      
      // DIAGNOSTIC: Analyze distance patterns
      if (index === 0) {
        console.log(`[VECTOR DIAGNOSTIC] First result analysis...`);
        console.log(`  - Query vector dimension: ${queryVector.length}`);
        console.log(`  - Cosine distance: ${item._distance.toFixed(6)}`);
        console.log(`  - Cosine similarity: ${(1 - item._distance).toFixed(6)}`);
        console.log(`  - Query vector stats:`);
        
        const qMagnitude = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0));
        const qMean = queryVector.reduce((sum, v) => sum + v, 0) / queryVector.length;
        const qStd = Math.sqrt(queryVector.reduce((sum, v) => sum + Math.pow(v - qMean, 2), 0) / queryVector.length);
        
        console.log(`    - Magnitude: ${qMagnitude.toFixed(6)} (should be ~1.0 if normalized)`);
        console.log(`    - Mean: ${qMean.toFixed(6)}`);
        console.log(`    - Std Dev: ${qStd.toFixed(6)}`);
        console.log(`    - Min: ${Math.min(...queryVector).toFixed(6)}`);
        console.log(`    - Max: ${Math.max(...queryVector).toFixed(6)}`);
        console.log(`    - First 10 values:`, queryVector.slice(0, 10));
        
        // Analyze what the distance tells us
        const cosineSim = 1 - item._distance;
        if (cosineSim > 0.9) {
          console.log(`  ✓ EXCELLENT: Very high similarity (${(cosineSim * 100).toFixed(1)}%) - semantically very close`);
        } else if (cosineSim > 0.7) {
          console.log(`  ✓ GOOD: High similarity (${(cosineSim * 100).toFixed(1)}%) - semantically related`);
        } else if (cosineSim > 0.5) {
          console.log(`  ~ MODERATE: Medium similarity (${(cosineSim * 100).toFixed(1)}%) - somewhat related`);
        } else if (cosineSim > 0.2) {
          console.log(`  ⚠️  LOW: Low similarity (${(cosineSim * 100).toFixed(1)}%) - weakly related`);
        } else if (cosineSim > -0.2) {
          console.log(`  ❌ VERY LOW: Nearly orthogonal (${(cosineSim * 100).toFixed(1)}%) - different semantic spaces`);
          console.log(`  This indicates query and stored embeddings are in DIFFERENT subspaces`);
          console.log(`  Possible causes:`);
          console.log(`    1. Cross-modal mismatch (text query vs image+text embeddings)`);
          console.log(`    2. Different embedding models used`);
          console.log(`    3. Query not being embedded correctly`);
        } else {
          console.log(`  ❌ NEGATIVE: Opposite direction (${(cosineSim * 100).toFixed(1)}%) - semantically opposite`);
        }
      }
      
      if (similarity < similarityThreshold)
        return;
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        console.log(
          "LanceDB: A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      // Strip base64 ONLY from context text (sent to LLM) to save memory
      const contextText = rest.text || '';
      result.contextTexts.push(contextText);
      
      // Preserve imageBase64 in sourceDocuments (displayed to user)
      result.sourceDocuments.push({
        ...rest,
        score: similarity,
      });
      result.scores.push(similarity);
    });
    console.log(`  Total results after filtering: ${result.contextTexts.length}`);

    return result;
  },

  /**
   * Performs a distance-based search using L2 (Euclidean) distance.
   * @param {LanceClient} client
   * @param {string} namespace
   * @param {number[]} queryVector
   * @param {number} distanceThreshold
   * @param {number} topN
   * @param {string[]} filterIdentifiers
   * @returns
   */
  /**
   * Performs a Dot Product Search on a given LanceDB namespace.
   * For normalized vectors, dot product ranges from -1 to 1, where higher = more similar.
   * @param {LanceClient} client
   * @param {string} namespace
   * @param {number[]} queryVector
   * @param {number} dotProductThreshold - Minimum dot product score (higher = more similar)
   * @param {number} topN
   * @param {string[]} filterIdentifiers
   * @returns
   */
  dotProductResponse: async function (
    client,
    namespace,
    queryVector,
    dotProductThreshold = 0.5,
    topN = 4,
    filterIdentifiers = []
  ) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    // Cap the limit to prevent LanceDB Arrow overflow errors
    // Tests show overflow occurs around 400, so cap at 200 to be safe
    const queryLimit = Math.min(topN * 2, 200);

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("dot")
      .limit(queryLimit)
      .toArray();

    console.log(`[MEMORY] Fetched ${response.length} dot product results from LanceDB`);
    
    // CRITICAL: Strip base64 data IMMEDIATELY to prevent OOM
    let totalBase64Stripped = 0;
    const cleanedResponse = response.map((item) => {
      const cleaned = { ...item };
      
      if (cleaned.pageContent && typeof cleaned.pageContent === 'string' && cleaned.pageContent.length > 10000) {
        const originalSize = cleaned.pageContent.length;
        cleaned.pageContent = `[Image data stripped - ${(originalSize / 1024).toFixed(0)}KB]`;
        totalBase64Stripped += originalSize;
      }
      
      // Remove imageBase64 field entirely - not used for display
      if (cleaned.imageBase64 && typeof cleaned.imageBase64 === 'string') {
        totalBase64Stripped += cleaned.imageBase64.length;
        delete cleaned.imageBase64;
      }
      
      return cleaned;
    });
    
    if (totalBase64Stripped > 0) {
      console.log(`[MEMORY] Stripped ${(totalBase64Stripped / 1024 / 1024).toFixed(2)}MB of base64 data`);
    }

    console.log(`[DOT PRODUCT] Retrieved ${cleanedResponse.length} results`);

    cleanedResponse.forEach((item, index) => {
      // For dot product, _distance is actually the dot product score
      // Higher values = more similar (range: -1 to 1 for normalized vectors)
      const dotProductScore = item._distance;
      
      if (index < 5) {
        console.log(`  [Result ${index}] Dot Product Score: ${dotProductScore.toFixed(6)}`);
      }
      
      // Filter: keep items with score ABOVE threshold (higher = better)
      if (dotProductScore < dotProductThreshold)
        return;
      
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        console.log(
          "LanceDB: A source was filtered from context as its parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({
        ...rest,
        score: dotProductScore,
      });
      result.scores.push(dotProductScore);
    });
    console.log(`  Total results after filtering: ${result.contextTexts.length}`);

    // Sort by dot product score (descending - higher scores are better)
    const indices = result.scores
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(item => item.index);
    
    return {
      contextTexts: indices.map(i => result.contextTexts[i]),
      sourceDocuments: indices.map(i => result.sourceDocuments[i]),
      scores: indices.map(i => result.scores[i]),
    };
  },

  distanceResponse: async function (
    client,
    namespace,
    queryVector,
    distanceThreshold = 1.0,
    topN = 4,
    filterIdentifiers = []
  ) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    // DIAGNOSTIC: Check query vector statistics
    const queryMagnitude = Math.sqrt(queryVector.reduce((sum, val) => sum + val * val, 0));
    const queryMean = queryVector.reduce((sum, val) => sum + val, 0) / queryVector.length;
    const queryStd = Math.sqrt(queryVector.reduce((sum, val) => sum + Math.pow(val - queryMean, 2), 0) / queryVector.length);
    console.log("[DIAGNOSTIC] Query Vector Stats:");
    console.log(`  - Magnitude: ${queryMagnitude.toFixed(6)}`);
    console.log(`  - Mean: ${queryMean.toFixed(6)}`);
    console.log(`  - Std Dev: ${queryStd.toFixed(6)}`);
    console.log(`  - Min: ${Math.min(...queryVector).toFixed(6)}`);
    console.log(`  - Max: ${Math.max(...queryVector).toFixed(6)}`);
    console.log(`  - First 10 values:`, queryVector.slice(0, 10));

    // Cap the limit to prevent LanceDB Arrow overflow errors
    // LanceDB has issues with very large limits (>300) causing "offset overflow"
    const queryLimit = Math.min(topN * 2, 200);
    console.log(`  - Query Limit: ${queryLimit} (topN=${topN})`);

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("l2")
      .limit(queryLimit)
      .toArray();

    console.log(`[MEMORY] Fetched ${response.length} results from LanceDB`);
    
    // Keep original response with imageBase64 for sources, we'll strip when adding to contextTexts
    console.log(`[MEMORY] Response contains ${response.filter(r => r.imageBase64).length} items with imageBase64`);

    // DIAGNOSTIC: Check first stored vector if available
    if (response.length > 0) {
      console.log("[DIAGNOSTIC] First Result Keys:", Object.keys(response[0]));
      // Create safe version for logging without base64 content
      const safeResult = { ...response[0] };
      if (safeResult.pageContent && safeResult.pageContent.length > 100) {
        safeResult.pageContent = `[${safeResult.pageContent.length} chars]`;
      }
      if (safeResult.imageBase64 && safeResult.imageBase64.length > 100) {
        safeResult.imageBase64 = `[${safeResult.imageBase64.length} chars]`;
      }
      if (safeResult.text && safeResult.text.length > 500) {
        safeResult.text = safeResult.text.substring(0, 500) + '...';
      }
      console.log("[DIAGNOSTIC] First Result (safe):", JSON.stringify(safeResult, null, 2).substring(0, 1000));
      
      if (response[0].vector && Array.isArray(response[0].vector)) {
        const storedVector = response[0].vector;
        const storedMagnitude = Math.sqrt(storedVector.reduce((sum, val) => sum + val * val, 0));
        const storedMean = storedVector.reduce((sum, val) => sum + val, 0) / storedVector.length;
        const storedStd = Math.sqrt(storedVector.reduce((sum, val) => sum + Math.pow(val - storedMean, 2), 0) / storedVector.length);
        console.log("[DIAGNOSTIC] First Stored Vector Stats:");
        console.log(`  - Magnitude: ${storedMagnitude.toFixed(6)}`);
        console.log(`  - Mean: ${storedMean.toFixed(6)}`);
        console.log(`  - Std Dev: ${storedStd.toFixed(6)}`);
        console.log(`  - Min: ${Math.min(...storedVector).toFixed(6)}`);
        console.log(`  - Max: ${Math.max(...storedVector).toFixed(6)}`);
        console.log(`  - First 10 values:`, storedVector.slice(0, 10));
        
        // Calculate dot product to check if they're similar
        const dotProduct = queryVector.reduce((sum, val, i) => sum + val * storedVector[i], 0);
        console.log(`  - Dot Product with Query: ${dotProduct.toFixed(6)}`);
        console.log(`  - Cosine Similarity: ${(dotProduct / (queryMagnitude * storedMagnitude)).toFixed(6)}`);
      } else {
        console.log("[DIAGNOSTIC] Vector field not available in response (LanceDB doesn't return vectors by default)");
      }
    }

    if (response.some(item => isNaN(item._distance))) {
      console.warn("LanceDB returned NaN distances. Ensure your vectors are normalized.");
    }

    response.forEach((item, index) => {
      if (index < 5) {
        console.log(`  [Result ${index}] L2 Distance: ${item._distance}`);
      }
      // For L2 distance, lower values are better (opposite of similarity)
      // Only include items with distance LESS than the threshold
      if (item._distance > distanceThreshold)
        return;
      
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        console.log(
          "LanceDB: A source was filtered from context as its parent document is pinned."
        );
        return;
      }

      // Strip base64 ONLY from context text (sent to LLM) to save memory
      const contextText = rest.text || '';
      result.contextTexts.push(contextText);
      
      // Preserve imageBase64 in sourceDocuments (displayed to user)
      result.sourceDocuments.push({
        ...rest,
        score: item._distance, // Use raw L2 distance score
      });
      result.scores.push(item._distance);
    });
    console.log(`  Total results after filtering: ${result.contextTexts.length}`);

    // Sort by distance (ascending - smaller distances are better)
    const indices = result.scores
      .map((score, index) => ({ score, index }))
      .sort((a, b) => a.score - b.score)
      .slice(0, topN)
      .map(item => item.index);
    
    return {
      contextTexts: indices.map(i => result.contextTexts[i]),
      sourceDocuments: indices.map(i => result.sourceDocuments[i]),
      scores: indices.map(i => result.scores[i]),
    };
  },

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  namespace: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client.openTable(namespace).catch(() => false);
    if (!collection) return null;

    return {
      ...collection,
    };
  },
  
  /**
   * Embeds text using the multimodal embedder (for queries when multimodal embedder is configured)
   * @param {string} text - The text to embed
   * @param {string} basePath - The multimodal embedder base path
   * @param {string} model - The multimodal embedder model
   * @returns {Promise<number[]>} - The embedding vector
   */
  embedTextWithMultimodalEmbedder: async function (text, basePath, model) {
    const EmbedderEngine = getEmbeddingEngineSelection();
    
    // Check if the embedder has the multimodal text embedding method
    if (typeof EmbedderEngine.embedTextWithMultimodal === 'function') {
      return await EmbedderEngine.embedTextWithMultimodal(text, basePath, model);
    }
    
    // Fallback: if the method doesn't exist, throw error
    throw new Error("Multimodal embedder does not support text-only embedding");
  },
  
  /**
   *
   * @param {LanceClient} client
   * @param {number[]} data
   * @param {string} namespace
   * @returns
   */
  updateOrCreateCollection: async function (client, data = [], namespace) {
    // Debug: Check for empty strings in the data being submitted to LanceDB
    console.log(`[LanceDB] Inserting ${data.length} records into collection "${namespace}"`);
    for (let i = 0; i < Math.min(data.length, 2); i++) {
      console.log(`[LanceDB DEBUG] Record ${i} fields:`, Object.keys(data[i]));
      for (const [key, value] of Object.entries(data[i])) {
        if (key === 'vector') continue; // Skip vector array
        if (value === "") {
          console.error(`  ❌ EMPTY STRING in LanceDB submission: ${key} = ""`);
        } else if (typeof value === 'string') {
          console.log(`  ✓ ${key} = "${value.substring(0, 30)}${value.length > 30 ? '...' : ''}"`);
        } else {
          console.log(`  ✓ ${key} = ${typeof value}`);
        }
      }
    }
    
    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      try {
        const collection = await client.openTable(namespace);
        await collection.add(data);
        return true;
      } catch (error) {
        // If we get an Arrow schema error about empty strings, the table has corrupted data
        if (error.message.includes('Need at least 4 bytes in buffers[0]') || 
            error.message.includes('Invalid argument error')) {
          console.error(`[LanceDB] Schema conflict detected in collection "${namespace}"`);
          console.error(`[LanceDB] This is caused by old records with empty string fields.`);
          console.error(`[LanceDB] Dropping and recreating collection...`);
          
          // Drop the corrupted table
          await client.dropTable(namespace);
          
          // Create fresh table with new data
          await client.createTable(namespace, data);
          console.log(`[LanceDB] ✓ Collection "${namespace}" recreated successfully`);
          return true;
        }
        // Re-throw other errors
        throw error;
      }
    }

    await client.createTable(namespace, data);
    return true;
  },
  hasNamespace: async function (namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    return exists;
  },
  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  namespaceExists: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collections = await client.tableNames();
    return collections.includes(namespace);
  },
  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  deleteVectorsInNamespace: async function (client, namespace = null) {
    await client.dropTable(namespace);
    return true;
  },
  deleteDocumentFromNamespace: async function (namespace, docId) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    if (!exists) {
      console.error(
        `LanceDB:deleteDocumentFromNamespace - namespace ${namespace} does not exist.`
      );
      return;
    }

    const { DocumentVectors } = require("../../../models/vectors");
    const table = await client.openTable(namespace);
    const vectorIds = (await DocumentVectors.where({ docId })).map(
      (record) => record.vectorId
    );

    if (vectorIds.length === 0) return;
    await table.delete(`id IN (${vectorIds.map((v) => `'${v}'`).join(",")})`);
    return true;
  },
  addDocumentToNamespace: async function (
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const { pageContent, docId, ...metadata } = documentData;
      if (!pageContent || pageContent.length == 0) return false;

      console.log("Adding new vectorized document into namespace", namespace);
      console.log("[DEBUG] documentData keys:", Object.keys(documentData));
      console.log("[DEBUG] Checking documentData for empty strings:");
      for (const [key, value] of Object.entries(documentData)) {
        // Skip logging large base64 fields
        if (key === 'pageContent' || key === 'imageBase64') {
          console.log(`  ✓ ${key} = <base64 data - ${typeof value === 'string' ? value.length : 0} bytes>`);
          continue;
        }
        if (value === "") {
          console.error(`  ❌ EMPTY STRING IN documentData: ${key} = ""`);
        } else if (typeof value === 'string') {
          console.log(`  ✓ ${key} = "${value.substring(0, 50)}${value.length > 50 ? '...' : ''}"`);
        } else {
          console.log(`  ✓ ${key} = ${typeof value} (${JSON.stringify(value).substring(0, 50)}...)`);
        }
      }
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const { chunks } = cacheResult;
          const documentVectors = [];
          const submissions = [];

          for (const chunk of chunks) {
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const { id: _id, ...metadata } = chunk.metadata;
              documentVectors.push({ docId, vectorId: id });
              submissions.push({ id: id, vector: chunk.values, ...metadata });
            });
          }

          await this.updateOrCreateCollection(client, submissions, namespace);
          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `xyz.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const imageDescribeEngine = await getMultimodalLLMProvider();
      
      // Check fileType from metadata (set by collector) instead of checking file extension
      const fileType = metadata.fileType || (isImage(fullFilePath) ? "image" : "text");
      console.log("Processing document with fileType:", fileType, "from:", fullFilePath);
      
      // Filter base64 from metadata before logging
      const { imageBase64: _img, pageContent: _page, ...metadataForLog } = metadata;
      console.log("[DEBUG] Raw metadata received:", JSON.stringify(metadataForLog, null, 2));

      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });

      // Handle images differently - check for multimodal embedder first
      if (fileType === "image") {
        console.log("===============================================");
        console.log("[IMAGE PROCESSING] Starting image embedding...");
        console.log("===============================================");
        
        // Load multimodal embedder settings
        const { SystemSettings: SS } = require("../../../models/systemSettings");
        const embedderSettings = await SS.multimodalEmbedderPreferenceKeys();
        console.log("[MULTIMODAL EMBEDDER] Settings from database:", JSON.stringify(embedderSettings, null, 2));
        
        const hasMultimodalEmbedderConfigured = embedderSettings.MultimodalEmbedderProvider && 
                                      embedderSettings.MultimodalEmbedderProvider !== 'none' && 
                                      embedderSettings.MultimodalEmbedderBasePath &&
                                      embedderSettings.MultimodalEmbedderBasePath.trim() !== '';
        
        // Use a mutable variable for fallback logic
        let useMultimodalEmbedder = hasMultimodalEmbedderConfigured;
        
        console.log("[EMBEDDING MODE CHECK] Multimodal Embedder available:", hasMultimodalEmbedderConfigured);
        console.log("  - Provider:", embedderSettings.MultimodalEmbedderProvider || "NOT SET");
        console.log("  - Base Path:", embedderSettings.MultimodalEmbedderBasePath || "NOT SET");
        console.log("  - Model:", embedderSettings.MultimodalEmbedderModelPref || "NOT SET");
        
        if (useMultimodalEmbedder) {
          console.log("[EMBEDDING MODE] ✓ Using Strategy 1: Multimodal Embedder (direct image embedding with Vision LLM description)");
        } else {
          console.log("[EMBEDDING MODE] ✓ Using Strategy 2: Vision LLM (description + text embedding)");
        }
        console.log("===============================================");
        
        const documentVectors = [];
        const imageVectors = []; // Add imageVectors array like mything-llm
        const submissions = [];
        
        // STRATEGY 1: Direct image embedding using multimodal embedder WITH Vision LLM description
        if (useMultimodalEmbedder) {
          try {
            console.log("[STRATEGY 1] Step 1: Getting image description from Vision LLM...");
            
            // Check if the LLM provider supports image description
            if (typeof imageDescribeEngine.describeImages !== 'function') {
              console.error(`[STRATEGY 1] LLM provider does not support image description.`);
              throw new Error("Vision LLM not available for Strategy 1");
            }
            
            // Get semantic description from Vision LLM first
            const fileDescription = metadata.title || metadata.description || fullFilePath.split('/').pop() || "Image file";
            console.log("[STRATEGY 1] Getting description for:", fileDescription);
            
            const imageDescriptions = await imageDescribeEngine.describeImages([pageContent], [fileDescription]);
            console.log("[STRATEGY 1] Vision LLM response:", JSON.stringify(imageDescriptions, null, 2).substring(0, 300));
            
            const desc = imageDescriptions[0].description; // desc is array: [filename, AI_description]
            const aiDescription = Array.isArray(desc) ? desc[1] : desc; // Get the AI description part
            
            console.log("[STRATEGY 1] Using AI description:", aiDescription.substring(0, 200) + "...");
            console.log("[STRATEGY 1] Step 2: Embedding image with multimodal embedder...");
            
            // Get the multimodal embedder instance
            const { embedImageDirect } = EmbedderEngine;
            
            if (typeof embedImageDirect === 'function') {
              // Call the multimodal embedder with rich semantic description
              const imageEmbedding = await EmbedderEngine.embedImageDirect(
                pageContent, // base64 image
                embedderSettings.MultimodalEmbedderBasePath,
                embedderSettings.MultimodalEmbedderModelPref,
                aiDescription // Rich AI-generated description
              );
              
              console.log(`[STRATEGY 1] ✓ Received image embedding with ${imageEmbedding.length} dimensions`);
              
              // DIAGNOSTIC: Check if embeddings are unique
              const embMagnitude = Math.sqrt(imageEmbedding.reduce((sum, val) => sum + val * val, 0));
              const embMean = imageEmbedding.reduce((sum, val) => sum + val, 0) / imageEmbedding.length;
              const embStd = Math.sqrt(imageEmbedding.reduce((sum, val) => sum + Math.pow(val - embMean, 2), 0) / imageEmbedding.length);
              console.log(`[STRATEGY 1 DIAGNOSTIC] Embedding Stats:`);
              console.log(`  - Magnitude: ${embMagnitude.toFixed(6)}`);
              console.log(`  - Mean: ${embMean.toFixed(6)}`);
              console.log(`  - Std Dev: ${embStd.toFixed(6)}`);
              console.log(`  - Min: ${Math.min(...imageEmbedding).toFixed(6)}`);
              console.log(`  - Max: ${Math.max(...imageEmbedding).toFixed(6)}`);
              console.log(`  - First 10 values:`, imageEmbedding.slice(0, 10));
              console.log(`  - Last 10 values:`, imageEmbedding.slice(-10));
              console.log(`  - Sum of all values: ${imageEmbedding.reduce((sum, val) => sum + val, 0).toFixed(6)}`);
              
              // Create vector record with image embedding AND AI description
              const id = uuidv4();
              
              // Filter out empty strings from metadata to prevent Arrow schema errors
              const cleanMetadata = {};
              for (const [key, value] of Object.entries(metadata)) {
                // Always filter out empty strings, especially chunkSource
                if (value !== "" && value !== null && value !== undefined) {
                  cleanMetadata[key] = value;
                } else if (value === "" && key === "chunkSource") {
                  // Fix old files with empty chunkSource
                  cleanMetadata[key] = "image-upload";
                }
              }
              
              const vectorRecord = {
                id: id,
                values: imageEmbedding,
                metadata: { 
                  ...cleanMetadata, 
                  text: aiDescription || "Image content", // Ensure text is never empty
                  embeddingMode: "multimodal_direct"
                },
              };
              
              imageVectors.push(vectorRecord);
              submissions.push({
                ...vectorRecord.metadata,
                id: vectorRecord.id,
                vector: vectorRecord.values,
              });
              documentVectors.push({ docId, vectorId: vectorRecord.id });
              
              // Filter out base64 fields before logging
              const { imageBase64: _img, pageContent: _page, ...metadataForLog } = vectorRecord.metadata;
              console.log("[STRATEGY 1 DEBUG] Submission data:", JSON.stringify({
                id: vectorRecord.id,
                metadataKeys: Object.keys(vectorRecord.metadata),
                metadata: metadataForLog,
              }, null, 2));
              console.log("[STRATEGY 1 DEBUG] Checking for empty strings in metadata:");
              for (const [key, value] of Object.entries(vectorRecord.metadata)) {
                // Skip logging large base64 fields
                if (key === 'imageBase64' || key === 'pageContent') {
                  console.log(`  ✓ ${key} = <base64 data - ${typeof value === 'string' ? value.length : 0} bytes>`);
                  continue;
                }
                if (value === "") {
                  console.error(`  ❌ FOUND EMPTY STRING: ${key} = ""`);  
                } else {
                  console.log(`  ✓ ${key} = ${typeof value === 'string' ? '"' + value.substring(0, 50) + '..."' : value}`);
                }
              }
              
              console.log("[STRATEGY 1] ✓ Successfully created vector record for image");
            } else {
              console.warn("[STRATEGY 1] embedImageDirect method not available on EmbedderEngine, falling back to Strategy 2");
              throw new Error("embedImageDirect not available");
            }
          } catch (error) {
            console.error("[STRATEGY 1] Failed to embed image with multimodal embedder:", error.message);
            console.log("[STRATEGY 1] Falling back to Strategy 2 (Vision LLM)...");
            // Don't throw - fall through to Strategy 2
            useMultimodalEmbedder = false; // Set to false to trigger Strategy 2 below
          }
        }
        
        // STRATEGY 2: Vision LLM description + text embedding (only if Strategy 1 failed or not available)
        if (!useMultimodalEmbedder) {
          console.log("[STRATEGY 2] Using Vision LLM for image description + text embedding...");
          
          // Check if the LLM provider supports image description
          if (typeof imageDescribeEngine.describeImages !== 'function') {
            console.error(`addDocumentToNamespace: LLM provider does not support image description. Please use 'ollama' or 'llamacpp' for image vectorization.`);
            return { 
              vectorized: false, 
              error: `LLM provider does not support image description. Please configure LLM_PROVIDER to 'ollama' or 'llamacpp' in your .env file.`
            };
          }
        
        // Get image description from LLM - use title (filename) as fallback if description is missing
        // metadata.description is often null, so use metadata.title (which contains the filename)
        const fileDescription = metadata.title || metadata.description || fullFilePath.split('/').pop() || "Image file";
        console.log("[IMAGE EMBEDDING DEBUG] metadata.title:", metadata.title);
        console.log("[IMAGE EMBEDDING DEBUG] metadata.description:", metadata.description);
        console.log("[IMAGE EMBEDDING DEBUG] Using fileDescription:", fileDescription);
        
        const imageDescriptions = await imageDescribeEngine.describeImages([pageContent], [fileDescription]);
        console.log("[IMAGE EMBEDDING DEBUG] imageDescriptions result:", JSON.stringify(imageDescriptions, null, 2));
        
        const desc = imageDescriptions[0].description; // desc is already an array: [description, image_description]
        console.log("[IMAGE EMBEDDING DEBUG] desc extracted:", desc);
        console.log("[IMAGE EMBEDDING DEBUG] desc type:", Array.isArray(desc) ? 'Array' : typeof desc);
        console.log("[IMAGE EMBEDDING DEBUG] desc length:", desc.length);
        
        // desc should be an array: [filename, AI_description]
        // embedChunks expects array of strings, so this is correct
        const textEmbeddings = await EmbedderEngine.embedChunks(desc);
        console.log("[IMAGE EMBEDDING DEBUG] textEmbeddings count:", textEmbeddings.length);
        console.log("[IMAGE EMBEDDING DEBUG] textEmbeddings[0] dimension:", textEmbeddings[0]?.length);
        console.log("[IMAGE EMBEDDING DEBUG] textEmbeddings[1] dimension:", textEmbeddings[1]?.length);
        
        if (!!textEmbeddings && textEmbeddings.length > 0) {
          console.log(`[IMAGE EMBEDDING DEBUG] Processing ${textEmbeddings.length} embeddings`);
          for (const [i, textEmbedding] of textEmbeddings.entries()) {
            const id = uuidv4();
            
            // Calculate vector magnitude to check normalization
            const magnitude = Math.sqrt(textEmbedding.reduce((sum, val) => sum + val * val, 0));
            console.log(`[IMAGE EMBEDDING ${i}] Dimension: ${textEmbedding.length}, Magnitude: ${magnitude.toFixed(6)}`);
            console.log(`[IMAGE EMBEDDING ${i}] First 5 values:`, textEmbedding.slice(0, 5));
            console.log(`[IMAGE EMBEDDING ${i}] Description: "${desc[i].substring(0, 100)}..."`);
            
            // Filter out empty strings from metadata
            const cleanMetadata = {};
            for (const [key, value] of Object.entries(metadata)) {
              if (value !== "" && value !== null && value !== undefined) {
                cleanMetadata[key] = value;
              } else if (value === "" && key === "chunkSource") {
                // Fix old files with empty chunkSource
                cleanMetadata[key] = "image-upload";
              }
            }
            
            const vectorRecord = {
              id: id,
              values: textEmbedding,
              metadata: { ...cleanMetadata, text: desc[i] || "Image content" },
            };
            
            imageVectors.push(vectorRecord);
            submissions.push({
              ...vectorRecord.metadata,
              id: vectorRecord.id,
              vector: vectorRecord.values,
            });
            documentVectors.push({ docId, vectorId: vectorRecord.id });
          }
          console.log(`[IMAGE EMBEDDING DEBUG] Created ${imageVectors.length} vector records`)
        } else {
          throw new Error(
            "Could not embed image description! This document will not be recorded."
          );
        }
        } // End of Strategy 2
        
        const { client } = await this.connect();
        
        if (imageVectors.length > 0) {
          const chunks = [];
          for (const chunk of toChunks(imageVectors, 500)) chunks.push(chunk);

          console.log("Inserting vectorized image into LanceDB collection.");
          await this.updateOrCreateCollection(client, submissions, namespace);
          await storeVectorResult(chunks, fullFilePath);
        }
        
        await DocumentVectors.bulkInsert(documentVectors);
        return { vectorized: true, error: null };
      }

      // Handle text documents normally
      const textChunks = await textSplitter.splitText(pageContent);

      console.log("Snippets created from document:", textChunks.length);
      const documentVectors = [];
      const vectors = [];
      const submissions = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          // Filter out empty strings from metadata
          const cleanMetadata = {};
          for (const [key, value] of Object.entries(metadata)) {
            if (value !== "" && value !== null && value !== undefined) {
              cleanMetadata[key] = value;
            } else if (value === "" && key === "chunkSource") {
              // Fix old files with empty chunkSource  
              cleanMetadata[key] = "text-upload";
            }
          }
          
          const vectorRecord = {
            id: uuidv4(),
            values: vector,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/2def486af734c0ca87285a48f1a04c057ab74bdf/langchain/src/vectorstores/pinecone.ts#L64
            metadata: { ...cleanMetadata, text: textChunks[i] || "" },
          };

          vectors.push(vectorRecord);
          submissions.push({
            ...vectorRecord.metadata,
            id: vectorRecord.id,
            vector: vectorRecord.values,
          });
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      if (vectors.length > 0) {
        const chunks = [];
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        console.log("Inserting vectorized chunks into LanceDB collection.");
        const { client } = await this.connect();
        await this.updateOrCreateCollection(client, submissions, namespace);
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      console.error("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  },
  performSimilaritySearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    rerank = false,
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    // Check if Multimodal Embedder is configured - if so, use it for queries too
    const { SystemSettings: SS } = require("../../../models/systemSettings");
    const embedderSettings = await SS.multimodalEmbedderPreferenceKeys();
    const hasMultimodalEmbedder = embedderSettings.MultimodalEmbedderProvider && 
                                  embedderSettings.MultimodalEmbedderProvider !== 'none' && 
                                  embedderSettings.MultimodalEmbedderBasePath &&
                                  embedderSettings.MultimodalEmbedderBasePath.trim() !== '';
    
    let queryVector;
    if (hasMultimodalEmbedder) {
      console.log("[SEARCH QUERY] Using Multimodal Embedder for text query (to match image embeddings)");
      console.log(`[SEARCH QUERY DEBUG] Input text: "${input}"`);
      console.log(`[SEARCH QUERY DEBUG] BasePath: ${embedderSettings.MultimodalEmbedderBasePath}`);
      console.log(`[SEARCH QUERY DEBUG] Model: ${embedderSettings.MultimodalEmbedderModelPref}`);
      try {
        // Use multimodal embedder for text-only query (no image_data)
        queryVector = await this.embedTextWithMultimodalEmbedder(
          input,
          embedderSettings.MultimodalEmbedderBasePath,
          embedderSettings.MultimodalEmbedderModelPref
        );
        console.log("[SEARCH QUERY] ✓ Multimodal embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY] ✖ Multimodal embedder failed:", error.message);
        console.warn("[SEARCH QUERY] Falling back to standard text embedder...");
        try {
          queryVector = await LLMConnector.embedTextInput(input);
          console.log("[SEARCH QUERY] ✓ Fallback embedding successful, dimension:", queryVector?.length);
        } catch (fallbackError) {
          console.error("[SEARCH QUERY] ✖ Fallback also failed:", fallbackError.message);
          throw new Error(`Both embedders failed: ${error.message} / ${fallbackError.message}`);
        }
      }
    } else {
      console.log("[SEARCH QUERY] Using standard text embedder");
      try {
        queryVector = await LLMConnector.embedTextInput(input);
        console.log("[SEARCH QUERY] ✓ Standard embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY] ✖ Standard embedder failed:", error.message);
        throw error;
      }
    }
    
    // Validate query vector
    if (!queryVector || !Array.isArray(queryVector) || queryVector.length === 0) {
      throw new Error(`Invalid query vector: ${typeof queryVector}, length: ${queryVector?.length}`);
    }
    
    console.log("[AnythingLLM DEBUG] performSimilaritySearch:");
    console.log("  - Namespace:", namespace);
    console.log("  - Search Input:", input);
    console.log("  - Query Vector Dimension:", queryVector.length);
    console.log("  - Query Vector (first 10):", queryVector.slice(0, 10));
    console.log("  - Similarity Threshold:", similarityThreshold);
    console.log("  - TopN:", topN);
    
    let result;
    try {
      result = rerank
        ? await this.rerankedSimilarityResponse({
            client,
            namespace,
            query: input,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
          })
        : await this.similarityResponse({
            client,
            namespace,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
          });
      console.log("[AnythingLLM DEBUG] similarityResponse returned:", {
        contextTextsCount: result?.contextTexts?.length,
        sourceDocumentsCount: result?.sourceDocuments?.length
      });
    } catch (dbError) {
      console.error("[AnythingLLM DEBUG] ✖ similarityResponse failed:", dbError.message);
      console.error("[AnythingLLM DEBUG] Error details:", {
        name: dbError.name,
        code: dbError.code,
        stack: dbError.stack
      });
      
      if (dbError.message?.includes('dimension') || dbError.message?.includes('vector column')) {
        throw new Error(`Vector dimension mismatch: Query has ${queryVector.length} dimensions. Collection may have different size. Recreate collection.`);
      }
      
      throw dbError;
    }

    const { contextTexts, sourceDocuments } = result;
    const sources = sourceDocuments.map((metadata, i) => {
      return { metadata: { ...metadata, text: contextTexts[i] } };
    });
    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  },

  performDotProductSearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    dotProductThreshold = 0.5,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performDotProductSearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    // Check if Multimodal Embedder is configured
    const { SystemSettings: SS } = require("../../../models/systemSettings");
    const embedderSettings = await SS.multimodalEmbedderPreferenceKeys();
    const hasMultimodalEmbedder = embedderSettings.MultimodalEmbedderProvider && 
                                  embedderSettings.MultimodalEmbedderProvider !== 'none' && 
                                  embedderSettings.MultimodalEmbedderBasePath &&
                                  embedderSettings.MultimodalEmbedderBasePath.trim() !== '';
    
    let queryVector;
    if (hasMultimodalEmbedder) {
      console.log("[SEARCH QUERY DOT] Using Multimodal Embedder for text query");
      try {
        queryVector = await this.embedTextWithMultimodalEmbedder(
          input,
          embedderSettings.MultimodalEmbedderBasePath,
          embedderSettings.MultimodalEmbedderModelPref
        );
        console.log("[SEARCH QUERY DOT] ✓ Multimodal embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY DOT] ✖ Multimodal embedder failed:", error.message);
        console.warn("[SEARCH QUERY DOT] Falling back to standard text embedder...");
        try {
          queryVector = await LLMConnector.embedTextInput(input);
          console.log("[SEARCH QUERY DOT] ✓ Fallback embedding successful, dimension:", queryVector?.length);
        } catch (fallbackError) {
          console.error("[SEARCH QUERY DOT] ✖ Fallback also failed:", fallbackError.message);
          throw new Error(`Both embedders failed: ${error.message} / ${fallbackError.message}`);
        }
      }
    } else {
      console.log("[SEARCH QUERY DOT] Using standard text embedder");
      try {
        queryVector = await LLMConnector.embedTextInput(input);
        console.log("[SEARCH QUERY DOT] ✓ Standard embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY DOT] ✖ Standard embedder failed:", error.message);
        throw error;
      }
    }
    
    // Validate query vector
    if (!queryVector || !Array.isArray(queryVector) || queryVector.length === 0) {
      throw new Error(`Invalid query vector: ${typeof queryVector}, length: ${queryVector?.length}`);
    }
    
    console.log("[AnythingLLM DEBUG] performDotProductSearch:");
    console.log("  - Namespace:", namespace);
    console.log("  - Search Input:", input);
    console.log("  - Query Vector Dimension:", queryVector.length);
    console.log("  - Dot Product Threshold:", dotProductThreshold);
    console.log("  - TopN:", topN);
    
    let contextTexts, sourceDocuments;
    try {
      const result = await this.dotProductResponse(
        client,
        namespace,
        queryVector,
        dotProductThreshold,
        topN,
        filterIdentifiers
      );
      contextTexts = result.contextTexts;
      sourceDocuments = result.sourceDocuments;
      console.log("[AnythingLLM DEBUG] dotProductResponse returned:", {
        contextTextsCount: contextTexts?.length,
        sourceDocumentsCount: sourceDocuments?.length
      });
    } catch (dbError) {
      console.error("[AnythingLLM DEBUG] ✖ dotProductResponse failed:", dbError.message);
      console.error("[AnythingLLM DEBUG] Error details:", {
        name: dbError.name,
        code: dbError.code,
        stack: dbError.stack
      });
      
      if (dbError.message?.includes('dimension') || dbError.message?.includes('vector column')) {
        throw new Error(`Vector dimension mismatch: Query has ${queryVector.length} dimensions. Collection may have different size. Recreate collection.`);
      }
      
      throw dbError;
    }

    const sources = await Promise.all(sourceDocuments.map(async (metadata, i) => {
      let text = contextTexts[i];
      if (process.env.ENABLE_TRANSLATION === 'true' && LLMConnector.translateText) {
        text = await LLMConnector.translateText(contextTexts[i], "english", "chinese");
      }
      return { metadata: { ...metadata, text } };
    }));

    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  },

  performDistanceSearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    distanceThreshold = 1.0,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performDistanceSearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    // Check if Multimodal Embedder is configured - if so, use it for queries too
    const { SystemSettings: SS } = require("../../../models/systemSettings");
    const embedderSettings = await SS.multimodalEmbedderPreferenceKeys();
    const hasMultimodalEmbedder = embedderSettings.MultimodalEmbedderProvider && 
                                  embedderSettings.MultimodalEmbedderProvider !== 'none' && 
                                  embedderSettings.MultimodalEmbedderBasePath &&
                                  embedderSettings.MultimodalEmbedderBasePath.trim() !== '';
    
    let queryVector;
    if (hasMultimodalEmbedder) {
      console.log("[SEARCH QUERY] Using Multimodal Embedder for text query (to match image embeddings)");
      console.log("[SEARCH QUERY] Embedder settings:", {
        basePath: embedderSettings.MultimodalEmbedderBasePath,
        model: embedderSettings.MultimodalEmbedderModelPref
      });
      try {
        // Use multimodal embedder for text-only query (no image_data)
        // This ensures query vectors match the dimension of stored image embeddings
        queryVector = await this.embedTextWithMultimodalEmbedder(
          input,
          embedderSettings.MultimodalEmbedderBasePath,
          embedderSettings.MultimodalEmbedderModelPref
        );
        console.log("[SEARCH QUERY] ✓ Multimodal embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY] ❌ Multimodal embedder FAILED:", error.message);
        console.error("[SEARCH QUERY] Error stack:", error.stack);
        console.warn("[SEARCH QUERY] Falling back to standard text embedder...");
        try {
          queryVector = await LLMConnector.embedTextInput(input);
          console.log("[SEARCH QUERY] ✓ Fallback embedding successful, dimension:", queryVector?.length);
        } catch (fallbackError) {
          console.error("[SEARCH QUERY] ❌ FALLBACK ALSO FAILED:", fallbackError.message);
          throw new Error(`Both multimodal and standard embedders failed: ${error.message} / ${fallbackError.message}`);
        }
      }
    } else {
      console.log("[SEARCH QUERY] Using standard text embedder");
      try {
        queryVector = await LLMConnector.embedTextInput(input);
        console.log("[SEARCH QUERY] ✓ Standard embedding successful, dimension:", queryVector?.length);
      } catch (error) {
        console.error("[SEARCH QUERY] ❌ Standard embedder failed:", error.message);
        throw error;
      }
    }
    
    // Validate query vector
    if (!queryVector || !Array.isArray(queryVector) || queryVector.length === 0) {
      throw new Error(`Invalid query vector generated: ${typeof queryVector}, length: ${queryVector?.length}`);
    }
    
    // Calculate query vector magnitude
    const queryMagnitude = Math.sqrt(queryVector.reduce((sum, val) => sum + val * val, 0));
    console.log(`[QUERY EMBEDDING] Input: "${input}"`);
    console.log(`[QUERY EMBEDDING] Dimension: ${queryVector.length}, Magnitude: ${queryMagnitude.toFixed(6)}`);
    console.log(`[QUERY EMBEDDING] First 5 values:`, queryVector.slice(0, 5));
    
    console.log("[AnythingLLM DEBUG] performDistanceSearch:");
    console.log("  - Namespace:", namespace);
    console.log("  - Search Input:", input);
    console.log("  - Query Vector Dimension:", queryVector.length);
    console.log("  - Query Vector (first 10):", queryVector.slice(0, 10));
    console.log("  - Distance Threshold:", distanceThreshold);
    console.log("  - TopN:", topN);
    
    let contextTexts, sourceDocuments;
    try {
      const result = await this.distanceResponse(
        client,
        namespace,
        queryVector,
        distanceThreshold,
        topN,
        filterIdentifiers
      );
      contextTexts = result.contextTexts;
      sourceDocuments = result.sourceDocuments;
      console.log("[AnythingLLM DEBUG] distanceResponse returned:", {
        contextTextsCount: contextTexts?.length,
        sourceDocumentsCount: sourceDocuments?.length
      });
    } catch (dbError) {
      console.error("[AnythingLLM DEBUG] ❌ distanceResponse failed:", dbError.message);
      console.error("[AnythingLLM DEBUG] Error details:", {
        name: dbError.name,
        code: dbError.code,
        stack: dbError.stack
      });
      
      // Check if it's a dimension mismatch error
      if (dbError.message?.includes('dimension') || dbError.message?.includes('vector column')) {
        throw new Error(`Vector dimension mismatch: Query has ${queryVector.length} dimensions but collection expects different size. You may need to recreate the collection.`);
      }
      
      throw dbError;
    }

    const sources = await Promise.all(sourceDocuments.map(async (metadata, i) => {
      let text = contextTexts[i];
      if (process.env.ENABLE_TRANSLATION === 'true' && LLMConnector.translateText) {
        text = await LLMConnector.translateText(contextTexts[i], "english", "chinese");
      }
      return { metadata: { ...metadata, text } };
    }));

    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  },

  performSimilaritySearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    // Check if Multimodal Embedder is configured - if so, use it for queries too
    const { SystemSettings: SS } = require("../../../models/systemSettings");
    const embedderSettings = await SS.multimodalEmbedderPreferenceKeys();
    const hasMultimodalEmbedder = embedderSettings.MultimodalEmbedderProvider && 
                                  embedderSettings.MultimodalEmbedderProvider !== 'none' && 
                                  embedderSettings.MultimodalEmbedderBasePath &&
                                  embedderSettings.MultimodalEmbedderBasePath.trim() !== '';
    
    let queryVector;
    if (hasMultimodalEmbedder) {
      console.log("[SEARCH QUERY] Using Multimodal Embedder for text query (to match image embeddings)");
      try {
        queryVector = await this.embedTextWithMultimodalEmbedder(
          input,
          embedderSettings.MultimodalEmbedderBasePath,
          embedderSettings.MultimodalEmbedderModelPref
        );
      } catch (error) {
        console.warn("[SEARCH QUERY] Multimodal embedder failed, falling back to standard text embedder:", error.message);
        queryVector = await LLMConnector.embedTextInput(input);
      }
    } else {
      console.log("[SEARCH QUERY] Using standard text embedder");
      queryVector = await LLMConnector.embedTextInput(input);
    }
    
    const { contextTexts, sourceDocuments } = await this.similarityResponse({
      client,
      namespace,
      queryVector,
      similarityThreshold,
      topN,
      filterIdentifiers,
    });

    const sources = await Promise.all(sourceDocuments.map(async (metadata, i) => {
      let text = contextTexts[i];
      if (process.env.ENABLE_TRANSLATION === 'true' && LLMConnector.translateText) {
        text = await LLMConnector.translateText(contextTexts[i], "english", "chinese");
      }
      return { metadata: { ...metadata, text } };
    }));

    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  },

  "namespace-stats": async function (reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  },
  "delete-namespace": async function (reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");

    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${namespace} was deleted.`,
    };
  },
  reset: async function () {
    const { client } = await this.connect();
    const fs = require("fs");
    fs.rm(`${client.uri}`, { recursive: true }, () => null);
    return { reset: true };
  },
  curateSources: function (sources = []) {
    const documents = [];
    for (const source of sources) {
      const { text, vector: _v, _distance: _d, ...rest } = source;
      const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
      if (Object.keys(metadata).length > 0) {
        // Remove large fields to prevent JSON serialization errors
        const { pageContent, imageBase64, ...cleanMetadata } = metadata;
        documents.push({
          ...cleanMetadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  },
};

module.exports.LanceDb = LanceDb;
