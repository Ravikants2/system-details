import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createServer, parseSubmission } from "../server.js";

test("requires explicit consent and validates the collected system values", () => {
  assert.throws(
    () =>
      parseSubmission({
        consent: false,
        system: {
          browser: "Chrome",
          operatingSystem: "Windows",
          deviceType: "Desktop",
          displayResolution: "1920 x 1080",
        },
      }),
    /Consent is required/,
  );

  assert.throws(
    () =>
      parseSubmission({
        consent: true,
        system: {
          browser: "Chrome<script>",
          operatingSystem: "Windows",
          deviceType: "Desktop",
          displayResolution: "1920 x 1080",
        },
      }),
    /Invalid browser/,
  );

  assert.deepEqual(
    parseSubmission({
      consent: true,
      system: {
        browser: "Chrome",
        operatingSystem: "Windows",
        deviceType: "Desktop",
        displayResolution: "1920 x 1080",
        privateExtra: "discard me",
      },
    }),
    {
      browser: "Chrome",
      operatingSystem: "Windows",
      deviceType: "Desktop",
      displayResolution: "1920 x 1080",
    },
  );
});

test("saves only consented, validated fields through the server-side GitHub API", async (t) => {
  const configKeys = [
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "GITHUB_BRANCH",
    "GITHUB_TOKEN",
  ];
  const previousConfig = Object.fromEntries(
    configKeys.map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries({
    GITHUB_OWNER: "example-owner",
    GITHUB_REPO: "example-repo",
    GITHUB_BRANCH: "main",
    GITHUB_TOKEN: "test-token",
  })) {
    process.env[key] = value;
  }

  const originalFetch = globalThis.fetch;
  let githubRequest;
  let repoCheckCount = 0;
  let repositoryIsPrivate = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== "api.github.com") {
      return originalFetch(input, options);
    }

    if (url.pathname === "/repos/example-owner/example-repo") {
      repoCheckCount += 1;
      return new Response(JSON.stringify({ private: repositoryIsPrivate }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    githubRequest = { url, options };
    return new Response(
      JSON.stringify({
        content: {
          html_url: "https://github.com/example-owner/example-repo/blob/main/record.json",
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    for (const key of configKeys) {
      if (previousConfig[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousConfig[key];
      }
    }
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const collectorResponse = await originalFetch(
    `${origin}/public/Collect-WindowsTelemetry.ps1`,
  );
  assert.equal(collectorResponse.status, 200);
  assert.equal(
    collectorResponse.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.match(await collectorResponse.text(), /MANUAL WINDOWS COLLECTION/);

  repositoryIsPrivate = true;
  const healthResponse = await originalFetch(`${origin}/api/health`);
  assert.deepEqual(await healthResponse.json(), {
    status: "ok",
    storageConfigured: true,
    storagePrivate: true,
  });

  const summaryResponse = await originalFetch(`${origin}/api/summary`);
  assert.equal(summaryResponse.status, 404);

  const submissionBody = JSON.stringify({
    consent: true,
    system: {
      browser: "Chrome",
      operatingSystem: "Windows",
      deviceType: "Desktop",
      displayResolution: "1920 x 1080",
      ipAddress: "not allowed",
    },
  });
  repositoryIsPrivate = false;
  const publicRepoResponse = await originalFetch(`${origin}/api/records`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: submissionBody,
  });
  assert.equal(publicRepoResponse.status, 409);
  assert.equal(githubRequest, undefined);
  assert.equal(repoCheckCount, 2);

  repositoryIsPrivate = true;
  const response = await originalFetch(`${origin}/api/records`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: submissionBody,
  });
  const result = await response.json();
  const upload = JSON.parse(githubRequest.options.body);
  const savedRecord = JSON.parse(
    Buffer.from(upload.content, "base64").toString("utf8"),
  );

  assert.equal(response.status, 201);
  assert.equal(repoCheckCount, 3);
  assert.equal(result.saved, true);
  assert.match(githubRequest.url.pathname, /^\/repos\/example-owner\/example-repo\/contents\/data\/records\//);
  assert.equal(githubRequest.options.headers.Authorization, "Bearer test-token");
  assert.equal(upload.branch, "main");
  assert.deepEqual(
    Object.keys(savedRecord).sort(),
    [
      "browser",
      "collectedAt",
      "deviceType",
      "displayResolution",
      "operatingSystem",
      "schemaVersion",
    ],
  );
  assert.equal(savedRecord.ipAddress, undefined);
});
