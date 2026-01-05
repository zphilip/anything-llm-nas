const ort = require("onnxruntime-node");

let AutoTokenizer;

async function loadTokenizer() {
  if (!AutoTokenizer) {
    const transformers = await import("@xenova/transformers");
    AutoTokenizer = transformers.AutoTokenizer;
  }
}

async function loadModel(modelPath) {
  return await ort.InferenceSession.create(modelPath);
}

async function detectLanguage(text) {
  try {
    await loadTokenizer();
    const language_detection_modelPath = "/../../../../storage/models/model_optimized.onnx";
    const tokenizerPath = "/../../../../storage/models/";    // Adjust path if needed

    // Load tokenizer
    const tokenizer = await AutoTokenizer.from_pretrained("protectai/xlm-roberta-base-language-detection-onnx");
    //const tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath, { local_files_only: true });

    // Check if text is a string
    if (typeof text !== 'string') {
      text = String(text); // Convert to string if necessary
    }

    // Tokenize input text
    const encoded = tokenizer.encode(text);
    console.log("Encoded:", encoded); // INSPECT THIS
    
    // Convert to ONNX Tensor
    let data = encoded.input_ids;
    let dims = [encoded.input_ids.length];

    if (!(data instanceof Int32Array)) {
        data = new Int32Array(data);
    }

    // Convert to ONNX Tensor
    const inputTensor = new ort.Tensor("int32", encoded.data, encoded.dims);

    const session = await loadModel(language_detection_modelPath);
    const outputs = await session.run({ input_ids: inputTensor });

    // Decode output tokens
    return tokenizer.decode(outputs.output_ids.data, { skip_special_tokens: true });
  } catch (error) {
    console.error("Error in detectLanguage:", error);
    throw error;
  }
}

module.exports = {
  detectLanguage
};