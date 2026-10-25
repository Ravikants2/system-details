import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Set([
  "index.html",
  "public/styles.css",
  "public/app.js",
  "public/Collect-WindowsTelemetry.ps1",
]);
const maxBodyBytes = 2048;
const submissionsPerHour = 12;
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimits = new Map();

const allowedValues = {
  browser: new Set(["Chrome", "Edge", "Firefox", "Safari", "Opera", "Other"]),
  operatingSystem: new Set([
    "Windows",
    "macOS",
    "Linux",
    "Android",
    "iOS",
    "ChromeOS",
    "Other",
  ]),
  deviceType: new Set(["Desktop", "Mobile", "Tablet"]),
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function githubConfig() {
  const { GITHUB_OWNER: owner, GITHUB_REPO: repo } = process.env;
  let token = process.env.GITHUB_TOKEN?.trim();
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!token || token === "github_pat_replace_me") {
    try {
      const cliEnvironment = { ...process.env };
      delete cliEnvironment.GITHUB_TOKEN;
      token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
        encoding: "utf8",
        env: cliEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
    } catch (error) {
      if (error.code !== "ENOENT" && error.status !== 1) {
        throw new Error("Unable to retrieve the GitHub CLI credential.");
      }
      token = "";
    }
  }

  if (!owner || !repo || !token) {
    return null;
  }

  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error("GITHUB_OWNER or GITHUB_REPO contains invalid characters.");
  }

  return { owner, repo, token, branch };
}

function parseSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (value.consent !== true) {
    throw new Error("Consent is required before saving a record.");
  }

  const data = value.system;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("System details are missing.");
  }

  for (const field of Object.keys(allowedValues)) {
    if (!allowedValues[field].has(data[field])) {
      throw new Error(`Invalid ${field}.`);
    }
  }

  if (
    typeof data.displayResolution !== "string" ||
    !/^\d{2,5} x \d{2,5}$/.test(data.displayResolution)
  ) {
    throw new Error("Invalid display resolution.");
  }

  const [width, height] = data.displayResolution.split(" x ").map(Number);
  if (width > 10000 || height > 10000) {
    throw new Error("Display resolution is outside the supported range.");
  }

  return {
    browser: data.browser,
    operatingSystem: data.operatingSystem,
    deviceType: data.deviceType,
    displayResolution: data.displayResolution,
  };
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
}

function getClientAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

function checkRateLimit(request) {
  const now = Date.now();
  const address = getClientAddress(request);
  if (!rateLimits.has(address) && rateLimits.size >= 10000) {
    return false;
  }
  const recentRequests = (rateLimits.get(address) || []).filter(
    (timestamp) => now - timestamp < rateLimitWindowMs,
  );

  if (recentRequests.length >= submissionsPerHour) {
    rateLimits.set(address, recentRequests);
    return false;
  }

  recentRequests.push(now);
  rateLimits.set(address, recentRequests);

  if (rateLimits.size > 10000) {
    for (const [key, timestamps] of rateLimits) {
      if (timestamps.every((timestamp) => now - timestamp >= rateLimitWindowMs)) {
        rateLimits.delete(key);
      }
    }
  }

  return true;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) {
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
      });
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      statusCode: 400,
    });
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "system-details-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(config, apiPath, options = {}) {
  const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const url = apiPath ? `${repositoryUrl}/${apiPath}` : repositoryUrl;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(config.token),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      typeof errorBody.message === "string" ? errorBody.message : "Unknown error";
    throw Object.assign(
      new Error(`GitHub API returned ${response.status}: ${message}`),
      { statusCode: response.status === 404 ? 503 : 502 },
    );
  }

  return response.json();
}

async function verifyPrivateRepository(config) {
  const repository = await githubRequest(config, "");
  if (repository.private !== true) {
    throw Object.assign(
      new Error("Refusing to store system data in a public GitHub repository."),
      { statusCode: 409 },
    );
  }
}

async function saveRecord(config, system) {
  await verifyPrivateRepository(config);
  const id = randomUUID();
  const collectedAt = new Date().toISOString();
  const date = collectedAt.slice(0, 10);
  const fileName = [
    date,
    slug(system.browser),
    slug(system.operatingSystem),
    slug(system.deviceType),
    id,
  ].join("--");
  const filePath = `data/records/${fileName}.json`;
  const record = {
    schemaVersion: 1,
    collectedAt,
    ...system,
  };
  const content = Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString(
    "base64",
  );
  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const response = await githubRequest(config, `contents/${encodedPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Add consented system details record ${id}`,
      content,
      branch: config.branch,
    }),
  });

  return {
    saved: true,
    recordUrl:
      response.content?.html_url ||
      `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${filePath}`,
  };
}

async function handleApi(request, response, url) {
  let config;
  try {
    config = githubConfig();
  } catch (error) {
    console.error("Invalid GitHub configuration:", error.message);
    sendJson(response, 500, { error: "GitHub storage is misconfigured." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    if (!config) {
      sendJson(response, 200, {
        status: "ok",
        storageConfigured: false,
        storagePrivate: false,
      });
      return;
    }

    try {
      await verifyPrivateRepository(config);
      sendJson(response, 200, {
        status: "ok",
        storageConfigured: true,
        storagePrivate: true,
      });
    } catch (error) {
      console.error("GitHub storage is not a private repository:", error.message);
      sendJson(response, 503, {
        status: "degraded",
        storageConfigured: true,
        storagePrivate: false,
      });
    }
    return;
  }

  if (!config) {
    sendJson(response, 503, {
      error: "GitHub storage is not configured on this server.",
    });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/api/records") {
    sendJson(response, 404, { error: "API route not found." });
    return;
  }

  if (
    request.headers.origin &&
    request.headers.origin !== `http://${request.headers.host}` &&
    request.headers.origin !== `https://${request.headers.host}`
  ) {
    sendJson(response, 403, { error: "Cross-origin submissions are not allowed." });
    return;
  }

  if (!request.headers["content-type"]?.startsWith("application/json")) {
    sendJson(response, 415, { error: "Send the record as JSON." });
    return;
  }

  if (!checkRateLimit(request)) {
    sendJson(response, 429, {
      error: "Too many submissions from this network. Please try again later.",
    });
    return;
  }

  try {
    const submission = await readJsonBody(request);
    const system = parseSubmission(submission);
    const result = await saveRecord(config, system);
    sendJson(response, 201, result);
  } catch (error) {
    const statusCode = error.statusCode || 400;
    if (statusCode >= 500) {
      console.error("Unable to save GitHub record:", error.message);
    }
    sendJson(response, statusCode, {
      error:
        statusCode >= 500
          ? "The record could not be saved to GitHub. Please try again later."
          : error.message,
    });
  }
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!staticFiles.has(relativePath)) {
    sendJson(response, 404, { error: "Page not found." });
    return;
  }
  const filePath = path.join(rootDirectory, relativePath);

  try {
    await access(filePath);
    const extension = path.extname(filePath);
    const contentType =
      extension === ".ps1"
        ? "application/octet-stream"
        : mimeTypes[extension] || "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Page not found." });
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );

    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    } catch {
      sendJson(response, 400, { error: "Invalid request URL." });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(response, 400, { error: "Invalid page path." });
      return;
    }
    await serveStatic(response, pathname);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";

  server.listen(port, host, () => {
    console.log(`System Details dashboard listening on http://${host}:${port}`);
    if (!process.env.GITHUB_TOKEN) {
      console.error(
        "GitHub storage is not configured. Set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN to enable submissions.",
      );
    }
  });
}

export { createServer, parseSubmission };
