# Frontend Migration Plan: SMB/NAS and Image Search Features

## Executive Summary
This document outlines the migration plan for SMB/NAS data connector UI and Image Search features from **mything-llm frontend (v0.2.0)** to **anything-llm frontend (v1.9.1)**.

**Analysis Date:** December 31, 2025  
**Status:** Planning Phase  
**Estimated Effort:** 12-16 hours

---

## Table of Contents
1. [Comparison Analysis](#comparison-analysis)
2. [New Features Overview](#new-features-overview)
3. [Dependencies](#dependencies)
4. [Migration Tasks](#migration-tasks)
5. [Implementation Details](#implementation-details)
6. [Testing Strategy](#testing-strategy)
7. [Risk Assessment](#risk-assessment)

---

## 1. Comparison Analysis

### 1.1 Directory Structure Differences

#### mything-llm Frontend (Custom Features)
```
frontend/src/
├── pages/
│   ├── Search/              # ❌ NOT in anything-llm
│   │   └── ImageSearch/     # NEW: Image search page
│   │       ├── index.jsx
│   │       ├── ImageGrid.jsx
│   │       ├── Modal.jsx
│   │       ├── Pagination.jsx
│   │       ├── SearchBar.jsx
│   │       ├── DistanceSelector.jsx
│   │       ├── utils.js
│   │       ├── worker.js     # Web Worker for embeddings
│   │       ├── WebWorkerFetch.js
│   │       └── translate.jsx
│   └── FineTuning/          # ❌ NOT in anything-llm
│       ├── index.jsx
│       └── Steps/
├── components/
│   ├── ImageSearch/         # ❌ NOT in anything-llm
│   │   └── index.jsx        # Search button component
│   ├── Sidebar/
│   │   ├── index.jsx        # ✏️ MODIFIED: Added search button
│   │   └── ActiveWorkspaces/
│   │       └── index.jsx    # ✏️ MODIFIED: Added checkboxes
│   ├── Modals/
│   │   └── ManageWorkspace/
│   │       └── DataConnectors/
│   │           ├── index.jsx           # ✏️ MODIFIED: Added NAS connector
│   │           └── Connectors/
│   │               └── DataServer/     # ❌ NEW: NAS/SMB connector UI
│   │                   └── index.jsx
│   └── WorkspaceContext/    # ❌ NOT in anything-llm (or moved)
│       └── index.jsx
├── models/
│   ├── dataConnector.js     # ✏️ MODIFIED: Added dataserver methods
│   ├── search.js            # ❌ NEW: Image search API client
│   └── workspace.js         # ✏️ MODIFIED: Added imageSearch method
├── hooks/
│   └── usePersistedState.js # ❌ NEW: localStorage persistence hook
└── utils/
    └── paths.js             # ✏️ MODIFIED: Added search routes
```

#### anything-llm Frontend (Current v1.9.1)
```
frontend/src/
├── pages/
│   ├── Admin/
│   │   ├── AgentBuilder/    # ✅ New in v1.9.1
│   │   ├── SystemPromptVariables/ # ✅ New
│   │   └── DefaultSystemPrompt/   # ✅ New
│   └── [No Search/ directory]
├── components/
│   ├── CommunityHub/        # ✅ New in v1.9.1
│   ├── ProviderPrivacy/     # ✅ New
│   ├── KeyboardShortcutsHelp/ # ✅ New
│   ├── ErrorBoundaryFallback/ # ✅ New
│   ├── contexts/            # ✅ Organized contexts
│   └── [No ImageSearch component]
└── PWAContext.jsx           # ✅ New: PWA support
```

### 1.2 Feature Comparison Matrix

| Feature | mything-llm | anything-llm | Migration Required |
|---------|-------------|--------------|-------------------|
| **SMB/NAS Data Connector** | ✅ Implemented | ❌ Missing | **HIGH PRIORITY** |
| - NAS connector UI | ✅ Full form | ❌ None | Yes |
| - Mount & Process | ✅ Dual mode | ❌ None | Yes |
| - Progress tracking | ✅ Real-time | ❌ None | Yes |
| - Process cancellation | ✅ Supported | ❌ None | Yes |
| **Image Search** | ✅ Full feature | ❌ Missing | **HIGH PRIORITY** |
| - Search page | ✅ Dedicated route | ❌ None | Yes |
| - Web Worker embeddings | ✅ Client-side | ❌ None | Yes |
| - Distance metrics | ✅ 3 types | ❌ None | Yes |
| - Pagination | ✅ Configurable | ❌ None | Yes |
| - Workspace filtering | ✅ Checkboxes | ❌ None | Yes |
| **Sidebar Enhancements** | ✅ Search button | ❌ None | MEDIUM |
| **Fine-tuning UI** | ✅ Walkthrough | ❌ None | LOW (Optional) |
| **PWA Support** | ❌ None | ✅ Implemented | Already in v1.9.1 |
| **Community Hub** | ❌ None | ✅ Implemented | Already in v1.9.1 |

---

## 2. New Features Overview

### 2.1 SMB/NAS Data Connector UI

**Purpose:** User interface for mounting and processing SMB/NAS shares

**Key Components:**
- Form for SMB credentials (host, share, username, password)
- Mount point configuration
- Ignore patterns (gitignore-style)
- Dual operation modes:
  1. **Connect and Process** - Direct processing without mounting
  2. **Mount and Process** - Mount share then process
- Real-time progress tracking
- Process cancellation

**User Flow:**
```
1. User opens "Manage Data" modal
2. Selects "NAS" connector
3. Enters SMB credentials
4. (Optional) Configures mount point for persistent access
5. Sets ignore patterns for file filtering
6. Clicks "Connect and Process" or "Mount and Process"
7. Monitors progress in real-time
8. Can cancel if needed
9. Files appear in document picker
```

**State Management:**
- Uses `usePersistedState` hook to save form data in localStorage
- Preserves user input across sessions
- Auto-clears on successful submission

### 2.2 Image Search Feature

**Purpose:** Multi-modal image search using embeddings and similarity metrics

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                    Image Search Page                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Search Bar + Distance Selector (Euclidean/Cosine/Dot)│  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Sidebar: Workspace Checkboxes for Filtering          │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Image Grid: Thumbnails with Distance Scores          │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Pagination: Configurable items per page              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ↓
    Web Worker (worker.js)
         ↓
  ┌──────────────────────┐
  │  Embedding Model     │
  │  (Client-side CLIP)  │
  └──────────────────────┘
         ↓
    Backend API: /api/search/text
         ↓
  ┌──────────────────────┐
  │  Vector Search       │
  │  (LanceDB)           │
  └──────────────────────┘
```

**Key Features:**
1. **Client-side Embedding:** Uses Transformers.js Web Worker for text embedding
2. **Distance Metrics:** 
   - Euclidean (L2) - Default
   - Cosine similarity
   - Dot product
3. **Workspace Filtering:** Select which workspaces to search
4. **Pagination:** 20/50/100 items per page
5. **Modal Viewer:** Click image to enlarge with metadata
6. **Translation Support:** Multi-language search queries
7. **Base64 Image Loading:** Fetches and displays images from server documents

**Web Worker Integration:**
- Offloads heavy computation (embedding generation) from main thread
- Prevents UI blocking during search
- Supports multiple concurrent searches with ID tracking
- Graceful degradation if worker fails

### 2.3 Enhanced Sidebar

**Modifications:**
- Added "RAG Search" button to navigate to image search
- Workspace checkboxes for search filtering (conditional rendering)
- Integration with `WorkspaceContext` for state management
- Responsive design maintained

---

## 3. Dependencies

### 3.1 New NPM Packages (Frontend)

#### Required for Image Search
```json
{
  "@xenova/transformers": "^2.x.x",     // Client-side ML models
  "query-plus": "^1.x.x",               // Fetch utilities with hooks
  "react-loading-skeleton": "^3.x.x"    // Loading states
}
```

#### Already in Project (Verify Versions)
```json
{
  "@phosphor-icons/react": "^2.x.x",    // Icons
  "react-router-dom": "^6.x.x",         // Routing
  "react-tag-input-component": "^2.x.x",// Tag inputs
  "pluralize": "^8.x.x",                // String utils
  "slugify": "^1.x.x",                  // URL slugs
  "react-tooltip": "^5.x.x"             // Tooltips
}
```

### 3.2 Backend API Endpoints Required

#### SMB/NAS Connector
```
POST   /api/ext/dataserver/connect      - Process files from SMB share
POST   /api/ext/dataserver/mount        - Mount and process SMB share  
GET    /api/ext/dataserver/checkStatus  - Check processing status
POST   /api/ext/dataserver/cancel       - Cancel ongoing process
POST   /api/ext/dataserver/collect      - Collect files (alternative)
```

#### Image Search
```
POST   /api/search/text                 - Text-based vector search
POST   /api/search/image                - Image-based search (optional)
POST   /api/search/text_image           - Combined search (optional)
```

**Note:** Backend endpoints already implemented in collector migration (see MIGRATION_SMB_IMAGE_FEATURES.md)

### 3.3 Backend Integration Points

#### Server-Side Requirements
1. **Collector Service** must expose endpoints on port 8888
2. **Vector Database** (LanceDB) must be configured
3. **Embedding Model** must be set in system settings
4. **Document Storage** must return base64-encoded images
5. **CORS** must allow frontend origin

---

## 4. Migration Tasks

### Phase 1: Foundation & Dependencies (2-3 hours)

#### Task 1.1: Install Frontend Dependencies
**Priority:** HIGH  
**Estimated Time:** 30 minutes

**Actions:**
```bash
cd /app/anything-llm/frontend
npm install @xenova/transformers query-plus react-loading-skeleton
```

**Verification:**
- [ ] Dependencies install without conflicts
- [ ] Build process succeeds (`npm run build`)
- [ ] No version conflicts with existing packages

#### Task 1.2: Create Utility Hooks
**Priority:** HIGH  
**Estimated Time:** 30 minutes

**Files to Create:**
1. `frontend/src/hooks/usePersistedState.js` - localStorage persistence hook

**Implementation:**
```javascript
import { useState, useEffect } from 'react';

export function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch (error) {
      console.error(`Error reading ${key} from localStorage:`, error);
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error saving ${key} to localStorage:`, error);
    }
  }, [key, value]);

  return [value, setValue];
}
```

**Testing:**
- [ ] Hook saves to localStorage correctly
- [ ] Persists across page refreshes
- [ ] Handles JSON serialization errors gracefully

#### Task 1.3: Update Paths Configuration
**Priority:** HIGH  
**Estimated Time:** 15 minutes

**File to Modify:** `frontend/src/utils/paths.js`

**Changes:**
```javascript
export default {
  // ... existing paths ...
  
  search: {
    imageSearch: () => `/search/image-search`,
    // Future: results, filters, history routes
  },
  
  // ... rest of paths ...
};
```

**Testing:**
- [ ] Paths resolve correctly
- [ ] No conflicts with existing routes

---

### Phase 2: SMB/NAS Data Connector UI (4-5 hours)

#### Task 2.1: Update Data Connector Model
**Priority:** HIGH  
**Estimated Time:** 1 hour

**File to Modify:** `frontend/src/models/dataConnector.js`

**Changes:**
```javascript
const DataConnector = {
  // ... existing connectors (github, gitlab, youtube) ...
  
  dataserver: {
    connect: async ({ nasshare, username, password, ignorePaths }) => {
      return await fetch(`${API_BASE}/ext/dataserver/connect`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ nasshare, username, password, ignorePaths }),
      })
        .then((res) => res.json())
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },

    mount: async ({ nasshare, username, password, mountpoint, ignores }) => {
      return await fetch(`${API_BASE}/ext/dataserver/mount`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ nasshare, username, password, mountpoint, ignores }),
      })
        .then((res) => res.json())
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },

    checkStatus: async ({ processId }) => {
      return await fetch(`${API_BASE}/ext/dataserver/checkStatus?processId=${processId}`, {
        method: "GET",
        headers: baseHeaders()
      })
        .then((res) => res.json())
        .then((res) => {
          return { data: res, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },

    cancel: async ({ processId }) => {
      return await fetch(`${API_BASE}/ext/dataserver/cancel`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ processId }),
      })
        .then((res) => res.json())
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
};

export default DataConnector;
```

**Testing:**
- [ ] API calls succeed with correct payload
- [ ] Error handling works properly
- [ ] CORS issues resolved

#### Task 2.2: Create DataServer Connector Component
**Priority:** HIGH  
**Estimated Time:** 3 hours

**File to Create:** `frontend/src/components/Modals/ManageWorkspace/DataConnectors/Connectors/DataServer/index.jsx`

**Key Implementation Points:**
1. **Form Fields:**
   - NAS Share path (\\192.168.1.100\share\path)
   - Username
   - Password
   - Mount point (optional)
   - Ignore patterns (TagInput)

2. **State Management:**
   - Use `usePersistedState` for form persistence
   - Track processing status
   - Store processId for polling

3. **Progress Polling:**
   ```javascript
   const pollProgress = (processId) => {
     const interval = setInterval(async () => {
       const { data } = await System.dataConnectors.dataserver.checkStatus({
         processId: processId
       });
       
       if (data && data.progress) {
         setProgress(data.progress);
       }
       
       if (data?.status === "completed" || data?.status === "failed") {
         clearInterval(interval);
         setProcessing(false);
       }
     }, 10000); // Poll every 10 seconds
   };
   ```

4. **Dual Submission Modes:**
   - `handleSubmit()` - Connect and process
   - `handleMount()` - Mount then process

5. **Cancel Functionality:**
   ```javascript
   const handleCancel = async () => {
     if (!processId) return;
     await System.dataConnectors.dataserver.cancel({ processId });
     setProcessing(false);
   };
   ```

**UI Components:**
- Input fields with theme styling
- Submit buttons (Connect/Mount)
- Cancel button (shown during processing)
- Progress indicator with elapsed time
- Info alerts (PAT-style warnings)

**Testing:**
- [ ] Form validation works
- [ ] Submit triggers API correctly
- [ ] Progress updates in real-time
- [ ] Cancel stops process
- [ ] Form clears on success
- [ ] Persisted state survives refresh

#### Task 2.3: Add NAS Connector to Data Connectors List
**Priority:** HIGH  
**Estimated Time:** 30 minutes

**File to Modify:** `frontend/src/components/Modals/ManageWorkspace/DataConnectors/index.jsx`

**Changes:**
```javascript
import DataServerOptions from "./Connectors/DataServer";

export const DATA_CONNECTORS = {
  // ... existing connectors ...
  
  dataserver: {
    name: "NAS",
    image: ConnectorImages.dataserver, // Need to add image
    description: "Import an entire NAS folder in your local NAS or cloud NAS storage.",
    options: <DataServerOptions />,
  },
};
```

**Additional:**
- Create connector image: `frontend/src/components/DataConnectorOption/media/dataserver.png`
  - Suggested: Network drive icon or NAS storage icon
  - Size: 48x48px or SVG
  - Add to `ConnectorImages` object

**Testing:**
- [ ] NAS appears in connector list
- [ ] Icon displays correctly
- [ ] Clicking opens DataServer form
- [ ] Description shows properly

---

### Phase 3: Image Search Feature (6-8 hours)

#### Task 3.1: Create Search API Model
**Priority:** HIGH  
**Estimated Time:** 1 hour

**File to Create:** `frontend/src/models/search.js`

**Implementation:**
```javascript
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
        threshold 
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
};

export default Search;
```

**Testing:**
- [ ] searchText API call works
- [ ] Returns proper results format
- [ ] Error handling functions
- [ ] Headers passed correctly

#### Task 3.2: Create Web Worker for Embeddings
**Priority:** HIGH  
**Estimated Time:** 2 hours

**Files to Create:**
1. `frontend/src/pages/Search/ImageSearch/worker.js` - Web Worker
2. `frontend/src/pages/Search/ImageSearch/WebWorkerFetch.js` - Fetch utilities

**worker.js Implementation:**
```javascript
import { pipeline } from '@xenova/transformers';

// Global pipeline instance
let embedPipeline = null;

// Initialize the pipeline
async function initializePipeline(modelName = 'Xenova/all-MiniLM-L6-v2') {
  if (!embedPipeline) {
    console.log('Initializing embedding model:', modelName);
    self.postMessage({ status: 'initiate' });
    embedPipeline = await pipeline('feature-extraction', modelName);
    self.postMessage({ status: 'ready' });
  }
  return embedPipeline;
}

// Generate embeddings and search
async function performSearch(text, namespaces, distanceMetric, headers, searchId) {
  try {
    const pipe = await initializePipeline();
    
    // Generate embedding
    const embedding = await pipe(text, { pooling: 'mean', normalize: true });
    const embeddingArray = Array.from(embedding.data);
    
    // Call backend search API
    const results = await fetch('/api/search/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        search: text,
        embedding: embeddingArray,
        namespaces,
        distanceMetric,
      }),
    }).then(res => res.json());
    
    self.postMessage({ 
      status: 'complete', 
      output: results, 
      searchId 
    });
  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({ 
      status: 'error', 
      error: error.message,
      searchId
    });
  }
}

// Listen for messages from main thread
self.addEventListener('message', async (event) => {
  const { text, namespaces, distanceMetric, headers, searchId } = event.data;
  await performSearch(text, namespaces, distanceMetric, headers, searchId);
});
```

**Key Features:**
- Lazy initialization of embedding model
- Status updates (initiate, ready, complete, error)
- Search ID tracking for concurrent searches
- Error handling

**Testing:**
- [ ] Worker initializes without errors
- [ ] Embedding generation works
- [ ] Messages sent back to main thread
- [ ] Multiple searches don't conflict

#### Task 3.3: Create Image Search Page Components
**Priority:** HIGH  
**Estimated Time:** 4 hours

**Files to Create:**
1. `frontend/src/pages/Search/ImageSearch/index.jsx` - Main page
2. `frontend/src/pages/Search/ImageSearch/SearchBar.jsx` - Search input
3. `frontend/src/pages/Search/ImageSearch/DistanceSelector.jsx` - Metric selector
4. `frontend/src/pages/Search/ImageSearch/ImageGrid.jsx` - Results grid
5. `frontend/src/pages/Search/ImageSearch/Modal.jsx` - Image viewer modal
6. `frontend/src/pages/Search/ImageSearch/Pagination.jsx` - Pagination controls
7. `frontend/src/pages/Search/ImageSearch/utils.js` - Helper functions

**index.jsx - Main Page Structure:**
```jsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Sidebar from "@/components/Sidebar";
import { SearchBarOption } from './SearchBar';
import { ImageGridV3 } from './ImageGrid';
import { Pagination } from './Pagination';
import { ModalV3 } from './Modal';

export default function ImageSearch() {
  const [ready, setReady] = useState(null);
  const [processedImages, setProcessedImages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentImage, setCurrentImage] = useState(null);
  const [checkedWorkspaces, setCheckedWorkspaces] = useState({});
  const [searchDistance, setSearchDistance] = useState('l2'); // euclidean
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  
  const worker = useRef(null);
  
  // Initialize Web Worker
  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(
        new URL("./worker.js", import.meta.url).href,
        { type: "module" }
      );
    }
    
    const onMessageReceived = async (event) => {
      switch (event.data.status) {
        case 'initiate':
          setReady(false);
          break;
        case 'ready':
          setReady(true);
          break;
        case 'complete':
          const processedResults = await loadBase64Images(event.data.output);
          setProcessedImages(processedResults || []);
          break;
      }
    };
    
    worker.current.addEventListener('message', onMessageReceived);
    return () => worker.current.removeEventListener('message', onMessageReceived);
  }, []);
  
  const search = useCallback(async (text) => {
    setIsProcessing(true);
    setProcessedImages([]);
    
    if (worker.current) {
      const selectedWorkspaces = Object.entries(checkedWorkspaces)
        .filter(([id, isChecked]) => isChecked)
        .map(([id]) => ({ name: workspaces.find(w => w.id === parseInt(id)).name }));
      
      worker.current.postMessage({ 
        text,
        distanceMetric: searchDistance,
        namespaces: selectedWorkspaces,
      });
    }
  }, [checkedWorkspaces, searchDistance]);
  
  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar 
        checkedWorkspaces={checkedWorkspaces}
        onCheckboxChange={(id) => setCheckedWorkspaces(prev => ({
          ...prev,
          [id]: !prev[id]
        }))}
      />
      <main className="flex-1 bg-black p-4 relative text-white">
        <ModalV3 currentImage={currentImage} setCurrentImage={setCurrentImage} />
        <SearchBarOption
          search={search} 
          searchDistance={searchDistance}
          setSearchDistance={setSearchDistance}
        />
        {ready === false && (
          <div className="loading-overlay">
            Loading model and database...
          </div>
        )}
        <ImageGridV3 
          images={paginatedImages} 
          setCurrentImage={setCurrentImage} 
          isLoading={isProcessing} 
        />
        {processedImages?.length > 0 && (
          <Pagination 
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            itemsPerPage={itemsPerPage}
            onItemsPerPageChange={setItemsPerPage}
            totalItems={processedImages.length}
          />
        )}
      </main>
    </div>
  );
}
```

**SearchBar.jsx - Search Input Component:**
```jsx
import { useState } from 'react';
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DistanceSelector } from './DistanceSelector';

export function SearchBarOption({ search, searchDistance, setSearchDistance, distanceOptions }) {
  const [query, setQuery] = useState('');
  
  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      search(query);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
      <div className="flex-1 relative">
        <MagnifyingGlass 
          size={20} 
          className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50" 
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search images by description..."
          className="w-full pl-10 pr-4 py-2 rounded-lg bg-theme-settings-input-bg text-white"
        />
      </div>
      <DistanceSelector 
        value={searchDistance}
        onChange={setSearchDistance}
        options={distanceOptions}
      />
      <button 
        type="submit"
        className="px-6 py-2 rounded-lg bg-primary-button text-white"
      >
        Search
      </button>
    </form>
  );
}
```

**ImageGrid.jsx - Results Display:**
```jsx
export function ImageGridV3({ images, setCurrentImage, isLoading }) {
  if (isLoading) {
    return <div className="loading-spinner">Searching...</div>;
  }
  
  if (!images || images.length === 0) {
    return (
      <div className="text-center text-white/50 mt-10">
        No images found. Try a different search query.
      </div>
    );
  }
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {images.map((image, index) => (
        <div
          key={index}
          onClick={() => setCurrentImage(image)}
          className="relative aspect-square rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
        >
          <img
            src={`data:image/jpeg;base64,${image.image_base64}`}
            alt={image.image_name}
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-xs p-2">
            <div className="truncate">{image.image_name}</div>
            <div>Distance: {image._distance?.toFixed(4)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

**Pagination.jsx:**
```jsx
export function Pagination({ 
  currentPage, 
  totalPages, 
  onPageChange, 
  itemsPerPage, 
  onItemsPerPageChange,
  totalItems 
}) {
  return (
    <div className="flex items-center justify-between mt-6 px-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-white/70">Items per page:</span>
        <select 
          value={itemsPerPage}
          onChange={(e) => onItemsPerPageChange(Number(e.target.value))}
          className="px-2 py-1 rounded bg-theme-settings-input-bg text-white"
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="px-3 py-1 rounded bg-theme-button disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm text-white">
          Page {currentPage} of {totalPages} ({totalItems} items)
        </span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="px-3 py-1 rounded bg-theme-button disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

**Modal.jsx - Image Viewer:**
```jsx
import { X } from "@phosphor-icons/react";

export function ModalV3({ currentImage, setCurrentImage }) {
  if (!currentImage) return null;
  
  return (
    <div 
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={() => setCurrentImage(null)}
    >
      <div className="relative max-w-7xl max-h-full">
        <button
          onClick={() => setCurrentImage(null)}
          className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"
        >
          <X size={24} />
        </button>
        <img
          src={`data:image/jpeg;base64,${currentImage.image_base64}`}
          alt={currentImage.image_name}
          className="max-w-full max-h-screen object-contain"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white p-4">
          <h3 className="text-lg font-bold">{currentImage.image_name}</h3>
          <p className="text-sm text-white/70">Distance: {currentImage._distance?.toFixed(4)}</p>
          {currentImage.camera && <p className="text-sm">Camera: {currentImage.camera}</p>}
          {currentImage.location && (
            <p className="text-sm">
              Location: {currentImage.location.latitude}, {currentImage.location.longitude}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Testing:**
- [ ] Search submits correctly
- [ ] Web Worker initializes
- [ ] Images load and display
- [ ] Pagination works
- [ ] Modal opens/closes
- [ ] Distance metrics change results
- [ ] Workspace filtering works

#### Task 3.4: Add Search Route to App
**Priority:** HIGH  
**Estimated Time:** 30 minutes

**File to Modify:** `frontend/src/App.jsx`

**Changes:**
```javascript
// Add lazy import
const ImageSearch = lazy(() => import("@/pages/Search/ImageSearch"));

// Add route
<Route path="/search/image-search" element={<PrivateRoute Component={ImageSearch} />} />
```

**Testing:**
- [ ] Route loads correctly
- [ ] Private route protection works
- [ ] Navigation from sidebar works

---

### Phase 4: Sidebar Integration (1-2 hours)

#### Task 4.1: Create Search Button Component
**Priority:** MEDIUM  
**Estimated Time:** 30 minutes

**File to Create:** `frontend/src/components/ImageSearch/index.jsx`

**Implementation:**
```jsx
import { MagnifyingGlass } from "@phosphor-icons/react";
import { Link, useMatch } from "react-router-dom";
import paths from "@/utils/paths";

export default function SearchButton() {
  const isInSearch = !!useMatch("/search/*");
  
  return (
    <div className="flex w-fit">
      {isInSearch ? (
        <Link
          to={paths.home()}
          className="transition-all duration-300 p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
          aria-label="Back to Home"
        >
          <MagnifyingGlass className="h-5 w-5" weight="fill" />
        </Link>
      ) : (
        <Link
          to={paths.search.imageSearch()}
          className="transition-all duration-300 p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
          aria-label="Search"
        >
          <MagnifyingGlass className="h-5 w-5" weight="fill" />
        </Link>
      )}
    </div>
  );
}
```

**Testing:**
- [ ] Button displays correctly
- [ ] Toggle between search/home works
- [ ] Styling matches theme

#### Task 4.2: Update Sidebar Component
**Priority:** MEDIUM  
**Estimated Time:** 1 hour

**File to Modify:** `frontend/src/components/Sidebar/index.jsx`

**Changes:**
1. **Add Search Button Import:**
```javascript
import SearchButton from "../ImageSearch";
```

2. **Add Props for Workspace Filtering:**
```javascript
export default function Sidebar({ 
  checkedWorkspaces = {}, 
  onCheckboxChange = null 
}) {
  // ... existing code ...
}
```

3. **Add Search Button to UI:**
```jsx
{/* In footer or main area */}
<button
  onClick={() => navigate(paths.search.imageSearch())}
  className="flex items-center justify-center w-full h-[44px] bg-theme-button-search rounded-[8px] text-white mt-4"
>
  <MagnifyingGlass size={20} className="mr-2" />
  RAG Search
</button>
```

4. **Pass Checkbox Props to ActiveWorkspaces:**
```jsx
<ActiveWorkspaces
  checkedWorkspaces={checkedWorkspaces}
  onCheckboxChange={onCheckboxChange}
/>
```

**Testing:**
- [ ] Search button appears in sidebar
- [ ] Click navigates to search page
- [ ] Props pass correctly to children

#### Task 4.3: Update ActiveWorkspaces Component
**Priority:** MEDIUM  
**Estimated Time:** 30 minutes

**File to Modify:** `frontend/src/components/Sidebar/ActiveWorkspaces/index.jsx`

**Changes:**
```jsx
export default function ActiveWorkspaces({ 
  checkedWorkspaces = {}, 
  onCheckboxChange = null 
}) {
  // ... existing state ...
  
  const renderCheckbox = (workspace) => {
    if (!onCheckboxChange) return null;
    
    return (
      <input
        type="checkbox"
        id={`workspace-${workspace.id}`}
        className="mr-2"
        checked={!!checkedWorkspaces[workspace.id]}
        onChange={() => onCheckboxChange(workspace.id)}
      />
    );
  };
  
  return (
    <div role="list" className="flex flex-col gap-y-2">
      {workspaces.map((workspace) => (
        <div className="flex gap-x-2 items-center">
          {renderCheckbox(workspace)}
          <a href={paths.workspace.chat(workspace.slug)}>
            {/* Existing workspace link */}
          </a>
        </div>
      ))}
    </div>
  );
}
```

**Testing:**
- [ ] Checkboxes appear when on search page
- [ ] Checkboxes don't appear on other pages
- [ ] State updates correctly
- [ ] Workspace links still work

---

### Phase 5: Testing & Polish (2-3 hours)

#### Task 5.1: Integration Testing
**Priority:** HIGH  
**Estimated Time:** 2 hours

**Test Scenarios:**

1. **SMB/NAS Connector:**
   - [ ] Open "Manage Data" modal
   - [ ] Select "NAS" connector
   - [ ] Fill form with valid credentials
   - [ ] Submit "Connect and Process"
   - [ ] Verify progress updates
   - [ ] Cancel mid-process
   - [ ] Verify files appear in document picker
   - [ ] Test "Mount and Process" mode
   - [ ] Verify form persistence on refresh

2. **Image Search:**
   - [ ] Navigate to /search/image-search
   - [ ] Wait for worker to initialize
   - [ ] Select multiple workspaces
   - [ ] Enter search query
   - [ ] Verify results appear
   - [ ] Change distance metric
   - [ ] Verify results change
   - [ ] Click image to open modal
   - [ ] Navigate pages
   - [ ] Change items per page
   - [ ] Verify no memory leaks

3. **Sidebar Integration:**
   - [ ] Search button appears
   - [ ] Click navigates to search
   - [ ] Checkboxes appear in search page
   - [ ] Checkboxes hidden on other pages
   - [ ] State persists during session

#### Task 5.2: Error Handling & Edge Cases
**Priority:** HIGH  
**Estimated Time:** 1 hour

**Test Cases:**
- [ ] Invalid SMB credentials
- [ ] Network timeout during process
- [ ] Empty search results
- [ ] Worker initialization failure
- [ ] Backend API down
- [ ] Large result sets (1000+ images)
- [ ] Slow network conditions
- [ ] Browser without Web Worker support

**Error Messages:**
- [ ] User-friendly error messages
- [ ] Toast notifications work
- [ ] Errors don't crash app
- [ ] Retry mechanisms function

---

## 5. Implementation Details

### 5.1 State Management Strategy

**Local Component State:**
- Form inputs (SMB credentials, search query)
- UI state (loading, processing, modal open/closed)
- Pagination (currentPage, itemsPerPage)

**Persisted State (localStorage):**
- SMB form data (until successful submission)
- Workspace selection (checkedWorkspaces)
- Distance metric preference
- Items per page preference

**Global State (Context):**
- User authentication
- System settings (embedding model)
- Theme preferences

**Server State:**
- Workspaces list
- Processing status
- Search results

### 5.2 Performance Optimizations

**Web Worker Benefits:**
- Embedding generation doesn't block UI
- Multiple searches can queue
- CPU-intensive work offloaded

**Image Loading:**
- Lazy loading with pagination
- Base64 caching in memory
- Progressive enhancement (load thumbnails first)

**Search Debouncing:**
- Optional: Debounce search input (500ms)
- Prevent excessive API calls
- Cancel previous searches when new one starts

**Memory Management:**
- Limit cached images (max 100)
- Clear old search results
- Web Worker cleanup on unmount

### 5.3 Accessibility Considerations

**Keyboard Navigation:**
- [ ] Tab through all interactive elements
- [ ] Enter key submits forms
- [ ] Escape closes modals
- [ ] Arrow keys for pagination

**Screen Readers:**
- [ ] ARIA labels on inputs
- [ ] Role attributes on lists
- [ ] Alt text on images
- [ ] Status announcements for loading/results

**Visual:**
- [ ] Sufficient color contrast
- [ ] Focus indicators visible
- [ ] Loading states clear
- [ ] Error messages prominent

### 5.4 Internationalization (i18n)

**Strings to Translate:**
```javascript
// In locales/en/common.js
export default {
  // ... existing translations ...
  
  dataConnector: {
    nas: {
      title: "NAS / SMB Share",
      description: "Import files from network storage",
      sharePath: "Share Path",
      sharePathPlaceholder: "\\\\192.168.1.100\\share\\path",
      username: "Username",
      password: "Password",
      mountPoint: "Mount Point",
      ignorePatterns: "Ignore Patterns",
      connectAndProcess: "Connect and Process",
      mountAndProcess: "Mount and Process",
      cancelProcess: "Cancel Process",
      processing: "Processing...",
      progressMessage: "Processing... {{percent}}% complete",
    },
  },
  
  search: {
    title: "RAG Search",
    imageSearch: "Image Search",
    searchPlaceholder: "Search images by description...",
    selectWorkspaces: "Select workspaces to search",
    distanceMetric: "Distance Metric",
    euclidean: "Euclidean (L2)",
    cosine: "Cosine Similarity",
    dot: "Dot Product",
    resultsCount: "{{count}} results found",
    noResults: "No images found. Try a different search query.",
    loadingModel: "Loading model and database...",
    itemsPerPage: "Items per page",
    page: "Page {{current}} of {{total}}",
  },
};
```

**Implementation:**
```jsx
import { useTranslation } from "react-i18next";

function Component() {
  const { t } = useTranslation();
  
  return (
    <h1>{t("search.title")}</h1>
  );
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

**Components to Test:**
- [ ] usePersistedState hook
- [ ] SearchBar component
- [ ] ImageGrid component
- [ ] Pagination component
- [ ] DataServer form validation

**Test Framework:** React Testing Library + Jest

**Example Test:**
```javascript
import { renderHook, act } from '@testing-library/react-hooks';
import { usePersistedState } from '@/hooks/usePersistedState';

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  
  it('should persist value to localStorage', () => {
    const { result } = renderHook(() => 
      usePersistedState('test-key', 'default')
    );
    
    act(() => {
      result.current[1]('new value');
    });
    
    expect(localStorage.getItem('test-key')).toBe('"new value"');
  });
});
```

### 6.2 Integration Tests

**Test Flows:**
1. **End-to-End SMB Process:**
   - Open modal → Fill form → Submit → Monitor progress → Verify files

2. **End-to-End Image Search:**
   - Navigate to search → Wait for init → Select workspaces → Search → View results → Open modal

**Test Framework:** Playwright or Cypress

**Example:**
```javascript
describe('Image Search Flow', () => {
  it('should perform a successful search', async () => {
    await page.goto('/search/image-search');
    await page.waitForSelector('[data-testid="search-ready"]');
    
    await page.check('[data-testid="workspace-1"]');
    await page.fill('[data-testid="search-input"]', 'sunset beach');
    await page.click('[data-testid="search-submit"]');
    
    await page.waitForSelector('[data-testid="image-result"]');
    const results = await page.$$('[data-testid="image-result"]');
    
    expect(results.length).toBeGreaterThan(0);
  });
});
```

### 6.3 Performance Tests

**Metrics to Monitor:**
- [ ] Time to interactive (TTI)
- [ ] First contentful paint (FCP)
- [ ] Web Worker initialization time
- [ ] Search response time
- [ ] Image loading time
- [ ] Memory usage over time

**Tools:**
- Chrome DevTools Performance tab
- Lighthouse CI
- Memory profiler

**Benchmarks:**
- Search results in < 2s
- Worker init in < 3s
- Image grid renders in < 500ms
- No memory leaks after 10 searches

---

## 7. Risk Assessment

### 7.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Web Worker browser compatibility** | LOW | HIGH | Feature detection, fallback to main thread |
| **CORS issues with backend** | MEDIUM | HIGH | Configure CORS properly, document setup |
| **Large embedding model load time** | HIGH | MEDIUM | Show loading indicator, use smaller model |
| **Memory leaks from images** | MEDIUM | HIGH | Implement cleanup, limit cache size |
| **Slow SMB network connections** | HIGH | MEDIUM | Progress indicators, timeout handling |
| **Version conflicts with dependencies** | LOW | MEDIUM | Lock file, thorough testing |

### 7.2 User Experience Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Confusing NAS setup** | MEDIUM | MEDIUM | Clear instructions, examples, tooltips |
| **Search returns no results** | HIGH | LOW | Helpful empty state message |
| **Long wait for search results** | MEDIUM | MEDIUM | Loading indicators, progress feedback |
| **Difficult workspace selection** | LOW | LOW | Clear labeling, select all option |

### 7.3 Deployment Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Backend not ready** | MEDIUM | HIGH | Verify backend deployment first |
| **Build process fails** | LOW | HIGH | Test build locally before merge |
| **Breaking changes to existing features** | LOW | CRITICAL | Thorough regression testing |
| **Missing environment variables** | MEDIUM | HIGH | Document all required env vars |

---

## 8. Rollback Plan

If issues arise after deployment:

### 8.1 Immediate Rollback
```bash
# Revert Git commits
git revert <commit-hash-range>
git push origin main

# Rebuild frontend
cd frontend
npm run build

# Restart services
docker-compose restart frontend
```

### 8.2 Feature Flags (Recommended)

**Add to environment:**
```env
ENABLE_NAS_CONNECTOR=true
ENABLE_IMAGE_SEARCH=true
```

**Conditional Rendering:**
```jsx
{process.env.ENABLE_IMAGE_SEARCH === 'true' && (
  <Route path="/search/image-search" element={<ImageSearch />} />
)}
```

**Benefits:**
- Disable features without code changes
- A/B testing capability
- Gradual rollout

---

## 9. Success Criteria

### 9.1 Functional Requirements
- [ ] Users can configure and connect to SMB/NAS shares
- [ ] Files from NAS appear in document picker
- [ ] Users can search images using text queries
- [ ] Search results display with distance scores
- [ ] Users can filter by workspace
- [ ] Pagination works correctly
- [ ] Modal viewer shows image details
- [ ] All error states handled gracefully

### 9.2 Non-Functional Requirements
- [ ] Page load time < 3s
- [ ] Search results in < 2s (90th percentile)
- [ ] No browser console errors
- [ ] Passes accessibility audit (WCAG 2.1 AA)
- [ ] Works in Chrome, Firefox, Safari, Edge
- [ ] Mobile responsive (optional for v1)
- [ ] No memory leaks after 30min session

### 9.3 Code Quality
- [ ] All components have PropTypes or TypeScript
- [ ] ESLint passes with no warnings
- [ ] Test coverage > 70%
- [ ] Code reviewed by 2+ developers
- [ ] Documentation updated

---

## 10. Timeline & Resources

### 10.1 Estimated Timeline
- **Phase 1 (Foundation):** 2-3 hours
- **Phase 2 (NAS Connector):** 4-5 hours
- **Phase 3 (Image Search):** 6-8 hours
- **Phase 4 (Sidebar):** 1-2 hours
- **Phase 5 (Testing):** 2-3 hours
- **Total:** 15-21 hours (~2-3 working days)

### 10.2 Required Resources
- **Frontend Developer:** 1 person (15-21 hours)
- **Backend Verification:** 1 person (2 hours)
- **QA Testing:** 1 person (4 hours)
- **Code Review:** 2 people (2 hours each)

### 10.3 Dependencies
- Backend collector service ready (completed)
- Vector database configured
- Embedding model accessible
- Test environment available

---

## 11. Post-Migration Tasks

### 11.1 Documentation
- [ ] Update user guide with NAS connector instructions
- [ ] Add image search tutorial with screenshots
- [ ] Document distance metrics and their use cases
- [ ] Create FAQ for common issues

### 11.2 Monitoring
- [ ] Set up error tracking (Sentry)
- [ ] Monitor search performance metrics
- [ ] Track NAS connector usage
- [ ] Collect user feedback

### 11.3 Future Enhancements
- [ ] Image upload search (search by image file)
- [ ] Advanced filters (date range, file type)
- [ ] Saved searches
- [ ] Search history
- [ ] Export results
- [ ] Bulk operations on results
- [ ] Fine-tuning UI migration (optional)

---

## 12. Conclusion

This migration plan provides a comprehensive roadmap for bringing SMB/NAS connector and Image Search features from mything-llm to anything-llm frontend. The phased approach ensures:

1. **Incremental Progress:** Each phase can be completed and tested independently
2. **Risk Mitigation:** Feature flags and rollback plans minimize deployment risk
3. **Quality Assurance:** Testing strategy ensures robust implementation
4. **User Experience:** Focus on accessibility and performance

**Next Steps:**
1. Review and approve this plan
2. Verify backend readiness (collector service)
3. Begin Phase 1 implementation
4. Schedule code reviews at end of each phase
5. Plan deployment to staging environment

---

**Document Version:** 1.0  
**Last Updated:** December 31, 2025  
**Status:** Ready for Implementation

