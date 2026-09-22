import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

const target = process.argv[2];
const requiredMarkers = (
  process.env.EXPECTED_MARKERS ??
  "Canvink|Try the local web demo|https://github.com/arturict/canvink"
)
  .split("|")
  .map((marker) => marker.trim())
  .filter(Boolean);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractAssetReferences(html) {
  const references = new Set();
  const pattern = /<(?:script|link)\b[^>]*(?:src|href)=["']([^"'#]+)["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    references.add(match[1]);
  }
  return [...references];
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function validateDocument(html) {
  assert(
    /<title>\s*Canvink — Local-first ink and PDF notebook\s*<\/title>/i.test(html),
    "Missing descriptive Canvink title",
  );
  assert(
    /<div\s+id=["']root["']\s*><\/div>/i.test(html),
    "Missing React root element",
  );
  assert(
    /<meta\s+name=["']description["']/i.test(html),
    "Missing meta description",
  );
}

function validateMarkers(contents) {
  for (const marker of requiredMarkers) {
    assert(contents.includes(marker), `Built application is missing marker: ${marker}`);
  }
}

function validateManifest(contents) {
  const manifest = JSON.parse(contents);
  assert(manifest.name === "Canvink", "Web manifest has the wrong name");
  assert(manifest.start_url === "/app", "Web manifest must start at /app");
  assert(
    Array.isArray(manifest.icons) && manifest.icons.length > 0,
    "Web manifest must contain an icon",
  );
}

function resolveInside(directory, pathname) {
  const cleanPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  const path = resolve(directory, cleanPath);
  const relativePath = relative(directory, path);
  assert(
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`),
    `Asset escaped output directory: ${pathname}`,
  );
  return path;
}

function smokeDirectory(directory) {
  const root = resolve(directory);
  assert(existsSync(root) && statSync(root).isDirectory(), `${root} is not a directory`);

  const indexPath = join(root, "index.html");
  assert(existsSync(indexPath), "Built site is missing index.html");
  const html = readFileSync(indexPath, "utf8");
  validateDocument(html);

  const staticExtensions = new Set([
    ".css",
    ".ico",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".webmanifest",
    ".woff",
    ".woff2",
  ]);
  for (const reference of extractAssetReferences(html)) {
    const url = new URL(reference, "https://local.invalid/");
    if (url.origin !== "https://local.invalid") {
      continue;
    }
    if (!staticExtensions.has(extname(url.pathname))) {
      continue;
    }
    const assetPath = resolveInside(root, url.pathname);
    assert(existsSync(assetPath), `Built site references missing asset: ${url.pathname}`);
    assert(statSync(assetPath).size > 0, `Built asset is empty: ${url.pathname}`);
  }

  const manifestPath = join(root, "manifest.webmanifest");
  assert(existsSync(manifestPath), "Built site is missing manifest.webmanifest");
  validateManifest(readFileSync(manifestPath, "utf8"));

  const scripts = listFiles(root)
    .filter((path) => extname(path) === ".js")
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  validateMarkers(scripts);
  console.log(`Local site smoke passed: ${root}`);
}

function allowedHost(hostname) {
  const rawConfiguration = process.env.VERCEL_ALLOWED_HOSTS?.trim() ?? "";
  assert(
    rawConfiguration.length > 0,
    "VERCEL_ALLOWED_HOSTS must contain the canonical production hostname",
  );
  const configured = rawConfiguration
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  assert(configured.length > 0, "VERCEL_ALLOWED_HOSTS contains no hostnames");
  for (const host of configured) {
    assert(
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),
      `Invalid allowlisted hostname: ${host}`,
    );
    assert(!host.includes("*"), `Wildcard hosts are forbidden: ${host}`);
    assert(!host.includes(".."), `Invalid allowlisted hostname: ${host}`);
    assert(isIP(host) === 0, `IP-address allowlist entries are forbidden: ${host}`);
    assert(
      host !== "localhost" && !host.endsWith(".localhost"),
      `Localhost allowlist entries are forbidden: ${host}`,
    );
  }
  return configured.includes(hostname.toLowerCase());
}

function validateRemoteUrl(value) {
  const url = new URL(value);
  assert(url.username === "" && url.password === "", "URL credentials are forbidden");
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (local) {
    assert(process.env.ALLOW_LOCALHOST === "true", "Localhost requires ALLOW_LOCALHOST=true");
    assert(["http:", "https:"].includes(url.protocol), "Unsupported localhost protocol");
    return url;
  }

  assert(url.protocol === "https:", "Remote smoke target must use HTTPS");
  assert(url.port === "" || url.port === "443", "Remote smoke target must use HTTPS port 443");
  assert(isIP(url.hostname) === 0, "IP-address smoke targets are forbidden");
  assert(allowedHost(url.hostname), `Host is not allowlisted: ${url.hostname}`);
  return url;
}

async function safeFetch(initialUrl) {
  let current = validateRemoteUrl(initialUrl.toString());
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(current, {
      headers: { "user-agent": "canvink-release-smoke/1" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: current };
    }

    const location = response.headers.get("location");
    assert(location, `Redirect from ${current} has no Location header`);
    current = validateRemoteUrl(new URL(location, current).toString());
  }
  throw new Error(`Too many redirects from ${initialUrl}`);
}

function assertSecurityHeaders(headers) {
  const required = [
    "content-security-policy",
    "permissions-policy",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
  ];
  for (const header of required) {
    assert(headers.has(header), `Missing security header: ${header}`);
  }
  assert(
    headers.get("x-content-type-options")?.toLowerCase() === "nosniff",
    "X-Content-Type-Options must be nosniff",
  );
  assert(
    headers.get("x-frame-options")?.toUpperCase() === "DENY",
    "X-Frame-Options must be DENY",
  );
}

async function smokeRemote(value) {
  const initialUrl = validateRemoteUrl(value);
  assert(
    initialUrl.pathname === "/" && initialUrl.search === "" && initialUrl.hash === "",
    "Canonical production URL must be an origin URL without path, query, or fragment",
  );
  const { response, url } = await safeFetch(initialUrl);
  assert(response.status === 200, `Homepage returned HTTP ${response.status}`);
  assert(
    response.headers.get("content-type")?.includes("text/html"),
    "Homepage did not return HTML",
  );
  if (url.protocol === "https:") {
    assertSecurityHeaders(response.headers);
  }

  const htmlCache = response.headers.get("cache-control") ?? "";
  assert(
    /(max-age=0|no-cache|no-store|must-revalidate)/i.test(htmlCache),
    `Homepage cache policy is unsafe: ${htmlCache || "(missing)"}`,
  );

  const html = await response.text();
  validateDocument(html);
  const references = extractAssetReferences(html)
    .map((reference) => new URL(reference, url))
    .filter((reference) => reference.origin === url.origin);
  assert(references.length > 0, "Homepage has no same-origin assets");

  const scriptContents = [];
  for (const assetUrl of references) {
    const asset = await safeFetch(assetUrl);
    assert(asset.response.status === 200, `${assetUrl.pathname} returned HTTP ${asset.response.status}`);
    const contents = await asset.response.text();
    assert(contents.length > 0, `${assetUrl.pathname} is empty`);

    if (assetUrl.pathname.endsWith(".js")) {
      const cache = asset.response.headers.get("cache-control") ?? "";
      assert(
        /immutable/i.test(cache) && /max-age=(?:31536000|[4-9]\d{6,})/i.test(cache),
        `Hashed asset cache policy is not immutable: ${cache || "(missing)"}`,
      );
      scriptContents.push(contents);
    }
  }
  validateMarkers(scriptContents.join("\n"));

  const manifestResult = await safeFetch(new URL("/manifest.webmanifest", url));
  assert(manifestResult.response.status === 200, "Web manifest is unreachable");
  validateManifest(await manifestResult.response.text());

  const appResult = await safeFetch(new URL("/app", url));
  assert(appResult.response.status === 200, "/app route is unreachable");
  assert(
    appResult.response.headers.get("content-type")?.includes("text/html"),
    "/app route did not return HTML",
  );

  const expectedCommit = process.env.EXPECTED_COMMIT?.trim();
  assert(expectedCommit, "EXPECTED_COMMIT is required for a remote smoke test");
  assert(/^[0-9a-f]{40}$/i.test(expectedCommit), "EXPECTED_COMMIT must be a full SHA");
  const versionResult = await safeFetch(new URL("/version.json", url));
  assert(versionResult.response.status === 200, "version.json is unreachable");
  const version = JSON.parse(await versionResult.response.text());
  const deployedCommit =
    version.commit ?? version.sha ?? version.gitCommitSha ?? version.git?.sha;
  assert(
    deployedCommit === expectedCommit,
    `Deployment commit ${String(deployedCommit)} does not match ${expectedCommit}`,
  );

  console.log(`Remote site smoke passed: ${url}`);
}

try {
  assert(target, "Usage: node scripts/smoke-site.mjs <dist-directory|https-url>");
  if (/^https?:\/\//i.test(target)) {
    await smokeRemote(target);
  } else {
    smokeDirectory(target);
  }
} catch (error) {
  console.error(`Site smoke failed: ${error.message}`);
  process.exitCode = 1;
}
