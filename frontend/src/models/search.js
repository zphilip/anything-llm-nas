import { API_BASE } from "@/utils/constants";

const Search = {
  searchText: async function (
    search,
    namespaces,
    limit = 20,
    threshold = 0.5,
    distanceMetric = "cosine",
    headers = {}
  ) {
    // Use passed headers, or default if none provided
    const fetchHeaders = {
      "Content-Type": "application/json",
      ...headers,
    };

    return await fetch(`${API_BASE}/search/text`, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify({
        search,
        distanceMetric,
        namespaces,
        limit,
        threshold,
      }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error("Could not perform text search.");
        }
        return res.json();
      })
      .then((res) => res.results)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },

  searchImage: async function (file, limit = 10, distanceMetric = "cosine") {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("limit", limit);
    formData.append("distanceMetric", distanceMetric);

    return await fetch(`${API_BASE}/search/image`, {
      method: "POST",
      body: formData,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error("Could not perform image search.");
        }
        return res.json();
      })
      .then((res) => res.results)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },

  searchTextImage: async function (file, search) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("search", search);

    return await fetch(`${API_BASE}/search/text_image`, {
      method: "POST",
      body: formData,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error("Could not perform text image search.");
        }
        return res.json();
      })
      .then((res) => res.results)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
};

export default Search;
