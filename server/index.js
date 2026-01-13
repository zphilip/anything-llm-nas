process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

require("./utils/logger")();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { reqBody } = require("./utils/http");
const { systemEndpoints } = require("./endpoints/system");
const { workspaceEndpoints } = require("./endpoints/workspaces");
const { chatEndpoints } = require("./endpoints/chat");
const { embeddedEndpoints } = require("./endpoints/embed");
const { embedManagementEndpoints } = require("./endpoints/embedManagement");
const { getVectorDbClass } = require("./utils/helpers");
const { adminEndpoints } = require("./endpoints/admin");
const { inviteEndpoints } = require("./endpoints/invite");
const { utilEndpoints } = require("./endpoints/utils");
const { developerEndpoints } = require("./endpoints/api");
const { extensionEndpoints } = require("./endpoints/extensions");
const { bootHTTP, bootSSL } = require("./utils/boot");
const { workspaceThreadEndpoints } = require("./endpoints/workspaceThreads");
const { documentEndpoints } = require("./endpoints/document");
const { agentWebsocket } = require("./endpoints/agentWebsocket");
const { experimentalEndpoints } = require("./endpoints/experimental");
const { browserExtensionEndpoints } = require("./endpoints/browserExtension");
const { communityHubEndpoints } = require("./endpoints/communityHub");
const { agentFlowEndpoints } = require("./endpoints/agentFlows");
const { mcpServersEndpoints } = require("./endpoints/mcpServers");
const { mobileEndpoints } = require("./endpoints/mobile");
const { searchEndpoints } = require("./endpoints/search");
const { httpLogger } = require("./middleware/httpLogger");

// Redis support (optional)
let redisHelper = null;
let handleFileAdd = null;
try {
  const { redisHelper: helper } = require("./utils/files/redis");
  const { handleFileAdd: handler } = require("./jobs/redis-watched-documents");
  redisHelper = helper;
  handleFileAdd = handler;
  global.redisHelper = helper; // Make it globally available
  console.log("✅ Redis support enabled");
} catch (e) {
  console.log("⚠️ Redis support disabled:", e.message);
}

const app = express();
const apiRouter = express.Router();
const FILE_LIMIT = "3GB";

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
app.use(bodyParser.text({ limit: FILE_LIMIT }));
app.use(bodyParser.json({ limit: FILE_LIMIT }));
app.use(
  bodyParser.urlencoded({
    limit: FILE_LIMIT,
    extended: true,
  })
);

if (!!process.env.ENABLE_HTTPS) {
  bootSSL(app, process.env.SERVER_PORT || 3001);
} else {
  require("@mintplex-labs/express-ws").default(app); // load WebSockets in non-SSL mode.
}

app.use("/api", apiRouter);
systemEndpoints(apiRouter);
extensionEndpoints(apiRouter);
workspaceEndpoints(apiRouter);
workspaceThreadEndpoints(apiRouter);
chatEndpoints(apiRouter);
adminEndpoints(apiRouter);
inviteEndpoints(apiRouter);
embedManagementEndpoints(apiRouter);
utilEndpoints(apiRouter);
documentEndpoints(apiRouter);
agentWebsocket(apiRouter);
experimentalEndpoints(apiRouter);
developerEndpoints(app, apiRouter);
communityHubEndpoints(apiRouter);
agentFlowEndpoints(apiRouter);
mcpServersEndpoints(apiRouter);
mobileEndpoints(apiRouter);
searchEndpoints(apiRouter);

// Externally facing embedder endpoints
embeddedEndpoints(apiRouter);

// Externally facing browser extension endpoints
browserExtensionEndpoints(apiRouter);

// Serve document storage files (for image base64 JSON files)
app.use(
  "/documents",
  express.static(path.resolve(__dirname, "storage/documents"), {
    setHeaders: (res) => {
      res.removeHeader("X-Powered-By");
      res.setHeader("Content-Type", "application/json");
    },
  })
);

if (process.env.NODE_ENV !== "development") {
  const { MetaGenerator } = require("./utils/boot/MetaGenerator");
  const IndexPage = new MetaGenerator();

  app.use(
    express.static(path.resolve(__dirname, "public"), {
      extensions: ["js"],
      setHeaders: (res) => {
        // Disable I-framing of entire site UI
        res.removeHeader("X-Powered-By");
        res.setHeader("X-Frame-Options", "DENY");
      },
    })
  );

  app.get("/robots.txt", function (_, response) {
    response.type("text/plain");
    response.send("User-agent: *\nDisallow: /").end();
  });

  app.get("/manifest.json", async function (_, response) {
    IndexPage.generateManifest(response);
    return;
  });

  app.use("/", function (_, response) {
    IndexPage.generate(response);
    return;
  });
} else {
  // In development mode, proxy to frontend dev server
  const { createProxyMiddleware } = require("http-proxy-middleware");
  const frontendDevServer = process.env.FRONTEND_DEV_SERVER || "http://localhost:3000";
  
  // Proxy all non-API requests to the frontend dev server
  app.use("/", createProxyMiddleware({ 
    target: frontendDevServer, 
    changeOrigin: true,
    ws: true
  }));

  // Debug route for development connections to vectorDBs
  apiRouter.post("/v/:command", async (request, response) => {
    try {
      const VectorDb = getVectorDbClass();
      const { command } = request.params;
      if (!Object.getOwnPropertyNames(VectorDb).includes(command)) {
        response.status(500).json({
          message: "invalid interface command",
          commands: Object.getOwnPropertyNames(VectorDb),
        });
        return;
      }

      try {
        const body = reqBody(request);
        const resBody = await VectorDb[command](body);
        response.status(200).json({ ...resBody });
      } catch (e) {
        // console.error(e)
        console.error(JSON.stringify(e));
        response.status(500).json({ error: e.message });
      }
      return;
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/robots.txt", function (_, response) {
    response.type("text/plain");
    response.send("User-agent: *\nDisallow: /").end();
  });
}

app.all("*", function (_, response) {
  response.sendStatus(404);
});

// Initialize Redis before starting the server (if available)
(async () => {
  if (redisHelper && handleFileAdd) {
    try {
      await redisHelper.connect();
      await redisHelper.loadCacheFileToRedis();
      await redisHelper.subscribeToUpdates("file:metadata:updates", handleFileAdd);
      console.log("✅ Redis initialized and subscribed to file updates");
    } catch (error) {
      console.error("❌ Redis initialization failed:", error.message);
    }
  }

  // Boot the HTTP server
  if (!process.env.ENABLE_HTTPS) bootHTTP(app, process.env.SERVER_PORT || 3001);
})();
