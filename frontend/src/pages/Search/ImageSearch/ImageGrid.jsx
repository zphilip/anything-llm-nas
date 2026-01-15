import React, { useEffect, useState, useCallback, useRef } from 'react';

export function ImageGrid({ images, setCurrentImage }) {
    return (
        <div className="columns-2 gap-4 sm:columns-3 xl:columns-4 2xl:columns-5">
            {images && images.map(({ id, url, ar, blur }) => (
                <div
                    key={id}
                    href={`https://unsplash.com/photos/${id}`}
                    className='after:content group cursor-pointer relative mb-4 block w-full after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:shadow-highlight'
                    onClick={() => {
                        setCurrentImage({ id, url, ar, blur });
                    }}
                >
                    <img
                        alt=''
                        className="transform rounded-lg brightness-90 transition will-change-auto group-hover:brightness-110"
                        style={{ transform: 'translate3d(0, 0, 0)' }}
                        src={`https://images.unsplash.com/${url}?auto=format&fit=crop&w=480&q=80`}
                    />
                </div>
            ))}
        </div>)
}

export function ImageGridV2({ images = [], setCurrentImage }) {
    // Ensure images is always an array
    const safeImages = Array.isArray(images) ? images : [];
    const [columns, setColumns] = useState(2); // Default to 2 columns

    // Function to determine the number of columns based on window width
    const updateColumns = () => {
        const width = window.innerWidth;
        let newColumns;
        if (width < 640) {
            newColumns = 2; // Small screens
        } else if (width < 768) {
            newColumns = 2; // Keep it at 2 for medium screens in vertical
        } else if (width < 1024) {
            newColumns = 3; // Large screens
        } else {
            newColumns = 4; // Extra large screens
        }
        setColumns(newColumns);
        console.log(`Updated columns to: ${newColumns}`); // Debugging log        
    };   

    // Update columns on mount and resize
    useEffect(() => {
        updateColumns(); // Set initial columns
        window.addEventListener('resize', updateColumns); // Update on resize

        return () => {
            window.removeEventListener('resize', updateColumns); // Cleanup on unmount
        };
    }, []);

    // Calculate the number of rows
    const totalImages = safeImages.length;
    const rowLines = Math.ceil(totalImages / columns);
    console.log(`Total images: ${totalImages}, Row lines: ${rowLines}`); // Debugging log

    // Create a new array to hold the images in column-wise order
    const displayedImages = [];
    for (let j = 0; j < columns; j++) {
        for (let i = 0; i < rowLines; i++) {
            const index = i * columns + j; // Calculate the index for the original images array
            if (index < totalImages) {
                displayedImages.push(safeImages[index]);
            }
        }
    }

    return (
        <div className="columns-2 gap-4 sm:columns-3 xl:columns-4 2xl:columns-5 bg-black">
            {displayedImages && displayedImages.map(({ image_name, image_description, url , _distance }) => (
                <div
                    key={image_name} // Changed from id to image_name
                    className='after:content group cursor-pointer relative mb-4 block w-full after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:shadow-highlight'
                    onClick={() => {
                        setCurrentImage({ image_name, image_description, url }); // Updated to use new structure
                    }}
                >
                    <img
                        alt={image_description}
                        className="transform rounded-lg brightness-90 transition will-change-auto group-hover:brightness-110"
                        style={{ transform: 'translate3d(0, 0, 0)' }}
                        src={url}
                        width={480}
                        height={480}
                    />
                    {/* Display the distance below the image */}
                    <p className="mt-2 text-center text-sm text-gray-600">
                        Distance: {_distance !== undefined ? _distance.toFixed(2) : 'N/A'} {/* Check if distance is defined */}
                    </p>                 
                </div>
            ))}
        </div>)
}

const EmptyGridMessage = ({ message }) => (
    <div className="columns-2 gap-4 sm:columns-3 xl:columns-4 2xl:columns-5 bg-black">
        <p className="text-center text-white p-4">{message}</p>
    </div>
);

export function ImageGridV3({ images = [], setCurrentImage ,isLoading}) {
    // Ensure images is always an array
    const safeImages =  Array.isArray(images) ? images : [];
    const [error, setError] = useState(null);    
    const [columns, setColumns] = useState(2); // Default to 2 columns

    // Function to determine the number of columns based on window width
    const updateColumns = () => {
        const width = window.innerWidth;
        let newColumns;
        if (width < 640) {
            newColumns = 2; // Small screens
        } else if (width < 768) {
            newColumns = 2; // Keep it at 2 for medium screens in vertical
        } else if (width < 1024) {
            newColumns = 3; // Large screens
        } else {
            newColumns = 4; // Extra large screens
        }
        setColumns(newColumns);
        console.log(`Updated columns to: ${newColumns}`); // Debugging log        
    };   

    // Update columns on mount and resize
    useEffect(() => {
        updateColumns(); // Set initial columns
        
        // Debounce the resize handler
        let timeoutId;
        const handleResize = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(updateColumns, 250);
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(timeoutId);
        };
    }, []);

    // Filter out null or undefined values from safeImages
    const filteredImages = safeImages.filter(image => image !== null && image !== undefined);

    // Images are already sorted by parent component, no need to sort again
    const totalImages = filteredImages.length;
    const rowLines = Math.ceil(totalImages / columns);
    console.log(`Total images: ${totalImages}, Row lines: ${rowLines}, pre-sorted by distance`);

    // Use filtered images directly (already sorted by parent)
    const displayedImages = filteredImages;

    if (isLoading && displayedImages.length === 0) {
        return <EmptyGridMessage message="Loading images..." />;
    }

    if (!images || images.length === 0) {
        return <EmptyGridMessage message="No images to display" />;
    }

    if (error) {
        return <EmptyGridMessage message={error} />;
    }

    if (displayedImages.length === 0) {
        return <EmptyGridMessage message="No images available" />;
    }

    return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 bg-black">
            {displayedImages.map(({ image_name, image_description, image_base64, _distance }, index) => {
                const formatDistance = (distance) => (distance != null ? distance.toFixed(2) : 'N/A');

                return (
                    <div
                        key={`${image_name}-${index}`}
                        className='after:content group cursor-pointer relative mb-4 block w-full after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:shadow-highlight'
                        onClick={() => {
                            console.log('[ImageGrid Click] Clicked image:', {
                                image_name,
                                image_description,
                                has_base64: !!image_base64,
                                base64_length: image_base64?.length,
                                _distance
                            });
                            setCurrentImage({
                                image_name,
                                image_description,
                                image_base64
                            });
                        }}
                    >
                        <div className="group relative h-full w-full">
                            <img
                                alt={image_description || 'Image'}
                                className="object-cover transform transition-transform duration-300 group-hover:scale-105"
                                src={image_base64 ? `data:image/png;base64,${image_base64}` : ''}
                                width={480}
                                height={480}
                                style={{
                                    display: image_base64 ? 'block' : 'none',
                                }}
                            />
                            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 p-2 text-white opacity-0 transition-opacity group-hover:opacity-100">
                                <p className="text-sm truncate">{image_description}</p>
                                <p className="text-xs">
                                    Distance: {formatDistance(_distance)}
                                </p>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}