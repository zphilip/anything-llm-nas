const CACHE_NAME = 'image-database'; // Change version when needed

export function blurHashToDataURL(hash) {
    if (!hash) return undefined;
    // Simplified placeholder - blurhash library not installed
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Crect fill='%23888' width='400' height='300'/%3E%3C/svg%3E";
}

function downloadData(url, filename) {

    // Create an anchor element with the data URL as the href attribute
    const downloadLink = document.createElement('a');
    downloadLink.href = url;

    // Set the download attribute to specify the desired filename for the downloaded image
    downloadLink.download = filename;

    // Trigger the download
    downloadLink.click();

    // Clean up: remove the anchor element from the DOM
    downloadLink.remove();
}

export function downloadImage(url, filename) {
    fetch(url, {
        headers: new Headers({
            Origin: location.origin,
        }),
        mode: 'cors',
    })
        .then((response) => response.blob())
        .then((blob) => {
            let blobUrl = window.URL.createObjectURL(blob)
            downloadData(blobUrl, filename)
        })
        .catch((e) => console.error(e))
}

async function clearOldCaches() {
    const cacheNames = await caches.keys();
    for (const cacheName of cacheNames) {
        if (cacheName !== CACHE_NAME) {
            await caches.delete(cacheName); // Delete old caches
        }
    }
}

// Adapted from https://github.com/xenova/transformers.js/blob/c367f9d68b809bbbf81049c808bf6d219d761d23/src/utils/hub.js#L330
export async function getCachedFile(url) {
    let cache;
    try {
        cache = await caches.open('image-database');
        const cachedResponse = await cache.match(url);
        if (cachedResponse) {
            return await cachedResponse.arrayBuffer();
        }
    } catch (e) {
        console.warn('Unable to open cache', e);
    }

    // No cache, or cache failed to open. Fetch the file.
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();

    if (cache) {
        try {
            clearOldCaches();
            // NOTE: We use `new Response(buffer, ...)` instead of `response.clone()` to handle LFS files
            await cache.put(url, new Response(buffer, {
                headers: response.headers,
            }));
        } catch (e) {
            console.warn('Unable to cache file', e);
        }
    }

    return buffer;

}

export async function getCachedJSON(url) {
    let buffer = await getCachedFile(url);

    let decoder = new TextDecoder('utf-8');
    let jsonData = decoder.decode(buffer);

    return JSON.parse(jsonData);
}
