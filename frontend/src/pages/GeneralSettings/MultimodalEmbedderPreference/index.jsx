import React, { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import System from "@/models/system";
import showToast from "@/utils/toast";
import LlamaCppLogo from "@/media/llmprovider/Llama1-logo.svg";
import PreLoader from "@/components/Preloader";
import LlamaCppMultimodalEmbedderOptions from "@/components/EmbeddingSelection/LlamaCppMultimodalEmbedderOptions";
import { CaretUpDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import CTAButton from "@/components/lib/CTAButton";
import { useTranslation } from "react-i18next";

const MULTIMODAL_EMBEDDERS = [
  {
    name: "LlamaCpp",
    value: "llamacpp",
    logo: LlamaCppLogo,
    options: (settings) => <LlamaCppMultimodalEmbedderOptions settings={settings} />,
    description: "Run multimodal embedding models using Llama.cpp server for image and text embeddings.",
  },
];

function MultimodalEmbedderItem({ name, value, image, description, checked, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`w-full p-2 rounded-md hover:cursor-pointer hover:bg-theme-bg-secondary ${
        checked ? "bg-theme-bg-secondary" : ""
      }`}
    >
      <input
        type="checkbox"
        value={value}
        className="peer hidden"
        checked={checked}
        readOnly={true}
        formNoValidate={true}
      />
      <div className="flex gap-x-4 items-center">
        <img
          src={image}
          alt={`${name} logo`}
          className="w-10 h-10 rounded-md"
        />
        <div className="flex flex-col">
          <div className="text-sm font-semibold text-white">{name}</div>
          <div className="mt-1 text-xs text-description">{description}</div>
        </div>
      </div>
    </div>
  );
}

export default function GeneralMultimodalEmbedderPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredEmbedders, setFilteredEmbedders] = useState([]);
  const [selectedEmbedder, setSelectedEmbedder] = useState(null);
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const searchInputRef = useRef(null);
  const formRef = useRef(null);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    
    const form = e.target;
    const data = { MultimodalEmbedderProvider: selectedEmbedder };
    const formData = new FormData(form);

    for (var [key, value] of formData.entries()) data[key] = value;
    
    console.log("Saving multimodal embedder settings:", data);
    const { error } = await System.updateSystem(data);

    if (error) {
      showToast(`Failed to save multimodal embedder settings: ${error}`, "error");
    } else {
      showToast("Multimodal embedder preferences saved successfully.", "success");
    }
    setSaving(false);
    setHasChanges(!!error);
  };

  const handleButtonClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (formRef.current) {
      const submitEvent = new Event("submit", { cancelable: true, bubbles: false });
      formRef.current.dispatchEvent(submitEvent);
    }
  };

  const updateChoice = (selection) => {
    setSearchQuery("");
    setSelectedEmbedder(selection);
    setSearchMenuOpen(false);
    setHasChanges(true);
  };

  const handleXButton = () => {
    if (searchQuery.length > 0) {
      setSearchQuery("");
      if (searchInputRef.current) searchInputRef.current.value = "";
    } else {
      setSearchMenuOpen(!searchMenuOpen);
    }
  };

  useEffect(() => {
    async function fetchKeys() {
      const _settings = await System.keys();
      console.log("Loaded settings:", {
        MultimodalEmbedderProvider: _settings?.MultimodalEmbedderProvider,
        MultimodalEmbedderBasePath: _settings?.MultimodalEmbedderBasePath,
        MultimodalEmbedderModelPref: _settings?.MultimodalEmbedderModelPref,
        MultimodalEmbedderMaxChunkLength: _settings?.MultimodalEmbedderMaxChunkLength
      });
      setSettings(_settings);
      setSelectedEmbedder(_settings?.MultimodalEmbedderProvider || "llamacpp");
      setLoading(false);
    }
    fetchKeys();
  }, []);

  useEffect(() => {
    const filtered = MULTIMODAL_EMBEDDERS.filter((embedder) =>
      embedder.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredEmbedders(filtered);
  }, [searchQuery, selectedEmbedder]);

  const selectedEmbedderObject = MULTIMODAL_EMBEDDERS.find(
    (embedder) => embedder.value === selectedEmbedder
  );

  useEffect(() => {
    if (searchMenuOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchMenuOpen]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      {loading ? (
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
        >
          <div className="w-full h-full flex justify-center items-center">
            <PreLoader />
          </div>
        </div>
      ) : (
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
        >
          <form
            ref={formRef}
            onSubmit={handleSubmit}
            onChange={() => setHasChanges(true)}
            className="flex w-full"
          >
            <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] py-16 md:py-6">
              <div className="w-full flex flex-col gap-y-1 pb-6 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10">
                <div className="flex gap-x-4 items-center">
                  <p className="text-lg leading-6 font-bold text-white">
                    Multimodal Embedder Preference
                  </p>
                </div>
                <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
                  Select and configure the multimodal embedding provider for processing images and text together.
                  <br />
                  This is used for generating embeddings from both visual and textual content.
                </p>
              </div>
              <div className="w-full justify-end flex">
                {hasChanges && (
                  <CTAButton
                    onClick={handleButtonClick}
                    className="mt-3 mr-0 -mb-14 z-10"
                  >
                    {saving ? t("common.saving") : t("common.save")}
                  </CTAButton>
                )}
              </div>
              <div className="text-base font-bold text-white mt-6 mb-2">
                Multimodal Embedder Provider
              </div>
              <div className="relative">
                {searchMenuOpen && (
                  <div
                    className="fixed top-0 left-0 w-full h-full bg-black bg-opacity-70 backdrop-blur-sm z-10"
                    onClick={() => setSearchMenuOpen(false)}
                  />
                )}
                {searchMenuOpen ? (
                  <div className="absolute top-0 left-0 w-full max-w-[640px] max-h-[310px] min-h-[64px] bg-theme-settings-input-bg rounded-lg flex flex-col justify-between cursor-pointer border-2 border-primary-button z-20">
                    <div className="w-full flex flex-col gap-y-1">
                      <div className="flex items-center sticky top-0 z-10 border-b border-[#9CA3AF] mx-4 bg-theme-settings-input-bg">
                        <MagnifyingGlass
                          size={20}
                          weight="bold"
                          className="absolute left-4 z-30 text-theme-text-primary -ml-4 my-2"
                        />
                        <input
                          type="text"
                          name="embedder-search"
                          autoComplete="off"
                          placeholder="Search multimodal embedding providers"
                          className="border-none -ml-4 my-2 bg-transparent z-20 pl-12 h-[38px] w-full px-4 py-1 text-sm outline-none text-theme-text-primary placeholder:text-theme-text-primary placeholder:font-medium"
                          onChange={(e) => setSearchQuery(e.target.value)}
                          ref={searchInputRef}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.preventDefault();
                          }}
                        />
                        <X
                          size={20}
                          weight="bold"
                          className="cursor-pointer text-white hover:text-x-button"
                          onClick={handleXButton}
                        />
                      </div>
                      <div className="flex-1 pl-4 pr-2 flex flex-col gap-y-1 overflow-y-auto white-scrollbar pb-4 max-h-[245px]">
                        {filteredEmbedders.map((embedder) => (
                          <MultimodalEmbedderItem
                            key={embedder.name}
                            name={embedder.name}
                            value={embedder.value}
                            image={embedder.logo}
                            description={embedder.description}
                            checked={selectedEmbedder === embedder.value}
                            onClick={() => updateChoice(embedder.value)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    className="w-full max-w-[640px] h-[64px] bg-theme-settings-input-bg rounded-lg flex items-center p-[14px] justify-between cursor-pointer border-2 border-transparent hover:border-primary-button transition-all duration-300"
                    type="button"
                    onClick={() => setSearchMenuOpen(true)}
                  >
                    <div className="flex gap-x-4 items-center">
                      <img
                        src={selectedEmbedderObject.logo}
                        alt={`${selectedEmbedderObject.name} logo`}
                        className="w-10 h-10 rounded-md"
                      />
                      <div className="flex flex-col text-left">
                        <div className="text-sm font-semibold text-white">
                          {selectedEmbedderObject.name}
                        </div>
                        <div className="mt-1 text-xs text-description">
                          {selectedEmbedderObject.description}
                        </div>
                      </div>
                    </div>
                    <CaretUpDown
                      size={24}
                      weight="bold"
                      className="text-white"
                    />
                  </button>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-y-1">
                {selectedEmbedder &&
                  MULTIMODAL_EMBEDDERS.find(
                    (embedder) => embedder.value === selectedEmbedder
                  )?.options(settings)}
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
