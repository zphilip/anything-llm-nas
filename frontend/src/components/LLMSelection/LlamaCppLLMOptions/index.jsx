import React, { useEffect, useState } from "react";
import System from "@/models/system";
import PreLoader from "@/components/Preloader";
import { LLAMACPP_COMMON_URLS } from "@/utils/constants";
import { CaretDown, CaretUp, Info } from "@phosphor-icons/react";
import useProviderEndpointAutoDiscovery from "@/hooks/useProviderEndpointAutoDiscovery";
import { Tooltip } from "react-tooltip";

export default function LlamaCppLLMOptions({ settings }) {
  const {
    autoDetecting: loading,
    basePath,
    basePathValue,
    showAdvancedControls,
    setShowAdvancedControls,
    handleAutoDetectClick,
  } = useProviderEndpointAutoDiscovery({
    provider: "llamacpp",
    initialBasePath: settings?.LlamaCppLLMBasePath,
    ENDPOINTS: LLAMACPP_COMMON_URLS,
  });
  const [performanceMode, setPerformanceMode] = useState(
    settings?.LlamaCppLLMPerformanceMode || "base"
  );
  const [maxTokens, setMaxTokens] = useState(
    settings?.LlamaCppLLMTokenLimit || 4096
  );

  return (
    <div className="w-full flex flex-col gap-y-7">
      <div className="w-full flex items-start gap-[36px] mt-1.5">
        <LlamaCppLLMModelSelection
          settings={settings}
          basePath={basePath.value}
        />
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-2">
            Max Tokens
          </label>
          <input
            type="number"
            name="LlamaCppLLMTokenLimit"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="4096"
            defaultChecked="4096"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            onScroll={(e) => e.target.blur()}
            required={true}
            autoComplete="off"
          />
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
            Maximum number of tokens for context and response.
          </p>
        </div>
      </div>
      <div className="flex justify-start mt-4">
        <button
          onClick={(e) => {
            e.preventDefault();
            setShowAdvancedControls(!showAdvancedControls);
          }}
          className="border-none text-theme-text-primary hover:text-theme-text-secondary flex items-center text-sm"
        >
          {showAdvancedControls ? "Hide" : "Show"} advanced settings
          {showAdvancedControls ? (
            <CaretUp size={14} className="ml-1" />
          ) : (
            <CaretDown size={14} className="ml-1" />
          )}
        </button>
      </div>

      <div hidden={!showAdvancedControls}>
        <div className="w-full flex items-start gap-4">
          <div className="flex flex-col w-60">
            <div className="flex justify-between items-center mb-2">
              <label className="text-white text-sm font-semibold">
                LlamaCpp Base URL
              </label>
              {loading ? (
                <PreLoader size="6" />
              ) : (
                <>
                  {!basePathValue.value && (
                    <button
                      onClick={handleAutoDetectClick}
                      className="bg-primary-button text-xs font-medium px-2 py-1 rounded-lg hover:bg-secondary hover:text-white shadow-[0_4px_14px_rgba(0,0,0,0.25)]"
                    >
                      Auto-Detect
                    </button>
                  )}
                </>
              )}
            </div>
            <input
              type="url"
              name="LlamaCppLLMBasePath"
              className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
              placeholder="http://127.0.0.1:8000"
              value={basePathValue.value}
              required={true}
              autoComplete="off"
              spellCheck={false}
              onChange={basePath.onChange}
              onBlur={basePath.onBlur}
            />
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
              Enter the URL where the LlamaCpp server is running.
            </p>
          </div>

          <div className="flex flex-col w-60">
            <label className="text-white text-sm font-semibold block mb-2">
              LlamaCpp Keep Alive
            </label>
            <select
              name="LlamaCppLLMKeepAliveSeconds"
              required={true}
              className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
              defaultValue={settings?.LlamaCppLLMKeepAliveSeconds ?? "300"}
            >
              <option value="0">No cache</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
              <option value="-1">Forever</option>
            </select>
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
              Choose how long LlamaCpp should keep your model in memory before
              unloading.
            </p>
          </div>

          <div className="flex flex-col w-60">
            <label className="text-white text-sm font-semibold mb-2 flex items-center">
              Performance Mode
              <Info
                size={16}
                className="ml-2 text-white"
                data-tooltip-id="performance-mode-tooltip"
              />
            </label>
            <select
              name="LlamaCppLLMPerformanceMode"
              required={true}
              className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
              value={performanceMode}
              onChange={(e) => setPerformanceMode(e.target.value)}
            >
              <option value="base">Base (Default)</option>
              <option value="maximum">Maximum</option>
            </select>
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
              Choose the performance mode for the LlamaCpp model.
            </p>
            <Tooltip
              id="performance-mode-tooltip"
              place="bottom"
              className="tooltip !text-xs max-w-xs"
            >
              <p className="text-red-500">
                <strong>Note:</strong> Only change this setting if you
                understand its implications on performance and resource usage.
              </p>
              <br />
              <p>
                <strong>Base:</strong> Uses default token handling, reducing memory usage.
                Suitable for most users.
              </p>
              <br />
              <p>
                <strong>Maximum:</strong> Uses the full context window (up to
                Max Tokens). May increase memory usage significantly.
              </p>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function LlamaCppLLMModelSelection({ settings, basePath = null }) {
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

  if (loading || customModels.length == 0) {
    return (
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-2">
          LlamaCpp Model
        </label>
        <select
          name="LlamaCppLLMModelPref"
          disabled={true}
          className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
        >
          <option disabled={true} selected={true}>
            {!!basePath
              ? "--loading available models--"
              : "Enter LlamaCpp URL first"}
          </option>
        </select>
        <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
          Select the LlamaCpp model you want to use. Models will load after
          entering a valid LlamaCpp server URL.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60">
      <label className="text-white text-sm font-semibold block mb-2">
        LlamaCpp Model
      </label>
      <select
        name="LlamaCppLLMModelPref"
        required={true}
        className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
      >
        {customModels.length > 0 && (
          <optgroup label="Available models">
            {customModels.map((model) => {
              return (
                <option
                  key={model.id}
                  value={model.id}
                  selected={settings.LlamaCppLLMModelPref === model.id}
                >
                  {model.id}
                </option>
              );
            })}
          </optgroup>
        )}
      </select>
      <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
        Choose the LlamaCpp model you want to use for your conversations.
      </p>
    </div>
  );
}
