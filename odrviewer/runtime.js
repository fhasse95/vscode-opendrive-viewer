const fs = require("fs");
const https = require("https");
const path = require("path");

const runtimeUrls = Object.freeze({
  viewerJs: "https://odrviewer.io/viewer.js",
  viewerWasm: "https://odrviewer.io/viewer.wasm"
});

function request(url, method, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const httpRequest = https.request(url, { method }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error("Too many redirects while requesting the ODRViewer runtime"));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).toString();
        request(redirectUrl, method, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`ODRViewer runtime request failed with HTTP ${response.statusCode}`));
        return;
      }

      if (method === "HEAD") {
        response.resume();
        response.on("end", () => resolve({
          etag: response.headers.etag || null,
          lastModified: response.headers["last-modified"] || null,
          contentLength: response.headers["content-length"] || null
        }));
        return;
      }

      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        data: Buffer.concat(chunks),
        etag: response.headers.etag || null,
        lastModified: response.headers["last-modified"] || null,
        contentLength: response.headers["content-length"] || null
      }));
    });
    httpRequest.on("error", reject);
    httpRequest.end();
  });
}

class RuntimeManager {
  constructor(context) {
    this.runtimeDirectory = path.join(context.globalStorageUri.fsPath, "odrviewer-runtime");
    this.viewerJsPath = path.join(this.runtimeDirectory, "viewer.js");
    this.viewerWasmPath = path.join(this.runtimeDirectory, "viewer.wasm.base64");
    this.metadataPath = path.join(this.runtimeDirectory, "metadata.json");
  }

  isInstalled() {
    return fs.existsSync(this.viewerJsPath) && fs.existsSync(this.viewerWasmPath);
  }

  async readMetadata() {
    try {
      return JSON.parse(await fs.promises.readFile(this.metadataPath, "utf8"));
    } catch {
      return null;
    }
  }

  async checkForUpdate() {
    if (!this.isInstalled()) {
      return { status: "missing" };
    }

    const metadata = await this.readMetadata();
    if (!metadata) {
      return { status: "unknown" };
    }

    const [viewerJs, viewerWasm] = await Promise.all([
      request(runtimeUrls.viewerJs, "HEAD"),
      request(runtimeUrls.viewerWasm, "HEAD")
    ]);
    const changed = [viewerJs, viewerWasm].some((remote, index) => {
      const local = metadata[index === 0 ? "viewerJs" : "viewerWasm"];
      return remote.etag !== local.etag || remote.lastModified !== local.lastModified;
    });
    return { status: changed ? "update" : "current" };
  }

  async download() {
    const [viewerJs, viewerWasm] = await Promise.all([
      request(runtimeUrls.viewerJs, "GET"),
      request(runtimeUrls.viewerWasm, "GET")
    ]);
    await fs.promises.mkdir(this.runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(this.viewerJsPath, viewerJs.data);
    await fs.promises.writeFile(this.viewerWasmPath, viewerWasm.data.toString("base64"));
    await fs.promises.writeFile(this.metadataPath, JSON.stringify({
      source: runtimeUrls,
      viewerJs: {
        etag: viewerJs.etag,
        lastModified: viewerJs.lastModified
      },
      viewerWasm: {
        etag: viewerWasm.etag,
        lastModified: viewerWasm.lastModified
      }
    }, null, 2));
  }

  getPaths() {
    return {
      viewerJsPath: this.viewerJsPath,
      viewerWasmPath: this.viewerWasmPath
    };
  }
}

module.exports = {
  RuntimeManager
};