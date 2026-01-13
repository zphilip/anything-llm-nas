// HuggingFace transformers models are not currently used in this implementation
// The LlamaCpp embedder uses the llamacpp-python server's embedding endpoint instead
// If you need to use HuggingFace models in the future, initialize them lazily in the methods that need them
  
const { maximumChunkLength } = require("../../helpers");
const path = require("path");

class LlamaCppEmbedder {
  constructor() {
    if (!process.env.EMBEDDING_BASE_PATH)
      throw new Error("No embedding base path was set.");
    if (!process.env.EMBEDDING_MODEL_PREF)
      throw new Error("No embedding model was set.");

    this.basePath = `${process.env.EMBEDDING_BASE_PATH}/embedding`;
    this.model = process.env.EMBEDDING_MODEL_PREF;
    this.embedding_dimension = process.env.EMBEDDING_MODEL_DIM || 1536;
    this.image2text_basePath = `${process.env.IMAGE2TEXT_BASE_PATH}/v1/chat/completions`;    
    this.image2text_model = process.env.IMAGE2TEXT_MODEL_PREF;;
    // Limit of how many strings we can process in a single pass to stay with resource or network limits
    this.maxConcurrentChunks = 1;
    this.embeddingMaxChunkLength = maximumChunkLength();
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.constructor.name}]\x1b[0m ${text}`, ...args);
  }

  async #isAlive() {
    const basePath = process.env.EMBEDDING_BASE_PATH;

    if (!basePath) {
      this.log("EMBEDDING_BASE_PATH is not defined.");
      return false;
    }

    return await fetch(basePath, {
      method: "HEAD",
    })
      .then((res) => res.ok)
      .catch((e) => {
        this.log(`Error checking LlamaCpp service: ${e.message}.  Ensure the LlamaCpp server is running and accessible.`);
        console.error("Full error when checking LlamaCpp service:", e); // Log the full error for debugging
        return false;
      });
  }

  async embedTextInput(textInput) {
    const result = await this.embedChunksLlamaServer(
      Array.isArray(textInput) ? textInput : [textInput]
    );
    return result?.[0] || [];
  }


  /**
   * This function takes an array of text chunks and embeds them using the LlamaCpp API.
   * chunks are processed sequentially to avoid overwhelming the API with too many requests
   * or running out of resources on the endpoint running the llamacpp-python instance.
   * @param {string[]} textChunks - An array of text chunks to embed.
   * @returns {Promise<Array<number[]>>} - A promise that resolves to an array of embeddings.
   */
  async embedChunks(textChunks = []) {
    if (!(await this.#isAlive()))
      throw new Error(
        `LlamaCpp service could not be reached. Is llamacpp-python server running?`
      );

    this.log(
      `Embedding ${textChunks.length} chunks of text with ${this.model}.`
    );

    let data = [];
    let error = null;

    for (const chunk of textChunks) {
      try {
        // Validate chunk is a string
        if (chunk === null || chunk === undefined) {
          console.warn("Skipping null/undefined chunk");
          data.push(new Array(this.embedding_dimension).fill(0));
          continue;
        }
        
        if (typeof chunk !== 'string') {
          console.error('Invalid chunk type:', typeof chunk, 'Value:', chunk);
          throw new Error(`Chunk must be a string, got ${typeof chunk}`);
        }
        
        if (!chunk || chunk.trim() === '') {
          console.warn("Skipping empty chunk");
          data.push(new Array(this.embedding_dimension).fill(0));
          continue;
        }
        
        console.log(`Embedding chunk type: ${typeof chunk}, length: ${chunk.length}, preview: "${chunk.substring(0, 100)}..."`);
        
        const response = await fetch(this.basePath, {
          method: "POST",
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: chunk, 
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Embedding API HTTP error: ${response.status} - ${errorText}`);
          throw new Error(`LlamaCpp embedding API error: ${response.status} - ${errorText}`);
        }

        const responseData = await response.json();
        console.log("Raw embedding response:", JSON.stringify(responseData).substring(0, 300));
        console.log("Response type:", typeof responseData, "Is array:", Array.isArray(responseData));
        
        // Extract embedding from llamacpp-python format: [{ "embedding": [[...]] }]
        const embedding = responseData?.[0]?.embedding?.[0];
        
        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
          console.error("Failed to extract embedding. Response structure:", {
            isArray: Array.isArray(responseData),
            hasFirstElement: !!responseData?.[0],
            firstElementKeys: responseData?.[0] ? Object.keys(responseData[0]) : null,
            fullResponse: JSON.stringify(responseData).substring(0, 500)
          });
          throw new Error("LlamaCpp returned invalid embedding structure!");
        }
        
        // Normalize the embedding
        const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);

        data.push(normalizedEmbedding);
      } catch (err) {
        this.log(err.message);
        error = err.message;
        data = [];
        break;
      }
    }

    if (!!error) throw new Error(`LlamaCpp Failed to embed: ${error}`);
    return data.length > 0 ? data : null;
  }
  
  /**
   * This function takes an array of text chunks and embeds them using the LlamaCpp API.
   * @param {string[]} textChunks - An array of text chunks to embed.
   * @returns {Promise<Array<number[]>>} - A promise that resolves to an array of embeddings.
   */
  async embedChunksLlamaServer(textChunks = []) {
    if (!(await this.#isAlive()))
      throw new Error(
        `LlamaCpp service could not be reached. Is llamacpp-python server running?`
      );

    this.log(
      `Embedding ${textChunks.length} chunks of text with ${this.model}.`
    );

    let data = [];
    let error = null;

    for (const chunk of textChunks) {
      try {
        // Validate chunk is a string
        if (chunk === null || chunk === undefined) {
          console.warn("Skipping null/undefined chunk in embedChunksLlamaServer");
          data.push(new Array(this.embedding_dimension).fill(0));
          continue;
        }
        
        if (typeof chunk !== 'string') {
          console.error('Invalid chunk type in embedChunksLlamaServer:', typeof chunk, 'Value:', chunk);
          throw new Error(`Chunk must be a string, got ${typeof chunk}`);
        }
        
        // Skip empty chunks
        if (!chunk || chunk.trim() === '') {
          console.warn("Skipping empty chunk");
          data.push(new Array(this.embedding_dimension).fill(0)); // Use zero vector as fallback
          continue;
        }
        
        // Use the format expected by llamacpp-python
        const payload = {
          content: chunk,  // llamacpp-python expects 'content' field
        };
        
        console.log(`Sending embedding request to ${this.basePath} for text: "${chunk.substring(0, 50)}..."`);
        console.log(`Payload:`, JSON.stringify(payload).substring(0, 200));
        
        const response = await fetch(this.basePath, {
          method: "POST",
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LlamaCpp embedding API error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log("Embedding API raw response:", JSON.stringify(result).substring(0, 200)); // Debug log
        
        // Extract embedding from llamacpp-python format: [{ "embedding": [[...]] }]
        const embedding = result?.[0]?.embedding?.[0];
        
        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
          console.warn("Could not find embedding in response, full response:", JSON.stringify(result).substring(0, 200) + "...");
          throw new Error("Failed to extract embedding from response");
        }
        
        // Normalize the embedding
        const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);
        
        console.log(`Successfully generated embedding with ${normalizedEmbedding.length} dimensions`);
        
        data.push(normalizedEmbedding);
      } catch (err) {
        this.log("Embedding error:", err.message);
        console.error("Full error:", err);
        error = err.message;
        // Use a fallback embedding instead of breaking the entire batch
        data.push(new Array(this.embedding_dimension).fill(0));
      }
    }

    if (error && data.every(emb => emb.every(val => val === 0))) {
      // Only throw if ALL embeddings failed (all are zero vectors)
      throw new Error(`LlamaCpp Failed to embed any chunks: ${error}`);
    }
    
    return data.length > 0 ? data : null;
  }

  async visionEmbeddingGenerator(image){
    const processor = await processorPromise
    const visionModel = await visionModelPromise
    try { 
        // Read image and run processor
        const image_inputs = await processor(image);
        // Compute embeddings
        const { image_embeds } = await visionModel(image_inputs);

        return image_embeds.data
    } catch (err) {
      console.error(`Error processing image:`, err);
    }
  }

  /**
   * Describes the content of an image using LLaVA through llama.cpp server.
   * @param {string} imageContent - The base64 encoded image content.
   * @param {string} [prompt="What is in this picture?"] - The prompt for the description.
   * @returns {Promise<string | Error>} - A promise that resolves to the description or an error.
   */
  async describe(imageContent, prompt = "Describe this image in detail.") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes timeout

    try {
      // Format image URL properly with data prefix if not already present
      const imageUrl = imageContent.startsWith('data:') 
        ? imageContent 
        : `data:image/jpeg;base64,${imageContent}`;
      
      const data = {
        model: this.image2text_model,
        messages: [
          {
            role: "system",
            content: "You are an assistant who perfectly describes images."
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ],
        max_tokens: 1024,
        temperature: 0.7
      };

      console.log(`Sending image description request to ${this.image2text_basePath} for model ${this.image2text_model}`);
      
      const response = await fetch(this.image2text_basePath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorResult = await response.json();
        const errorMessage = errorResult?.error?.message || `Request failed with status ${response.status}`;
        throw new Error(`LLaVA API error: ${response.status} - ${errorMessage}`);
      }

      const result = await response.json();
      console.log("description result is:",result); // Log the full response for debugging
      // Extract the response content following the OpenAI format
      if (result) {
        const image_description = result.choices[0].message.content
        console.log("image description is:",image_description); // Log the full response for debugging
        return image_description;
      } else {
        console.warn("Unexpected response format:", result);
        return result.content || result.response || result.text || "No description available";
      }
    } catch (error) {
      console.error('Error in describe function:', error);
      return new Error(error.message);
    }
  }

  async getImageEmbV2(imageContent, namespace) {
    try {
  
      // Prepare the payload for the POST request to llamacpp-python
      const payload = {
        image: imageContent,
        model: this.model,
        namespace: namespace
      };

      // Update with your llamacpp-python endpoint
      const generateUrl = `${process.env.PROXYNET_BASE_PATH}/embedding/image`; 
      
      const response = await fetch(generateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorMessage = await response.text();
        throw new Error(`Error from llamacpp-python: ${errorMessage}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Error in getImageEmbV2 function:', error);
      throw new Error(`Failed to get image embedding: ${error.message}`);
    }
  }

  async embedImageInput_old(imageInputs = [], description, namespace) {
    const results = [];

    for (const imageInput of imageInputs) {
      try {
        // STEP 1: Get image description
        const image_description = await this.describe(imageInput);
        
        // STEP 2: Handle Error objects properly
        if (image_description instanceof Error) {
          console.error(`Image description failed: ${image_description.message}`);
          results.push({
            description: `Error: ${image_description.message}`,
            textEmbedding: new Array(this.embedding_dimension).fill(0), // Use zero vector as fallback
          });
          continue;
        }
        
        // STEP 3: Get text embedding from description string
        const embedding_text = `${description},image description :${image_description}`
        // Remove all newlines and replace with spaces to create a single-line string
        const embedding_text_clean = embedding_text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`Image Description Result: ${embedding_text_clean.length}, ${embedding_text_clean}...`);
        // Check if the combined text is too long
        // Clean both parts separately
        const descriptionClean = description ? description.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() : "";
        const imageDescriptionClean = image_description ? image_description.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() : "";
        // Check combined length and decide what to use
        if ((descriptionClean.length + imageDescriptionClean.length) > 8192) {
          console.log(`Text too long (${descriptionClean.length + imageDescriptionClean.length} chars), splitting...`);
          embedding_text_clean = [descriptionClean, imageDescriptionClean];
        } 

        const text_result = await this.embedTextInput(embedding_text_clean);
        
        let embedding = null;
        if (text_result && Array.isArray(text_result) && text_result.length > 0) {
          embedding = text_result; // Assuming the first element contains the embedding
        } else {
          console.warn("Unexpected text_result format:", text_result);
          embedding = new Array(this.embedding_dimension).fill(0); // Fallback to zero vector
        }
        
        // Ensure embedding is an array before attempting to slice it
        const embeddingToLog = Array.isArray(embedding) ? embedding.slice(0, 10) : embedding;
        console.log(`Text Embedding Result (first 10 elements): ${embeddingToLog}...`);
        
        // STEP 4: Return just the necessary data
        results.push({
          description: image_description,
          textEmbedding: embedding,
        });
      } catch (error) {
        console.error(`Failed to process image:`, error);
        results.push({
          description: `Error processing image: ${error.message}`,
          textEmbedding: new Array(this.embedding_dimension).fill(0), // Zero vector fallback
        });
      }
    }
    return results;
  }

  async embedImageInput(imageDescriptions, namespace) {
    const results = [];

    for (const image_description of imageDescriptions) {
      
      try {        
        
        // Clean both parts separately
        const descriptionClean = description ? description.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() : "";
        const imageDescriptionClean = image_description ? image_description.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() : "";
        // Check combined length and decide what to use
        if ((descriptionClean.length + imageDescriptionClean.length) > 8192) {
          console.log(`Text too long (${descriptionClean.length + imageDescriptionClean.length} chars), splitting...`);
          embedding_text_clean = [descriptionClean, imageDescriptionClean];
        } 

        const text_result = await this.embedTextInput(embedding_text_clean);
        
        let embedding = null;
        if (text_result && Array.isArray(text_result) && text_result.length > 0) {
          embedding = text_result; // Assuming the first element contains the embedding
        } else {
          console.warn("Unexpected text_result format:", text_result);
          embedding = new Array(this.embedding_dimension).fill(0); // Fallback to zero vector
        }
        
        // Ensure embedding is an array before attempting to slice it
        const embeddingToLog = Array.isArray(embedding) ? embedding.slice(0, 10) : embedding;
        console.log(`Text Embedding Result (first 10 elements): ${embeddingToLog}...`);
        
        // STEP 4: Return just the necessary data
        results.push({
          description: image_description,
          textEmbedding: embedding,
        });
      } catch (error) {
        console.error(`Failed to process image:`, error);
        results.push({
          description: `Error processing image: ${error.message}`,
          textEmbedding: new Array(this.embedding_dimension).fill(0), // Zero vector fallback
        });
      }
    }
    return results;
  }
  
  // Other methods would follow similar patterns of adaptation
}

module.exports = {
  LlamaCppEmbedder,
};
