# AI Agent Notes — Resync & Caching Changes

Date: 2026-01-30

Summary of work performed:

- Added adaptive resync concurrency: split tasks into small and large files and introduced `RESYNC_LARGE_CONCURRENCY` (default 2) to allow overlapping large reads and tune IO contention.
- Instrumented per-file timings (`statMs`, `readMs`, `cachedMs`, `parseMs`, `canWatchMs`) and gated verbose logs with `DEBUG_RESYNC` and `RESYNC_SLOW_MS`.
- Implemented per-folder Redis keys and made `saveFolderData` overwrite (persist) folder data in Redis.
- Implemented per-folder on-disk caches under `server/storage/cache/folders/*.json` with `saveFolderCache` and `loadFolderCache` helpers. These caches store metadata only (no `pageContent` or `imageBase64`) and include `mtimeMs`/`size`.
- Made cache loading tolerant: `loadFolderCache` filters missing/stale entries and returns partial caches (prevents full-cache failure).
- Added `preloadFolderCaches()` (runs on module load) to load per-folder caches from disk and push them into Redis (best-effort) for fast startup.
- Added `POST /system/refresh-folder-cache` endpoint to force-refresh a single folder (rescans, updates Redis and disk cache).
- Protected `/system/local-files` serialization: strips large fields and returns a compact summary when payload is too large to avoid JSON.stringify OOMs.
- Disabled legacy full-directory writes to avoid huge memory and disk writes; moved to per-folder incremental saves.

Operational notes & recommendations:
- Disk usage was high (ENOSPC risk). Free disk space and enable Redis persistence (RDB/AOF) to ensure per-folder keys survive restarts.
- Consider adding gzip + rotation for per-folder caches to limit disk growth; I can implement this next.

Files changed or added (high level):
- `server/utils/files/index.js` — resync changes, timing instrumentation, per-folder cache helpers, preload, refresh helper.
- `server/utils/files/redis.js` — changed `saveFolderData` to overwrite and added helper methods.
- `server/endpoints/system.js` — added `/system/refresh-folder-cache` and hardened `/system/local-files` output.

Next steps you can ask me to implement:
- gzip + rotation for `server/storage/cache/folders`
- `/system/cache-status` endpoint to report per-folder Redis key presence and counts
- streaming JSON parsing for very large files to reduce read+parse latency

End of notes.
