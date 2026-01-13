const { reqBody } = require("../../utils/http");
const { Telemetry } = require("../../models/telemetry");
const { v4: uuidv4 } = require("uuid");
const {
  validEmbedConfig,
  setConnectionMeta,
} = require("../../utils/middleware/embedMiddleware");
const { writeResponseChunk } = require("../../utils/helpers/chat/responses");
const { multiUserMode } = require("../../utils/http");
const { getLLMProvider, getVectorDbClass } = require("../../utils/helpers");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

function searchEndpoints(app) {
  if (!app) return;

  app.post(
    "/search/text",
    [validatedRequest, setConnectionMeta],
    async (request, response) => {
        try {
            const { search, distanceMetric, namespaces, limit = 20, threshold = 0.5 } = reqBody(
                request
            );

            // Validate namespaces
            if (!namespaces || !Array.isArray(namespaces) || namespaces.length === 0) {
                return response.status(400).json({
                    id: uuidv4(),
                    type: "error",
                    error: "No workspaces selected. Please select at least one workspace to search.",
                    results: [],
                });
            }

            const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
            const LLMConnector = getLLMProvider({
                provider: process.env.LLM_PROVIDER || "openai",
                model: process.env[`${LLM_PROVIDER}_LLM_MODEL_PREF`],
            });

            const VectorDb = getVectorDbClass();

            let contextTexts = [];
            let sources = [];

            // Translate the search term if necessary
            let translatedSearch = search;
            if (process.env.ENABLE_TRANSLATION === 'true' && LLMConnector.translateText) {
                translatedSearch = await LLMConnector.translateText(search);
            }
            
            let combinedResults = { contextTexts: [], sources: [] };

            for (const namespace of namespaces) {
                let vectorSearchResults;
                if (distanceMetric === 'cosine') {
                  vectorSearchResults = await VectorDb.performSimilaritySearch({
                    namespace: namespace.name.toLowerCase(),
                    input: translatedSearch.toLowerCase(),
                    LLMConnector,
                    similarityThreshold: threshold,
                    topN: limit,
                  });
                } else {
                  vectorSearchResults = await VectorDb.performDistanceSearch({
                    namespace: namespace.name.toLowerCase(),
                    input: translatedSearch.toLowerCase(),
                    LLMConnector,
                    distanceThreshold: threshold,
                    topN: limit,
                  });
                }

                if (!vectorSearchResults.message) {
                    combinedResults.contextTexts.push(...vectorSearchResults.contextTexts);
                    combinedResults.sources.push(...vectorSearchResults.sources);
                }
            }

            const vectorSearchResults = combinedResults;

            if (!!vectorSearchResults.message) {
                return response.status(500).json({
                    id: uuidv4(),
                    type: "error",
                    sources: [],
                    textResponse: null,
                    close: true,
                    error: vectorSearchResults.message,
                });
            }

            contextTexts = vectorSearchResults.contextTexts;
            sources = vectorSearchResults.sources;

            // DEBUG: Log first few results to see structure
            console.log("[SEARCH ENDPOINT] Returning results:");
            console.log(`  Total sources: ${sources.length}`);
            if (sources.length > 0) {
                console.log("  First result structure:", JSON.stringify(sources[0], null, 2));
                console.log("  First result metadata keys:", Object.keys(sources[0]?.metadata || {}));
            }

            // Send the results to the client
            return response.status(200).json({
                results: sources,
            });
        } catch (e) {
            console.error(e);
            return response.status(500).json({
                id: uuidv4(),
                type: "abort",
                sources: [],
                textResponse: null,
                close: true,
                error: e.message,
            });
        }
    }
  );
}

module.exports = { searchEndpoints };
