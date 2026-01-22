const CACHE_KEY = 'available-docs-cache';
const CACHE_EXPIRY = 1000 * 60 * 5; // 5 minutes cache expiry

export const saveDocsCache = async (data) => {
  try {
    const cacheData = {
      timestamp: Date.now(),
      data: data
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
    return true;
  } catch (error) {
    console.error('Error saving docs cache:', error);
    return false;
  }
};

export const loadDocsCache = async () => {
  try {
    const cachedData = window.localStorage.getItem(CACHE_KEY);
    if (!cachedData) return null;

    const { timestamp, data } = JSON.parse(cachedData);
    
    // Check if cache is expired
    if (Date.now() - timestamp > CACHE_EXPIRY) {
      window.localStorage.removeItem(CACHE_KEY);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error loading docs cache:', error);
    return null;
  }
};

export const deleteDocsCache = async () => {
  try {
    window.localStorage.removeItem(CACHE_KEY);
    return true;
  } catch (error) {
    console.error('Error deleting docs cache:', error);
    return false;
  }
};
