import { Spinner } from "@phosphor-icons/react";
import { formatDistance } from "./utils";

export function ImageGrid({ images, setCurrentImage, isLoading, searchDistance }) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-white/70">
        <Spinner size={48} className="animate-spin mb-4" />
        <p className="text-lg">Searching images...</p>
      </div>
    );
  }

  if (!images || images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-white/50">
        <MagnifyingGlass size={64} className="mb-4" />
        <p className="text-lg">No images found.</p>
        <p className="text-sm mt-2">Try a different search query or select more workspaces.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {images.map((image, index) => (
        <ImageCard
          key={`${image.url}-${index}`}
          image={image}
          onClick={() => setCurrentImage(image)}
          searchDistance={searchDistance}
        />
      ))}
    </div>
  );
}

function ImageCard({ image, onClick, searchDistance }) {
  return (
    <div
      onClick={onClick}
      className="relative aspect-square rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity bg-theme-bg-secondary border border-white/10 hover:border-primary-button group"
    >
      <img
        src={`data:image/jpeg;base64,${image.image_base64}`}
        alt={image.image_name || "Image"}
        className="w-full h-full object-cover"
        loading="lazy"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="absolute bottom-0 left-0 right-0 p-3 text-white">
          <div className="text-xs font-medium truncate mb-1">
            {image.image_name || "Unknown"}
          </div>
          {image._distance !== null && image._distance !== undefined && (
            <div className="text-xs text-white/70">
              {formatDistance(image._distance, searchDistance).split("(")[0]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Alias for compatibility with mything-llm
export function ImageGridV2(props) {
  return <ImageGrid {...props} />;
}

export function ImageGridV3(props) {
  return <ImageGrid {...props} />;
}

function MagnifyingGlass({ size, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
