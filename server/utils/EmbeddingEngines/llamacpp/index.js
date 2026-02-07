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
    this.embedding_dimension = process.env.EMBEDDING_MODEL_DIM || 2048; // Default to 2048 for Qwen3-VL
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
        
        // ALWAYS normalize the embedding to ensure consistency
        const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        console.log(`[NORMALIZATION] Raw embedding magnitude: ${embeddingMagnitude.toFixed(6)}`);
        
        if (embeddingMagnitude === 0) {
          console.error("Zero magnitude embedding detected - all values are zero!");
          throw new Error("Received zero-magnitude embedding vector");
        }
        
        const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);
        const normalizedMagnitude = Math.sqrt(normalizedEmbedding.reduce((sum, val) => sum + val * val, 0));
        console.log(`[NORMALIZATION] Normalized magnitude: ${normalizedMagnitude.toFixed(6)} (should be ~1.0)`);

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
        
        // ALWAYS normalize the embedding to ensure consistency
        const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        console.log(`[NORMALIZATION] Raw embedding magnitude: ${embeddingMagnitude.toFixed(6)}`);
        
        if (embeddingMagnitude === 0) {
          console.error("Zero magnitude embedding detected - all values are zero!");
          throw new Error("Received zero-magnitude embedding vector");
        }
        
        const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);
        const normalizedMagnitude = Math.sqrt(normalizedEmbedding.reduce((sum, val) => sum + val * val, 0));
        console.log(`[NORMALIZATION] Normalized magnitude: ${normalizedMagnitude.toFixed(6)} (should be ~1.0)`);
        
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
  
  /**
   * Embeds an image directly using a multimodal embedder endpoint.
   * @param {string} base64Image - The base64 encoded image content (with or without data URI prefix).
   * @param {string} basePath - The base path of the multimodal embedder (e.g., http://192.168.1.35:8081).
   * @param {string} model - The model name to use for embedding.
   * @param {number} maxSize - Maximum width/height for resizing (default: 768).
   * @returns {Promise<number[]>} - A promise that resolves to the image embedding vector.
   */
  /**
   * Resizes an image to fit within maxSize while maintaining aspect ratio.
   * @param {string} base64Image - The base64 encoded image (with or without data URI prefix).
   * @param {number} maxSize - Maximum width/height.
   * @returns {Promise<string>} - Resized base64 image (without data URI prefix).
   */
  async #resizeImageForEmbedding(base64Image, maxSize) {
    try {
      const sharp = require('sharp');
      
      // Remove data URI prefix if present
      let base64Data = base64Image;
      if (base64Image.startsWith('data:')) {
        base64Data = base64Image.split(',')[1];
      }
      
      // Decode base64 to buffer
      const imageBuffer = Buffer.from(base64Data, 'base64');
      
      console.log(`[MULTIMODAL EMBEDDER] Original image size: ${(imageBuffer.length / 1024).toFixed(2)} KB`);
      
      // Get image metadata to check dimensions
      const metadata = await sharp(imageBuffer).metadata();
      console.log(`[MULTIMODAL EMBEDDER] Original dimensions: ${metadata.width}x${metadata.height}`);
      
      // Only resize if image is larger than maxSize
      if (metadata.width <= maxSize && metadata.height <= maxSize) {
        console.log(`[MULTIMODAL EMBEDDER] Image already within ${maxSize}px, no resize needed`);
        return base64Data;
      }
      
      // Resize image maintaining aspect ratio
      // fit: 'inside' ensures the image fits within maxSize x maxSize while preserving aspect ratio
      const resizedBuffer = await sharp(imageBuffer)
        .resize(maxSize, maxSize, {
          fit: 'inside',  // Preserve aspect ratio, fit within bounds
          withoutEnlargement: true  // Don't enlarge if already smaller
        })
        .png()
        .toBuffer();
      
      // Get resized dimensions to verify aspect ratio is preserved
      const resizedMetadata = await sharp(resizedBuffer).metadata();
      const originalRatio = (metadata.width / metadata.height).toFixed(3);
      const resizedRatio = (resizedMetadata.width / resizedMetadata.height).toFixed(3);
      
      const resizedBase64 = resizedBuffer.toString('base64');
      console.log(`[MULTIMODAL EMBEDDER] Resized image size: ${(resizedBuffer.length / 1024).toFixed(2)} KB`);
      console.log(`[MULTIMODAL EMBEDDER] Resized dimensions: ${resizedMetadata.width}x${resizedMetadata.height}`);
      console.log(`[MULTIMODAL EMBEDDER] Aspect ratio - Original: ${originalRatio}, Resized: ${resizedRatio} ✓ Preserved`);
      
      return resizedBase64;
    } catch (error) {
      console.warn(`[MULTIMODAL EMBEDDER] Failed to resize image: ${error.message}`);
      console.warn(`[MULTIMODAL EMBEDDER] Using original image`);
      // Return original if resize fails
      return base64Image.startsWith('data:') ? base64Image.split(',')[1] : base64Image;
    }
  }

  async embedImageDirect(base64Image, basePath, model, description = "", maxSize = 512) {
    try {
      console.log(`[MULTIMODAL EMBEDDER] Starting direct image embedding...`);
      console.log(`[MULTIMODAL EMBEDDER] Max resize dimension: ${maxSize}px`);
      console.log(`[MULTIMODAL EMBEDDER] Base Path: ${basePath}`);
      console.log(`[MULTIMODAL EMBEDDER] Model: ${model}`);
      console.log(`[MULTIMODAL EMBEDDER] Description: ${description}`);
      
      
      // Resize image to reduce token count - use even smaller size for LFM models
      // LFM models may have smaller context windows, so we need more aggressive resizing
      const resizedBase64 = await this.#resizeImageForEmbedding(base64Image, maxSize);
      console.log(`[MULTIMODAL EMBEDDER] Resized base64: ${resizedBase64.substring(0, 60)}... (length: ${resizedBase64.length} chars)`);
      // Ensure we have the full data URI format (llamacpp expects "data:image/png;base64,...")
      const dataURI = resizedBase64.startsWith('data:') 
        ? resizedBase64
        : `data:image/png;base64,${resizedBase64}`;

      const embedUrl = `${basePath}/embedding`;
      
      // Use the correct llamacpp vision embeddings API format
      // Based on llamacpp test: test_vision_embeddings
      // Payload structure: { content: [{ prompt_string: "text <__media__>", multimodal_data: [base64] }] }
      // CRITICAL: prompt_string must include marker <__media__> to reference the image
      // let description = "what's the image about?";
      // 1. 定义任务指令（如果是为了存入数据库供后续搜索，使用这个前缀）
      const instruction = "Retrieve images or text relevant to the user's query: ";

      // 2. 构造符合 Qwen3-VL 规范的 Prompt
      // 建议格式：指令 + 视觉标记 + 描述文本
      //const promptText = `${instruction}<|im_start|><__media__><|im_end|>${description ? description : ""}`;
      //const promptText = description ? `${description}<|im_start|><__media__><|im_end|>` : "<__media__>";
      const promptText = `${instruction}<|im_start|><__media__><|im_end|>${description ? description : ""}`;

      // FORMAT 1: Qwen3-VL style with special tokens (current format)
      const payload = {
        content: [
          {
            prompt_string: promptText,  // Description + <__media__> marker
            multimodal_data: [resizedBase64]  // Raw base64 (no data URI prefix)
          }
        ],
        parameter: { output_dimension: this.embedding_dimension } // Ensure output dimension matches model
      };
      
      // FORMAT 2: Alternative image_data format (as per llama.cpp embedding API)
      // This format uses "Image: [img-0]" reference style
      // Uncomment to use this format instead:
      const payloadAlternative = {
        content: "Image: [img-0]", // 保持纯净，只标识图片位置
        image_data: [{ data: resizedBase64, id: 0 }]
      };
      
      
      console.log(`[MULTIMODAL EMBEDDER] Sending request to ${embedUrl}`);
      console.log(`[MULTIMODAL EMBEDDER] Image base64 length: ${resizedBase64.length} chars`);
      console.log(`[MULTIMODAL EMBEDDER] Prompt text: "${promptText.substring(0, 100)}..."`);
      console.log(`[MULTIMODAL EMBEDDER] Using llamacpp format: { content: [{ prompt_string, multimodal_data }] }`);
      
      // Log actual payload structure (not stringified for display)
      console.log(`[MULTIMODAL EMBEDDER] Actual payload.content[0]:`, {
        prompt_string: payload.content[0].prompt_string.substring(0, 50) + '...',
        multimodal_data_is_array: Array.isArray(payload.content[0].multimodal_data),
        multimodal_data_length: payload.content[0].multimodal_data.length,
        multimodal_data_first_item_type: typeof payload.content[0].multimodal_data[0],
        multimodal_data_first_item_preview: payload.content[0].multimodal_data[0].substring(0, 60) + '...'
      });
      
      const requestBody = JSON.stringify(payloadAlternative);
      console.log(`[MULTIMODAL EMBEDDER] Total request body size: ${requestBody.length} bytes`);
      
      const response = await fetch(embedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[MULTIMODAL EMBEDDER] HTTP error: ${response.status} - ${errorText}`);
        throw new Error(`Multimodal embedder API error: ${response.status} - ${errorText}`);
      }

      const responseData = await response.json();
      console.log(`[MULTIMODAL EMBEDDER] Response received, parsing...`);
      
      // Extract embedding from llamacpp-python format: [{ "embedding": [[...]] }]
      const embedding = responseData?.[0]?.embedding?.[0];
      
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        console.error("[MULTIMODAL EMBEDDER] Failed to extract embedding. Response structure:", {
          isArray: Array.isArray(responseData),
          hasFirstElement: !!responseData?.[0],
          firstElementKeys: responseData?.[0] ? Object.keys(responseData[0]) : null,
        });
        throw new Error("Multimodal embedder returned invalid embedding structure!");
      }
      
      console.log(`[MULTIMODAL EMBEDDER] ✓ Successfully received embedding with ${embedding.length} dimensions`);
      
      // ALWAYS normalize the embedding to ensure consistency
      const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
      console.log(`[MULTIMODAL EMBEDDER] Raw embedding magnitude: ${embeddingMagnitude.toFixed(6)}`);
      
      if (embeddingMagnitude === 0) {
        console.error("[MULTIMODAL EMBEDDER] Zero magnitude embedding detected!");
        throw new Error("Received zero-magnitude embedding vector from multimodal embedder");
      }
      
      const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);
      const normalizedMagnitude = Math.sqrt(normalizedEmbedding.reduce((sum, val) => sum + val * val, 0));
      console.log(`[MULTIMODAL EMBEDDER] Normalized magnitude: ${normalizedMagnitude.toFixed(6)} (should be ~1.0)`);
      console.log(`[MULTIMODAL EMBEDDER] First 5 values:`, normalizedEmbedding.slice(0, 5));
      
      return normalizedEmbedding;
    } catch (error) {
      console.error('[MULTIMODAL EMBEDDER] Error embedding image:', error);
      throw new Error(`Failed to embed image with multimodal embedder: ${error.message}`);
    }
  }

  /**
   * Embeds text using the multimodal embedder endpoint (without image).
   * Used for text queries when multimodal embedder is configured.
   * @param {string} text - The text to embed.
   * @param {string} basePath - The base path of the multimodal embedder.
   * @param {string} model - The model name to use for embedding.
   * @returns {Promise<number[]>} - A promise that resolves to the text embedding vector.
   */
  async embedTextWithMultimodal(text, basePath, model) {
    try {
      // Input validation
      if (!text || typeof text !== 'string') {
        throw new Error(`Invalid text input: ${typeof text}`);
      }
      if (!basePath || typeof basePath !== 'string') {
        throw new Error(`Invalid basePath: ${basePath}`);
      }
      if (!model || typeof model !== 'string') {
        throw new Error(`Invalid model: ${model}`);
      }
      
      console.log(`[MULTIMODAL EMBEDDER TEXT] === NEW QUERY REQUEST ===`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Raw input text: "${text}"`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Text length: ${text.length}`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Text type: ${typeof text}`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Base Path: ${basePath}`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Model: ${model}`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Expected dimension: ${this.embedding_dimension}`);
      
      const embedUrl = `${basePath}/embedding`;
      
      // CRITICAL: Don't use instruction prefixes with multimodal embedders
      // They can cause severe cache pollution in llama.cpp server
      // Just use the raw query text for better semantic matching
      // --- 修改查询端 (Query) 代码 ---
      const instruction = "Instruct: Given a search query, retrieve relevant images.";
      const searchQuery = `${instruction}\nQuery:${text}`; // 必须带上相同的指令头
      //const searchQuery = text;
      
      console.log(`[MULTIMODAL EMBEDDER TEXT] Query for embedding: "${searchQuery}"`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Query hash: ${searchQuery.split('').reduce((a,b)=>{a=((a<<5)-a)+b.charCodeAt(0);return a&a},0)}`);
      
      // For text-only embedding, use same format but without multimodal_data
      const payload = {
        content: [  // API requires 'content' field
          {
            prompt_string: searchQuery  // Raw query text
          }
        ],
        parameter: { output_dimension: this.embedding_dimension }, // Ensure output dimension matches model
        //cache_prompt: false  // Disable prompt caching to ensure fresh embeddings
      };

      // FORMAT 2: Alternative query-only payload (example from curl)
      // Uncomment to use this format instead:
      const payloadAlternative = {
        content: searchQuery
      };
      
      
      console.log(`[MULTIMODAL EMBEDDER TEXT] Sending request to ${embedUrl}`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] Payload structure:`, {
        content_length: payload.content.length,
        has_prompt_string: !!payload.content[0]?.prompt_string,
        parameter: payload.parameter
      });
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
      
      let response;
      try {
        response = await fetch(embedUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payloadAlternative),
          signal: controller.signal
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        console.error(`[MULTIMODAL EMBEDDER TEXT] Fetch failed:`, fetchError);
        throw new Error(`Network error calling multimodal embedder: ${fetchError.message}`);
      }
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorText;
        try {
          errorText = await response.text();
        } catch (e) {
          errorText = 'Unable to read error response';
        }
        console.error(`[MULTIMODAL EMBEDDER TEXT] HTTP error: ${response.status} - ${errorText}`);
        throw new Error(`Multimodal embedder text API error: ${response.status} - ${errorText}`);
      }

      let responseData;
      try {
        responseData = await response.json();
        console.log(`[MULTIMODAL EMBEDDER TEXT] Response received, parsing...`);
        console.log(`[MULTIMODAL EMBEDDER TEXT] Response type:`, typeof responseData, 'isArray:', Array.isArray(responseData));
      } catch (jsonError) {
        console.error(`[MULTIMODAL EMBEDDER TEXT] JSON parsing failed:`, jsonError);
        const rawText = await response.text();
        console.error(`[MULTIMODAL EMBEDDER TEXT] Raw response (first 500 chars):`, rawText.substring(0, 500));
        throw new Error(`Failed to parse multimodal embedder response as JSON: ${jsonError.message}`);
      }
      
      // Extract embedding from llamacpp-python format
      const embedding = responseData?.[0]?.embedding?.[0];
      
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        console.error("[MULTIMODAL EMBEDDER TEXT] Failed to extract embedding. Response structure:", {
          isArray: Array.isArray(responseData),
          hasFirstElement: !!responseData?.[0],
          firstElementKeys: responseData?.[0] ? Object.keys(responseData[0]) : null,
        });
        throw new Error("Multimodal embedder returned invalid embedding structure!");
      }
      
      console.log(`[MULTIMODAL EMBEDDER TEXT] ✓ Successfully received embedding with ${embedding.length} dimensions`);
      
      // Check for dimension mismatch
      if (embedding.length !== this.embedding_dimension) {
        console.warn(`[MULTIMODAL EMBEDDER TEXT] ⚠️ DIMENSION MISMATCH!`);
        console.warn(`  Expected: ${this.embedding_dimension}`);
        console.warn(`  Received: ${embedding.length}`);
        console.warn(`  This will cause search failures if collection was created with different dimensions!`);
      }
      
      // Normalize the embedding
      const embeddingMagnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
      console.log(`[MULTIMODAL EMBEDDER TEXT] Raw embedding magnitude: ${embeddingMagnitude.toFixed(6)}`);
      
      if (embeddingMagnitude === 0) {
        console.error("[MULTIMODAL EMBEDDER TEXT] Zero magnitude embedding detected!");
        throw new Error("Received zero-magnitude embedding vector from multimodal embedder");
      }
      
      const normalizedEmbedding = embedding.map(val => val / embeddingMagnitude);
      const normalizedMagnitude = Math.sqrt(normalizedEmbedding.reduce((sum, val) => sum + val * val, 0));
      console.log(`[MULTIMODAL EMBEDDER TEXT] Normalized magnitude: ${normalizedMagnitude.toFixed(6)} (should be ~1.0)`);
      console.log(`[MULTIMODAL EMBEDDER TEXT] First 5 values:`, normalizedEmbedding.slice(0, 5));
      
      return normalizedEmbedding;
    } catch (error) {
      console.error('[MULTIMODAL EMBEDDER TEXT] ❌ CRITICAL ERROR:', error);
      console.error('[MULTIMODAL EMBEDDER TEXT] Error stack:', error.stack);
      console.error('[MULTIMODAL EMBEDDER TEXT] Context:', {
        text: text?.substring(0, 100) + '...',
        textLength: text?.length,
        basePath,
        model,
        expectedDimension: this.embedding_dimension
      });
      throw new Error(`Failed to embed text with multimodal embedder: ${error.message}`);
    }
  }

  // Other methods would follow similar patterns of adaptation
}

module.exports = {
  LlamaCppEmbedder,
};
