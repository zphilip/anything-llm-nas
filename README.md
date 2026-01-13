# AnythingLLM-NAS - Enhanced Edition

> **A private ChatGPT that connects to your local NAS** - Index files from network storage and search images semantically.

Enhanced version of [AnythingLLM](README.anythingllm.md) with NAS integration and visual search capabilities.

---

## 🆕 Key Features

### 📁 NAS/SMB File Indexing
Directly connect to your network storage to index documents automatically.

**Features:**
- Connect to SMB/CIFS shares (NAS, Windows shares)
- Auto-index files from network drives
- Real-time progress tracking
- Background processing

**Quick Setup:**
1. Go to **Data Connectors** → **SMB/NAS**
2. Enter: `//your-nas-ip/share`, username, password
3. Click **Connect** to start indexing

---

### 🖼️ Image Search
Search your images by content, not just filenames.

**Features:**
- Semantic image search using AI vision models
- Search across multiple workspaces
- Visual similarity matching
- Distance threshold control

**Access:**
Navigate to `/search/image-search` or click the search button in sidebar.

**How it works:**
- Images are analyzed and embedded during upload
- Search by describing what you want to find
- Results ranked by visual similarity

---

## 🚀 Quick Start

### Development Mode

```bash
# Install dependencies
yarn install

# Start services
yarn dev:server   # Port 3001
yarn dev:frontend # Port 3000
yarn dev:collector # Port 8888
```

### Docker

```bash
docker run -d \
  -p 3001:3001 \
  -v ./storage:/app/server/storage \
  anythingllm/anythingllm
```

---

## 🔧 Configuration

### Environment Variables

**LlamaCpp Settings:**
```bash
LLAMACPP_BASE_PATH=http://localhost:8080
LLAMACPP_MODEL_PREF=model-name.gguf
LLAMACPP_MODEL_TOKEN_LIMIT=4096
LLAMACPP_PERFORMANCE_MODE=base
LLAMACPP_KEEP_ALIVE_TIMEOUT=300
```

**Embedding Settings:**
```bash
EMBEDDING_ENGINE=llamacpp
EMBEDDING_BASE_PATH=http://localhost:8080
EMBEDDING_MODEL_PREF=embedding-model.gguf
EMBEDDING_MODEL_MAX_CHUNK_LENGTH=8192
```

**Collector Settings:**
```bash
COLLECTOR_PORT=8888
COLLECTOR_ALLOW_ANY_IP=false
```

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│   Server API     │────▶│  Collector      │
│   (React/Vite)  │     │   (Express.js)   │     │  (Port 8888)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                          │
                               ▼                          ▼
                        ┌──────────────┐          ┌──────────────┐
                        │  LlamaCpp    │          │  SMB Client  │
                        │  (Port 8080) │          │  processFiles│
                        └──────────────┘          └──────────────┘
```

---

## 📚 Documentation

- **[Full Documentation](README.anythingllm.md)** - Complete upstream docs
- **[Bare Metal Setup](BARE_METAL.md)** - Installation guide
- **[Docker Guide](docker/HOW_TO_USE_DOCKER.md)** - Docker deployment

---

## 🔐 Privacy

- All data processed locally
- No external API calls required (use local LLM providers)
- Your files stay on your network

---

## 📄 License

See [LICENSE](LICENSE) for details.

---

**Built for private, local AI workflows**
