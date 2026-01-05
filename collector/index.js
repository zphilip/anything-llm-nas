process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

require("./utils/logger")();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { ACCEPTED_MIMES } = require("./utils/constants");
const { reqBody } = require("./utils/http");
const { processSingleFile } = require("./processSingleFile");
const { processLink, getLinkText } = require("./processLink");
const { wipeCollectorStorage } = require("./utils/files");
const extensions = require("./extensions");
const { processRawText } = require("./processRawText");
const { verifyPayloadIntegrity } = require("./middleware/verifyIntegrity");
const { httpLogger } = require("./middleware/httpLogger");
const { v4: uuidv4 } = require('uuid');
const app = express();
const FILE_LIMIT = "3GB";

// SMB/NAS Process Management
const activeProcesses = new Map();
const CLEANUP_INTERVAL = 60000; // 60 seconds
const EXPIRATION_TIME = 300000; // 5 minutes

function cleanupProcesses() {
  const now = Date.now();
  activeProcesses.forEach((process, processId) => {
    if (['completed', 'failed', 'interrupted'].includes(process.status) && 
        (now - process.timestamp >= EXPIRATION_TIME)) {
      console.log(`Removing expired process: ${processId}`);
      activeProcesses.delete(processId);
    }
  });
}

setInterval(cleanupProcesses, CLEANUP_INTERVAL);

// Only log HTTP requests in development mode and if the ENABLE_HTTP_LOGGER environment variable is set to true
if (
  process.env.NODE_ENV === "development" &&
  !!process.env.ENABLE_HTTP_LOGGER
) {
  app.use(
    httpLogger({
      enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
    })
  );
}
app.use(cors({ origin: true }));
app.use(
  bodyParser.text({ limit: FILE_LIMIT }),
  bodyParser.json({ limit: FILE_LIMIT }),
  bodyParser.urlencoded({
    limit: FILE_LIMIT,
    extended: true,
  })
);

app.post(
  "/process",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { filename, options = {}, metadata = {} } = reqBody(request);
    try {
      const targetFilename = path
        .normalize(filename)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const {
        success,
        reason,
        documents = [],
      } = await processSingleFile(targetFilename, options, metadata);
      response
        .status(200)
        .json({ filename: targetFilename, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: filename,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/parse",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { filename, options = {} } = reqBody(request);
    try {
      const targetFilename = path
        .normalize(filename)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const {
        success,
        reason,
        documents = [],
      } = await processSingleFile(targetFilename, {
        ...options,
        parseOnly: true,
      });
      response
        .status(200)
        .json({ filename: targetFilename, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: filename,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/process-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link, scraperHeaders = {}, metadata = {} } = reqBody(request);
    try {
      const {
        success,
        reason,
        documents = [],
      } = await processLink(link, scraperHeaders, metadata);
      response.status(200).json({ url: link, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        url: link,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/util/get-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link, captureAs = "text" } = reqBody(request);
    try {
      const { success, content = null } = await getLinkText(link, captureAs);
      response.status(200).json({ url: link, success, content });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        url: link,
        success: false,
        content: null,
      });
    }
    return;
  }
);

app.post(
  "/process-raw-text",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { textContent, metadata } = reqBody(request);
    try {
      const {
        success,
        reason,
        documents = [],
      } = await processRawText(textContent, metadata);
      response
        .status(200)
        .json({ filename: metadata.title, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: metadata?.title || "Unknown-doc.txt",
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

// SMB/NAS Share Endpoints
app.post(
  "/mountNASShare",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { nasshare, username, password, mountpoint, ignores } = reqBody(request);
    
    const processId = uuidv4();
    activeProcesses.set(processId, { 
      status: 'started', 
      progress: 0, 
      shouldStop: false, 
      result: null, 
      timestamp: Date.now() 
    });
    console.log(`Starting mount process with ID: ${processId}`);

    try {
      if (!nasshare || !username || !password) {
        return response.status(400).json({
          success: false,
          reason: "Missing required fields: username, password, or nasshare.",
          documents: [],
        });
      }

      const { mountSmbShare } = require("./mountSmbShare");
      const result = await mountSmbShare(
        processId, 
        activeProcesses, 
        nasshare, 
        username, 
        password, 
        ignores
      );
      
      if (!result.success) {
        return response.status(400).json({ 
          nasshare, 
          processId, 
          success: false, 
          reason: result.reason, 
          documents: [] 
        });
      }
      
      response.status(200).json({ nasshare, processId, success: true });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        nasshare,
        processId,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.get('/processStatus/:processId', (req, res) => {
  const processId = req.params.processId;
  if (!activeProcesses.has(processId)) {
    return res.status(404).json({ message: 'Process not found' });
  }
  
  const status = activeProcesses.get(processId);
  res.json(status);
});

app.post(
  "/processStopNASShare",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { processId } = reqBody(request);

    if (!processId || !activeProcesses.has(processId)) {
      return response.status(400).json({ error: 'Invalid process ID or process not found' });
    }

    const process = activeProcesses.get(processId);
    process.shouldStop = true;

    console.log(`Stopping process with ID: ${processId}`);
    response.json({ message: `Process ${processId} is stopping` });
  }
);

app.post(
  "/processStopAll",
  [verifyPayloadIntegrity],
  async function (request, response) {
    if (activeProcesses.size === 0) {
      return response.status(400).json({ error: "No active processes to stop" });
    }

    activeProcesses.forEach((process, processId) => {
      process.shouldStop = true;
      console.log(`Stopping process with ID: ${processId}`);
    });

    activeProcesses.clear();
    console.log("All processes stopped and cleared");

    response.json({ message: "All processes have been stopped and cleared" });
  }
);

extensions(app);

app.get("/accepts", function (_, response) {
  response.status(200).json(ACCEPTED_MIMES);
});

app.all("*", function (_, response) {
  response.sendStatus(200);
});

app
  .listen(8888, async () => {
    await wipeCollectorStorage();
    console.log(`Document processor app listening on port 8888`);
  })
  .on("error", function (_) {
    process.once("SIGUSR2", function () {
      process.kill(process.pid, "SIGUSR2");
    });
    process.on("SIGINT", function () {
      process.kill(process.pid, "SIGINT");
    });
  });
