import { X, MapPin, Camera } from "@phosphor-icons/react";
import { formatDistance } from "./utils";

export function Modal({ currentImage, setCurrentImage, searchDistance }) {
  if (!currentImage) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={() => setCurrentImage(null)}
    >
      <div className="relative max-w-7xl max-h-full w-full">
        <button
          onClick={() => setCurrentImage(null)}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          aria-label="Close modal"
        >
          <X size={24} weight="bold" />
        </button>

        <div
          className="relative bg-theme-bg-secondary rounded-lg overflow-hidden shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-[70vh] overflow-hidden flex items-center justify-center bg-black">
            <img
              src={`data:image/jpeg;base64,${currentImage.image_base64}`}
              alt={currentImage.image_name || "Image"}
              className="max-w-full max-h-[70vh] object-contain"
            />
          </div>

          <div className="p-6 bg-theme-bg-secondary text-white">
            <h3 className="text-lg font-bold mb-3">{currentImage.image_name || "Unknown"}</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              {currentImage._distance !== null && currentImage._distance !== undefined && (
                <div>
                  <span className="text-white/50">Distance Score:</span>
                  <p className="font-medium mt-1">
                    {formatDistance(currentImage._distance, searchDistance)}
                  </p>
                </div>
              )}

              {currentImage.camera && (
                <div className="flex items-start gap-2">
                  <Camera size={18} className="text-white/50 mt-0.5" />
                  <div>
                    <span className="text-white/50">Camera:</span>
                    <p className="font-medium mt-1">{currentImage.camera}</p>
                  </div>
                </div>
              )}

              {currentImage.lens && (
                <div>
                  <span className="text-white/50">Lens:</span>
                  <p className="font-medium mt-1">{currentImage.lens}</p>
                </div>
              )}

              {currentImage.location && (
                <div className="flex items-start gap-2">
                  <MapPin size={18} className="text-white/50 mt-0.5" />
                  <div>
                    <span className="text-white/50">Location:</span>
                    <p className="font-medium mt-1">
                      {currentImage.location.latitude}, {currentImage.location.longitude}
                    </p>
                  </div>
                </div>
              )}

              {currentImage.cameraSettings && (
                <div className="col-span-full">
                  <span className="text-white/50">Camera Settings:</span>
                  <div className="flex flex-wrap gap-4 mt-2">
                    {currentImage.cameraSettings.iso && (
                      <span className="px-2 py-1 bg-white/10 rounded text-xs">
                        ISO {currentImage.cameraSettings.iso}
                      </span>
                    )}
                    {currentImage.cameraSettings.fNumber && (
                      <span className="px-2 py-1 bg-white/10 rounded text-xs">
                        {currentImage.cameraSettings.fNumber}
                      </span>
                    )}
                    {currentImage.cameraSettings.exposureTime && (
                      <span className="px-2 py-1 bg-white/10 rounded text-xs">
                        {currentImage.cameraSettings.exposureTime}
                      </span>
                    )}
                    {currentImage.cameraSettings.focalLength && (
                      <span className="px-2 py-1 bg-white/10 rounded text-xs">
                        {currentImage.cameraSettings.focalLength}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {currentImage.url && (
                <div className="col-span-full">
                  <span className="text-white/50">File Path:</span>
                  <p className="font-mono text-xs mt-1 break-all text-white/70">
                    {currentImage.url}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Aliases for compatibility
export function ModalV2(props) {
  return <Modal {...props} />;
}

export function ModalV3(props) {
  return <Modal {...props} />;
}
