const { StringOutputParser } = require("@langchain/core/output_parsers");
const {
  writeResponseChunk,
  clientAbortedHandler,
} = require("../../helpers/chat/responses");
const ort = require("onnxruntime-node");
const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
// Lazy load transformers to avoid startup issues if HuggingFace is unreachable
// const { pipeline } = require('@huggingface/transformers');
//const {detectLanguage} = require("./translate");

class LlamaCppAILLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.LLAMACPP_BASE_PATH)
      throw new Error("No Llama.cpp Base Path was set.");

    this.basePath = process.env.LLAMACPP_BASE_PATH;
    this.chatHost = `${process.env.LLAMACPP_BASE_PATH}/v1`;
    this.model = modelPreference || process.env.LLAMACPP_MODEL_PREF;
    this.performanceMode = process.env.LLAMACPP_PERFORMANCE_MODE || "base";
    this.keepAlive = process.env.LLAMACPP_KEEP_ALIVE_TIMEOUT ? Number(process.env.LLAMACPP_KEEP_ALIVE_TIMEOUT): 300; // Default 5-minute timeout for model loading.
    this.image2text_basePath = `${process.env.IMAGE2TEXT_BASE_PATH}/v1/chat/completions`;    
    this.image2text_model = process.env.IMAGE2TEXT_MODEL_PREF;

    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
  }

  #llamaCppLamaClient({ temperature = 0.07 }) {
    // Use the correct import path from langchain/community
    const { LlamaCpp } = require("langchain/llms/llama_cpp");
    
    console.log(`Initializing LlamaCpp client at ${this.basePath} with model ${this.model}`);
    
    // Create LlamaCpp instance following the documented approach
    return new LlamaCpp({
      modelPath: this.model, // If this is actually a path - otherwise use model parameter below
      temperature,
      maxTokens: this.performanceMode === "base" ? undefined : this.promptWindowLimit(),
      verbose: true,
      // LlamaCpp-specific parameters
      contextSize: this.promptWindowLimit(),
      batchSize: 512,
      threads: 4,
      streaming: true,
    });
  }

  #llamaCppOpenAIClient({ temperature = 0.07 }) {
    const { OpenAI } = require("@langchain/openai");
  
    console.log(`Connecting to LlamaCPP at ${this.basePath} with model ${this.model}`);
    
    return new OpenAI({
      baseURL: this.chatHost,
      apiKey: "sk-1234567890abcdef1234567890abcdef", // Most LlamaCpp servers don't validate API keys
      modelName: this.model,
      temperature,
      timeout: this.keepAlive * 1000,
      streaming: true,
      maxRetries: 3,
      defaultHeaders: { 
        "Content-Type": "application/json"
      },
      maxTokens: this.performanceMode === "base" ? undefined : this.promptWindowLimit(),
    });
  }

  // For streaming we use Langchain's wrapper to handle weird chunks
  #convertToLangchainPrototypes(chats = []) {
    const {
      HumanMessage,
      SystemMessage,
      AIMessage,
    } = require("@langchain/core/messages");
    const langchainChats = [];
    const roleToMessageMap = {
      system: SystemMessage,
      user: HumanMessage,
      assistant: AIMessage,
    };

    for (const chat of chats) {
      if (!roleToMessageMap.hasOwnProperty(chat.role)) continue;
      const MessageClass = roleToMessageMap[chat.role];
      langchainChats.push(new MessageClass({ content: chat.content }));
    }

    return langchainChats;
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(_modelName) {
    const limit = process.env.LLAMACPP_MODEL_TOKEN_LIMIT || 4096;
    if (!limit || isNaN(Number(limit)))
      throw new Error("No LlamaCPP token context limit was set.");
    return Number(limit);
  }

  // Ensure the user set a value for the token limit
  // and if undefined - assume 4096 window.
  promptWindowLimit() {
    const limit = process.env.LLAMACPP_MODEL_TOKEN_LIMIT || 4096;
    if (!limit || isNaN(Number(limit)))
      throw new Error("No LlamaCPP token context limit was set.");
    return Number(limit);
  }

  async isValidChatCompletionModel(_ = "") {
    return true;
  }

  /**
   * Generates appropriate content array for a message + attachments.
   * @param {{userPrompt:string, attachments: import("../../helpers").Attachment[]}}
   * @returns {string|object[]}
   */
  #generateContent({ userPrompt, attachments = [] }) {
    if (!attachments.length) {
      return { content: userPrompt };
    }

    const content = [{ type: "text", text: userPrompt }];
    for (let attachment of attachments) {
      content.push({
        type: "image_url",
        image_url: attachment.contentString,
      });
    }
    return { content: content.flat() };
  }

  /**
   * Construct the user prompt for this model.
   * @param {{attachments: import("../../helpers").Attachment[]}} param0
   * @returns
   */
  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [
      prompt,
      ...chatHistory,
      {
        role: "user",
        ...this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  async getChatCompletionHttp(messages = null, { temperature = 0.7 }) {
    console.log(`LlamaCpp: Getting chat completion with model ${this.model}`);
    
    try {
      // Use direct fetch without LangChain
      const response = await fetch(`${this.chatHost}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // No Authorization header - let the server decide if it needs one
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages,
          temperature,
          stream: false,
          max_tokens: this.performanceMode === "base" ? undefined : this.promptWindowLimit(),
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`LlamaCpp API error ${response.status}:`, errorText);
        throw new Error(`LlamaCpp server error: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json();
      const textResponse = data.choices?.[0]?.message?.content;
      
      if (!textResponse || !textResponse.length)
        throw new Error(`LlamaCpp::getChatCompletion text response was empty.`);
      
      return textResponse;
    } catch (e) {
      console.error('LlamaCpp chat completion error:', e);
      throw new Error(`LlamaCpp::getChatCompletion failed: ${e.message}`);
    }
  }

  async getChatCompletionLangchain(messages = null, { temperature = 0.7 }) {
    const model = this.#llamaCppLamaClient({ temperature });
    const textResponse = await model
      .pipe(new StringOutputParser())
      .invoke(this.#convertToLangchainPrototypes(messages))
      .catch((e) => {
        throw new Error(
          `LlamaCpp::getChatCompletion failed to communicate with LlamaCPP server. ${e.message}`
        );
      });

    if (!textResponse || !textResponse.length)
      throw new Error(`LlamaCpp::getChatCompletion text response was empty.`);

    return textResponse;
  }

  async streamGetChatCompletionHttp(messages = null, { temperature = 0.7 }) {
    console.log(`LlamaCpp: Streaming chat with model ${this.model}`);
    
    try {
      // Direct streaming implementation using native fetch
      const response = await fetch(`${this.chatHost}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // No Authorization header
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages,
          temperature,
          stream: true,
          max_tokens: this.performanceMode === "base" ? undefined : this.promptWindowLimit()
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`LlamaCpp streaming error ${response.status}:`, errorText);
        throw new Error(`LlamaCpp streaming error: ${response.status} - ${errorText}`);
      }
      
      if (!response.body) {
        throw new Error('LlamaCpp response has no body');
      }
      
      // Return a streaming interface compatible with your handleStream method
      return {
        [Symbol.asyncIterator]: async function* () {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk
                .split('\n')
                .filter(line => line.trim() !== '' && line.trim() !== 'data: [DONE]');
              
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                
                try {
                  const jsonData = JSON.parse(line.slice(5).trim());
                  if (jsonData.choices && jsonData.choices[0]?.delta?.content) {
                    yield jsonData.choices[0].delta.content;
                  }
                } catch (e) {
                  console.warn('Error parsing JSON from stream:', line);
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
      };
    } catch (e) {
      console.error('LlamaCpp streaming error:', e);
      throw e;
    }
  }

  
  async streamGetChatCompletionLangchain(messages = null, { temperature = 0.7 }) {
    console.log(`LlamaCPP: Streaming chat completion with ${messages.length} messages`);
    const model = this.#llamaCppLamaClient({ temperature });
    try {
      const stream = await model
        .pipe(new StringOutputParser())
        .stream(this.#convertToLangchainPrototypes(messages));
      console.log("LlamaCPP: Stream created successfully");
      return stream;
    } catch (error) {
      console.error("LlamaCPP stream error:", error.message);
      throw error;
    }
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    return this.getChatCompletionHttp(messages, { temperature });
  }

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    return this.streamGetChatCompletionHttp(messages, { temperature });
  }

  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;

    return new Promise(async (resolve) => {
      let fullText = "";

      // Establish listener to early-abort a streaming response
      // in case things go sideways or the user does not like the response.
      // We preserve the generated text but continue as if chat was completed
      // to preserve previously generated content.
      const handleAbort = () => clientAbortedHandler(resolve, fullText);
      response.on("close", handleAbort);

      try {
        for await (const chunk of stream) {
          if (chunk === undefined)
            throw new Error(
              "Stream returned undefined chunk. Aborting reply - check model provider logs."
            );

          const content = chunk.hasOwnProperty("content")
            ? chunk.content
            : chunk;
          fullText += content;
          writeResponseChunk(response, {
            uuid,
            sources: [],
            type: "textResponseChunk",
            textResponse: content,
            close: false,
            error: false,
          });
        }

        writeResponseChunk(response, {
          uuid,
          sources,
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: false,
        });
        response.removeListener("close", handleAbort);
        resolve(fullText);
      } catch (error) {
        writeResponseChunk(response, {
          uuid,
          sources: [],
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: `LlamaCpp:streaming - could not stream chat. ${
            error?.cause ?? error.message
          }`,
        });
        response.removeListener("close", handleAbort);
      }
    });
  }

  async detectLanguage(text) {
    try {
      const generateUrl = `${this.basePath}/api/generate`;
      const prompt = `Detect the language of the following text. Return only the language code (e.g., 'en', 'fr', 'es').\n\n"${text}"`;

      const response = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false
      })
      });

      if (!response.ok) {
      const errorText = await response.text();
      console.error('Language detection API error:', errorText);
      throw new Error(`Language detection failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const languageCode = data.response.trim();
      return languageCode;

    } catch (error) {
      console.error('Error during language detection:', error);
      throw new Error(`Language detection failed: ${error.message}`);
    }
  }
  
  removeOuterQuotes(s) {
    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  //Zhu Tianda add for tranlate text function.
  async translateText(text, sourceLang = "auto", targetLang = "en") {
    const generateUrl = `${this.basePath}/v1/chat/completions`; // Ensure this URL is correct
    const prompt = sourceLang
      ? `Translate the following text from ${sourceLang} to ${targetLang}. Only return the translated text without additional explanations.\n\n"${text}"`
      : `Translate the following text to ${targetLang}. Only return the translated text without additional explanations.\n\n"${text}"`;

    const response = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model, // Adjust based on your available model
        messages: [{role: "user", content: `${prompt}`}],
        max_tokens: 1000,
        temperature: 0.2,  // Lower temperature for more deterministic translations
        stream: false        
      })
    });

    const data = await response.json();
    const translatedText = data.choices?.[0]?.message?.content?.trim() || "";
    return this.removeOuterQuotes(translatedText).trim();
  }

  async translateTextJS(text, sourceLang, targetLang) {
    try {
      const { pipeline } = require('@huggingface/transformers');
      // Path to the ONNX model (update with your actual path or URL)
      const detectedLanguage = await detectLanguage(text);
      const modelPaths = {
        languageDetection: 'onnx-community/language_detection-ONNX',
        enToDe: 'Xenova/opus-mt-en-de',
        enToEs: 'Xenova/opus-mt-en-es',
        esToEn: 'Xenova/opus-mt-es-en',
        zhToEn: 'Xenova/opus-mt-zh-en',
        enToZh: 'Xenova/opus-mt-en-zh',
      };

      // Language detection (if sourceLang is not provided)
      if (!sourceLang) {
        const languageDetectionPipeline = await pipeline('text-classification', modelPaths.languageDetection);
        const detectedLanguage = await languageDetectionPipeline(text);
        sourceLang = detectedLanguage[0].label.substring(0, 2); // Extract language code (e.g., 'en', 'zh')
      }

      // Determine the appropriate model based on source and target languages
      let modelName = modelPaths.zhToEn; // Default English to German
      if (sourceLang === 'en' && targetLang === 'es') {
        modelName = modelPaths.enToEs;
      } else if (sourceLang === 'es' && targetLang === 'en') {
        modelName = modelPaths.esToEn;
      } else if (sourceLang === 'zh' && targetLang === 'en') {
        modelName = modelPaths.zhToEn;
      } else if (sourceLang === 'en' && targetLang === 'zh') {
        modelName = modelPaths.enToZh;
      }
      // Add more model mappings as needed

      const translationPipeline = await pipeline('translation', modelName);

      const result = await translationPipeline(text, {
        src_lang: sourceLang,
        tgt_lang: targetLang,
      });

      return result[0].translation_text;
    } catch (error) {
      console.error('Error during translation:', error);
      throw new Error(`Translation failed: ${error.message}`);
    }
  }

  /**
   * Describes the content of an image using LLaVA through llama.cpp server.
   * @param {string} imageContent - The base64 encoded image content.
   * @param {string} [prompt="What is in this picture?"] - The prompt for the description.
   * @returns {Promise<string | Error>} - A promise that resolves to the description or an error.
   */
  async describeImage(imageContent, prompt = "Describe this image in detail.") {
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

  /**
   * Describes the content of an image using LLaVA through llama.cpp server.
   * @param {string} imageContents - The base64 encoded image content.
   * @param {string} [prompt="What is in this picture?"] - The prompt for the description.
   * @returns {Promise<string | Error>} - A promise that resolves to the description or an error.
   */
  async describeImages(imageContents, descriptions, prompt = "Describe this image in detail.") {
    const results = [];

    // Ensure we have both arrays of the same length
    if (!imageContents || !descriptions || imageContents.length !== descriptions.length) {
      console.error("Image contents and descriptions must be arrays of the same length");
      return results;
    }
    
    // Process each image with its corresponding description
    for (let i = 0; i < imageContents.length; i++) {
      const imageContent = imageContents[i];
      const description = descriptions[i];
      try {
        // STEP 1: Get image description
        const image_description = await this.describeImage(imageContent, prompt);
        
        // STEP 2: Handle Error objects properly
        if (image_description instanceof Error) {
          console.error(`Image description failed: ${image_description.message}`);
          results.push({
            //description: `${description},image description : Error in describing image`,
            description: [description,image_description],
          });
          continue;
        }
        // STEP 3: Combine description and image description
        const all_description = `${description},image description :${image_description}`
        
        results.push({
          description: [description,image_description],
        });
      } catch (error) {
        console.error(`Failed to process image:`, error);
        results.push({
          //description: `${description},image description : Error in describing image`,
          description: [description,image_description],          
        });
      }
    }
    return results;
  }
  
  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
const { pipeline } = require('@huggingface/transformers');
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  LlamaCppAILLM,
};
