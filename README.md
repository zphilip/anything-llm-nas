# AnythingLLM - Enhanced Edition

> **A private ChatGPT with enterprise features** - Enhanced with local AI providers, advanced data connectors, and semantic image search capabilities.

This is an enhanced version of [AnythingLLM](README.anythingllm.md) with additional enterprise-grade features for local deployment and advanced data integration.

---

## 🆕 New Features

### 🔌 SMB/NAS Data Connector
Directly connect to your network-attached storage (NAS) and SMB shares to index documents without manual file transfers.

**Key Features:**
- **Direct SMB Connection**: Connect to network shares using credentials
- **Mount & Process**: Mount SMB shares and process files in place
- **Progress Tracking**: Real-time progress monitoring with process IDs
- **Background Processing**: Non-blocking document ingestion
- **Ignore Patterns**: Exclude specific directories or file types

**Usage:**
```javascript
// Connect directly to SMB share
await System.dataConnectors.dataserver.connect({
  nasshare: '//server/share',
  username: 'user',
  password: 'pass',
  ignorePaths: ['backup', 'temp']
});

// Mount and process
await System.dataConnectors.dataserver.mount({
  nasshare: '//server/share',
  username: 'user',
  password: 'pass',
  mountpoint: '/mnt/nas'
});

// Check processing status
await System.dataConnectors.dataserver.checkStatus(processId);
```

---

### 🦙 LlamaCpp Local Provider
Run LLM inference and embeddings entirely on your local hardware using llamacpp-python server.

**Key Features:**
- **Local LLM Inference**: No external API calls, full privacy
- **GGUF Model Support**: Use quantized models (4-bit, 5-bit, 8-bit)
- **Custom Models**: Load any GGUF-compatible model
- **Performance Modes**: 
  - `base`: Conservative resource usage
  - `maximum`: Full context window utilization
- **Keep-Alive Management**: Control model memory persistence
- **Vision Embeddings**: CLIP-based image embedding support

**Supported Models:**
- Llama 2/3 (7B, 13B, 70B)
- Mistral/Mixtral
- Phi-2/Phi-3
- CodeLlama
- Any GGUF format model

**Configuration:**
```bash
# LLM Settings
LLAMACPP_BASE_PATH=http://localhost:8080
LLAMACPP_MODEL_PREF=llama-2-7b-chat.Q4_K_M.gguf
LLAMACPP_MODEL_TOKEN_LIMIT=4096
LLAMACPP_PERFORMANCE_MODE=base  # or maximum
LLAMACPP_KEEP_ALIVE_TIMEOUT=300  # seconds

# Embedding Settings
EMBEDDING_ENGINE=llamacpp
EMBEDDING_BASE_PATH=http://localhost:8080
EMBEDDING_MODEL_PREF=nomic-embed-text-v1.5.Q4_K_M.gguf
```

**Dependencies:**
- Install `@huggingface/transformers` for CLIP embeddings
- Run llamacpp-python server on port 8080 (or custom port)

---

### 🖼️ Image Search
Perform semantic image search across your workspaces using vision embeddings.

**Key Features:**
- **Multi-Workspace Search**: Search images across multiple workspaces simultaneously
- **Semantic Similarity**: Find images by visual content, not just filenames
- **Web Worker Processing**: Non-blocking UI with background processing
- **Adjustable Distance Threshold**: Fine-tune search sensitivity (0.0 - 1.0)
- **Pagination**: Handle large image collections efficiently
- **Image Preview**: Click to view full-size images with metadata

**How It Works:**
1. Images are embedded using CLIP vision models during document ingestion
2. Search queries are converted to embeddings
3. Cosine similarity finds visually similar images
4. Results ranked by similarity score

**Access:**
Navigate to `/search/image-search` or use the sidebar search button

**Technical Details:**
- Uses Web Workers for embedding generation
- Supports workspace filtering via checkboxes
- Configurable results per page (10-100)
- Real-time search status updates

---

## 🚀 Quick Start

### Development Mode

```bash
# Install dependencies
yarn install

# Start all services
yarn dev:server   # Server on port 3001
yarn dev:frontend # Frontend on port 3000
yarn dev:collector # Collector on port 8888
```

### Using LlamaCpp

```bash
# Install llamacpp-python
pip install 'llama-cpp-python[server]'

# Download a GGUF model
wget https://huggingface.co/.../model.gguf

# Start server
python -m llama_cpp.server --model ./model.gguf --host 0.0.0.0 --port 8080

# Configure in AnythingLLM
# Go to Settings → LLM Preference → Select "Llama Cpp"
```

### Using SMB Data Connector

1. Navigate to **Data Connectors** → **SMB/NAS**
2. Enter connection details:
   - Share path: `//server/share` or `smb://server/share`
   - Username & Password
   - Optional: Ignore patterns (comma-separated)
3. Choose **Connect** (direct) or **Mount** (mount first)
4. Monitor progress with returned `processId`

---

## 📦 Installation

### Docker (Recommended)

```bash
# Pull image
docker pull anythingllm/anythingllm:latest

# Run with local LlamaCpp
docker run -d \
  -p 3001:3001 \
  -e LLAMACPP_BASE_PATH=http://host.docker.internal:8080 \
  -e EMBEDDING_ENGINE=llamacpp \
  -v ./storage:/app/server/storage \
  anythingllm/anythingllm
```

### Bare Metal

See [BARE_METAL.md](BARE_METAL.md) for detailed installation instructions.

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

## 📚 Additional Documentation

- **[Original AnythingLLM README](README.anythingllm.md)** - Full upstream documentation
- **[Bare Metal Setup](BARE_METAL.md)** - Installation without Docker
- **[Docker Guide](docker/HOW_TO_USE_DOCKER.md)** - Docker deployment details
- **[Contributing](CONTRIBUTING.md)** - Development guidelines
- **[Security](SECURITY.md)** - Security policies

---

## 🛠️ Development

### File Watcher Limits

If you encounter "ENOSPC: System limit for number of file watchers reached":

```bash
# Temporary fix
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Docker compose fix
sysctls:
  - fs.inotify.max_user_watches=524288
```

### Running Tests

```bash
# Server tests
cd server && yarn test

# Collector tests
cd collector && yarn test
```

---

## 🔐 Privacy & Security

- **Local LLM**: All inference happens on your hardware with LlamaCpp
- **No External Calls**: Optional - use only local providers
- **Network Isolation**: Collector runs on internal network only
- **Credential Encryption**: SMB credentials encrypted in transit
- **Data Ownership**: All documents stored locally

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Key areas for contribution:
- Additional data connector types (WebDAV, FTP, S3)
- More local LLM providers
- Enhanced image search features
- Performance optimizations

---

## 📄 License

See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

Based on [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) by Mintplex Labs.

Additional features and enhancements:
- **SMB/NAS Data Connector** - Enterprise network storage integration
- **LlamaCpp Provider** - Local AI inference with GGUF models
- **Image Search** - Semantic visual search capabilities
- **Performance Improvements** - File watcher optimization, proxy routing

---

## 📞 Support

- **Issues**: Open an issue on GitHub
- **Discussions**: Join community discussions
- **Documentation**: Check the docs in `/docs`

---

**Made with ❤️ for privacy-focused AI applications**
