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
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
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

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(topN)
      .toArray();

    response.forEach((item, index) => {
      const similarity = this.distanceToSimilarity(item._distance);
      if (index < 5) {
        console.log(`  [Result ${index}] Distance: ${item._distance}, Similarity: ${similarity}`);
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

      result.contextTexts.push(rest.text);
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

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("l2")
      .limit(topN * 2)
      .toArray();

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

      result.contextTexts.push(rest.text);
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
   *
   * @param {LanceClient} client
   * @param {number[]} data
   * @param {string} namespace
   * @returns
   */
  updateOrCreateCollection: async function (client, data = [], namespace) {
    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      await collection.add(data);
      return true;
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

      // Handle images differently - use LLM to describe, then embed the description
      if (fileType === "image") {
        console.log("Processing image file with LLM description...");
        const documentVectors = [];
        const imageVectors = []; // Add imageVectors array like mything-llm
        const submissions = [];
        
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
            
            const vectorRecord = {
              id: id,
              values: textEmbedding,
              metadata: { ...metadata, text: desc[i] },
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
          const vectorRecord = {
            id: uuidv4(),
            values: vector,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/2def486af734c0ca87285a48f1a04c057ab74bdf/langchain/src/vectorstores/pinecone.ts#L64
            metadata: { ...metadata, text: textChunks[i] },
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

    const queryVector = await LLMConnector.embedTextInput(input);
    console.log("[AnythingLLM DEBUG] performSimilaritySearch:");
    console.log("  - Namespace:", namespace);
    console.log("  - Search Input:", input);
    console.log("  - Query Vector Dimension:", queryVector.length);
    console.log("  - Query Vector (first 10):", queryVector.slice(0, 10));
    console.log("  - Similarity Threshold:", similarityThreshold);
    console.log("  - TopN:", topN);
    const result = rerank
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

    const queryVector = await LLMConnector.embedTextInput(input);
    
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
    const { contextTexts, sourceDocuments } = await this.distanceResponse(
      client,
      namespace,
      queryVector,
      distanceThreshold,
      topN,
      filterIdentifiers
    );

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

    const queryVector = await LLMConnector.embedTextInput(input);
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
        documents.push({
          ...metadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  },
};

module.exports.LanceDb = LanceDb;
