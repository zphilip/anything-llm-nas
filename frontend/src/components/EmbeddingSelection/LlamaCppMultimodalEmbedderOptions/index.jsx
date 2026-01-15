import { useEffect, useState } from "react";
import System from "@/models/system";
import PreLoader from "@/components/Preloader";

export default function LlamaCppMultimodalEmbedderOptions({ settings }) {
  const [basePathValue, setBasePathValue] = useState("");
  const [basePath, setBasePath] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchKeys() {
      const initialPath = settings?.MultimodalEmbedderBasePath || "";
      setBasePathValue(initialPath);
      setBasePath(initialPath);
      setLoading(false);
    }
    fetchKeys();
  }, [settings?.MultimodalEmbedderBasePath]);

  const handleBasePathChange = (e) => {
    const newPath = e.target.value;
    setBasePathValue(newPath);
    setBasePath(newPath);
  };

  return (
    <div className="w-full flex flex-col gap-y-7">
      {loading ? (
        <div className="flex flex-col w-full">
          <div className="w-full flex flex-col gap-y-4">
            <div className="w-60 h-8 bg-theme-settings-input-bg rounded-md shimmer-effect" />
            <div className="w-full h-10 bg-theme-settings-input-bg rounded-md shimmer-effect" />
          </div>
        </div>
      ) : (
        <>
          <div className="w-full flex items-start gap-[36px] mt-1.5">
            <LlamaCppMultimodalEmbedderModelSelection
              key={`${basePath}-${settings?.MultimodalEmbedderModelPref}`}
              settings={settings}
              basePath={basePath}
            />

            <div className="flex flex-col w-60">
              <label className="text-white text-sm font-semibold block mb-2">
                Max Embedding Chunk Length
              </label>
              <input
                type="number"
                name="MultimodalEmbedderMaxChunkLength"
                className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                placeholder="8192"
                min={1}
                defaultValue={settings?.MultimodalEmbedderMaxChunkLength || 8192}
                required={false}
                autoComplete="off"
              />
              <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
                Maximum length of text chunks for multimodal embedding.
              </p>
            </div>
          </div>

          <div className="w-full flex items-start gap-4">
            <div className="flex flex-col w-60">
              <label className="text-white text-sm font-semibold block mb-2">
                Llama.cpp Base URL
              </label>
              <input
                type="url"
                name="MultimodalEmbedderBasePath"
                className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                placeholder="http://127.0.0.1:8080"
                value={basePathValue}
                onChange={handleBasePathChange}
                required={true}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
                Enter the URL where your Llama.cpp server is running for multimodal embeddings.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LlamaCppMultimodalEmbedderModelSelection({ settings, basePath = null }) {
  const [customModels, setCustomModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function findCustomModels() {
      if (!basePath) {
        setCustomModels([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { models } = await System.customModels("llamacpp", null, basePath);
        setCustomModels(models || []);
      } catch (error) {
        console.error("Failed to fetch custom models:", error);
        setCustomModels([]);
      }
      setLoading(false);
    }
    findCustomModels();
  }, [basePath]);

  if (loading || customModels.length === 0) {
    return (
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-2">
          Multimodal Embedding Model
        </label>
        <select
          name="MultimodalEmbedderModelPref"
          disabled={true}
          className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
        >
          <option disabled={true} selected={true}>
            {!!basePath
              ? "--loading available models--"
              : "Enter Llama.cpp URL first"}
          </option>
        </select>
        <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
          Select the Llama.cpp model for multimodal embeddings. Models will load after entering a valid Llama.cpp URL.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60">
      <label className="text-white text-sm font-semibold block mb-2">
        Multimodal Embedding Model
      </label>
      <select
        name="MultimodalEmbedderModelPref"
        required={true}
        defaultValue={settings?.MultimodalEmbedderModelPref || ""}
        className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
      >
        {customModels.length > 0 && (
          <optgroup label="Your loaded models">
            {customModels.map((model) => {
              return (
                <option
                  key={model.id}
                  value={model.id}
                >
                  {model.id}
                </option>
              );
            })}
          </optgroup>
        )}
      </select>
      <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
        Choose the Llama.cpp model you want to use for generating multimodal embeddings.
      </p>
    </div>
  );
}
