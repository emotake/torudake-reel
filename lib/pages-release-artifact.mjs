import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

export const PAGES_ARTIFACT_SCHEMA_VERSION = 1;
export const PAGES_ARTIFACT_ROOT = "dist/cloudflare-pages";
export const PAGES_STAGE_DIRECTORY_PREFIX = ".torudake-pages-stage-";
export const PAGES_WRANGLER_DIRECTORY_PREFIX = ".torudake-pages-wrangler-";
export const DEFAULT_PAGES_ARTIFACT_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxDirectories: 10_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 1024,
});

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const REQUIRED_WORKER_PATH = "_worker.js";
const AGGREGATE_DOMAIN = "torudake-pages-release-artifact-v1\n";
const RELEASE_TEMP_SUFFIX_PATTERN = /^[A-Za-z0-9]{6}$/;
const RELEASE_TEMP_PREFIXES = new Set([
  PAGES_STAGE_DIRECTORY_PREFIX,
  PAGES_WRANGLER_DIRECTORY_PREFIX,
]);

function canonicalPathCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isSamePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isPathInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative !== "" &&
    !childRelative.startsWith(`..${sep}`) &&
    childRelative !== ".." &&
    !isAbsolute(childRelative)
  );
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function resolveLimits(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Artifact limits must be an object.");
  }
  const limits = { ...DEFAULT_PAGES_ARTIFACT_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_PAGES_ARTIFACT_LIMITS)) {
    assertPositiveSafeInteger(limits[name], name);
  }
  return limits;
}

function assertLowercaseCommit(value, label = "Source commit") {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character Git commit.`);
  }
  return value;
}

function assertIsoTimestamp(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("Artifact generation time must be a canonical ISO timestamp.");
  }
  return value;
}

export function assertSafeArtifactRelativePath(value, { maxPathBytes = 1024 } = {}) {
  assertPositiveSafeInteger(maxPathBytes, "maxPathBytes");
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > maxPathBytes ||
    posix.normalize(value) !== value
  ) {
    throw new Error("Artifact manifest contains an unsafe relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Artifact manifest contains an unsafe relative path.");
  }
  return value;
}

function canonicalCollisionKey(value) {
  return value.normalize("NFC").toLowerCase();
}

export function computePagesArtifactAggregate(files) {
  if (!Array.isArray(files)) {
    throw new TypeError("Artifact files must be an array.");
  }
  const hash = createHash("sha256");
  hash.update(AGGREGATE_DOMAIN, "utf8");
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.size, file.sha256]), "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

export function pagesReleaseMessage(sourceCommit, artifactSha256) {
  assertLowercaseCommit(sourceCommit);
  if (typeof artifactSha256 !== "string" || !SHA256_PATTERN.test(artifactSha256)) {
    throw new Error("Pages artifact hash must be a lowercase SHA-256 digest.");
  }
  return `torudake-pages-v1 commit=${sourceCommit} artifactSha256=${artifactSha256}`;
}

function exactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(canonicalPathCompare);
  const expected = [...expectedKeys].sort(canonicalPathCompare);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function validatePagesArtifactManifest(
  manifest,
  { expectedSourceCommit, limits: limitOverrides } = {},
) {
  const errors = [];
  let limits;
  try {
    limits = resolveLimits(limitOverrides);
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }

  const manifestKeys = [
    "schemaVersion",
    "artifactRoot",
    "sourceCommit",
    "generatedAt",
    "fileCount",
    "totalBytes",
    "aggregateSha256",
    "deploymentMessage",
    "files",
  ];
  if (!exactKeys(manifest, manifestKeys)) {
    return {
      valid: false,
      errors: ["Pages artifact manifest does not match the exact schema."],
    };
  }
  if (manifest.schemaVersion !== PAGES_ARTIFACT_SCHEMA_VERSION) {
    errors.push("Pages artifact manifest schema version is invalid.");
  }
  if (manifest.artifactRoot !== PAGES_ARTIFACT_ROOT) {
    errors.push("Pages artifact root is invalid.");
  }
  if (!COMMIT_PATTERN.test(manifest.sourceCommit ?? "")) {
    errors.push("Pages artifact source commit is invalid.");
  }
  if (
    expectedSourceCommit !== undefined &&
    manifest.sourceCommit !== expectedSourceCommit
  ) {
    errors.push("Pages artifact source commit does not match the reviewed HEAD.");
  }
  try {
    assertIsoTimestamp(manifest.generatedAt);
  } catch (error) {
    errors.push(error.message);
  }
  if (!Array.isArray(manifest.files)) {
    errors.push("Pages artifact files must be an array.");
    return { valid: false, errors };
  }
  if (
    !Number.isSafeInteger(manifest.fileCount) ||
    manifest.fileCount < 1 ||
    manifest.fileCount > limits.maxFiles ||
    manifest.fileCount !== manifest.files.length
  ) {
    errors.push("Pages artifact file count is invalid.");
  }

  const seen = new Set();
  let previousPath = null;
  let computedTotalBytes = 0;
  let workerPresent = false;
  for (const file of manifest.files) {
    if (!exactKeys(file, ["path", "size", "sha256"])) {
      errors.push("Pages artifact file entry does not match the exact schema.");
      continue;
    }
    let safePath = false;
    try {
      assertSafeArtifactRelativePath(file.path, limits);
      safePath = true;
    } catch (error) {
      errors.push(error.message);
    }
    if (safePath) {
      const collisionKey = canonicalCollisionKey(file.path);
      if (seen.has(collisionKey)) {
        errors.push("Pages artifact paths collide case-insensitively.");
      }
      seen.add(collisionKey);
      if (previousPath !== null && canonicalPathCompare(previousPath, file.path) >= 0) {
        errors.push("Pages artifact files are not in canonical sorted order.");
      }
      previousPath = file.path;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      errors.push("Pages artifact file size is invalid.");
    } else if (Number.isSafeInteger(computedTotalBytes + file.size)) {
      computedTotalBytes += file.size;
    } else {
      errors.push("Pages artifact byte total exceeds safe integer precision.");
    }
    if (!SHA256_PATTERN.test(file.sha256 ?? "")) {
      errors.push("Pages artifact file hash is invalid.");
    }
    if (file.path === REQUIRED_WORKER_PATH) {
      workerPresent = true;
      if (file.size < 1) {
        errors.push("Pages _worker.js must not be empty.");
      }
    }
  }
  if (!workerPresent) {
    errors.push("Pages artifact is missing _worker.js.");
  }
  if (
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 1 ||
    manifest.totalBytes > limits.maxTotalBytes ||
    manifest.totalBytes !== computedTotalBytes
  ) {
    errors.push("Pages artifact total byte count is invalid.");
  }
  if (!SHA256_PATTERN.test(manifest.aggregateSha256 ?? "")) {
    errors.push("Pages artifact aggregate hash is invalid.");
  } else if (
    manifest.files.every(
      (file) =>
        exactKeys(file, ["path", "size", "sha256"]) &&
        typeof file.path === "string" &&
        Number.isSafeInteger(file.size) &&
        SHA256_PATTERN.test(file.sha256 ?? ""),
    ) &&
    computePagesArtifactAggregate(manifest.files) !== manifest.aggregateSha256
  ) {
    errors.push("Pages artifact aggregate hash does not match its file records.");
  }
  if (
    COMMIT_PATTERN.test(manifest.sourceCommit ?? "") &&
    SHA256_PATTERN.test(manifest.aggregateSha256 ?? "") &&
    manifest.deploymentMessage !==
      pagesReleaseMessage(manifest.sourceCommit, manifest.aggregateSha256)
  ) {
    errors.push("Pages deployment message does not bind the reviewed artifact.");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidPagesArtifactManifest(manifest, options) {
  const validation = validatePagesArtifactManifest(manifest, options);
  if (!validation.valid) {
    throw new Error(`Invalid Pages artifact manifest: ${validation.errors.join(" ")}`);
  }
  return manifest;
}

function defaultRunGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
}

function checkedGit(runGit, args, projectRoot, label) {
  const result = runGit(args, projectRoot);
  if (
    !result ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    result.error
  ) {
    throw new Error(`${label} could not be verified.`);
  }
  return result.stdout;
}

export function assertReviewedCleanHead({
  projectRoot,
  sourceCommit,
  runGit = defaultRunGit,
}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) {
    throw new Error("Project root must be an absolute path.");
  }
  if (typeof runGit !== "function") {
    throw new TypeError("runGit must be a function.");
  }
  const root = resolve(projectRoot);
  const topLevel = checkedGit(
    runGit,
    ["rev-parse", "--show-toplevel"],
    root,
    "Git repository root",
  ).trim();
  if (!isSamePath(topLevel, root)) {
    throw new Error("Project root does not match the Git worktree root.");
  }
  const head = checkedGit(
    runGit,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    root,
    "Git HEAD",
  ).trim();
  assertLowercaseCommit(head, "Git HEAD");
  assertLowercaseCommit(sourceCommit);
  if (head !== sourceCommit) {
    throw new Error("Source commit does not exactly match the current Git HEAD.");
  }
  const status = checkedGit(
    runGit,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
    "Git worktree state",
  );
  if (status.length !== 0) {
    throw new Error("Pages artifacts may only be prepared from a clean Git worktree.");
  }
  return head;
}

async function assertDirectoryWithoutLinks(path, label) {
  const stats = await lstat(path, { bigint: true }).catch(() => null);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a link or reparse point.`);
  }
  return stats;
}

async function resolveArtifactContext(projectRoot, distRoot) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) {
    throw new Error("Project root must be an absolute path.");
  }
  const root = resolve(projectRoot);
  const expectedDistRoot = resolve(root, ...PAGES_ARTIFACT_ROOT.split("/"));
  const selectedDistRoot = resolve(distRoot ?? expectedDistRoot);
  if (!isSamePath(expectedDistRoot, selectedDistRoot)) {
    throw new Error("Pages artifact root must be the exact dist/cloudflare-pages directory.");
  }
  await assertDirectoryWithoutLinks(root, "Project root");
  let cursor = root;
  for (const segment of PAGES_ARTIFACT_ROOT.split("/")) {
    cursor = join(cursor, segment);
    await assertDirectoryWithoutLinks(cursor, "Pages artifact path");
  }
  const [realProjectRoot, realDistRoot] = await Promise.all([
    realpath(root),
    realpath(selectedDistRoot),
  ]);
  if (!isPathInside(realProjectRoot, realDistRoot)) {
    throw new Error("Pages artifact directory resolves outside the project root.");
  }
  return { projectRoot: root, distRoot: selectedDistRoot };
}

function statsIdentity(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");
}

async function scanArtifactTree(distRoot, limits) {
  const files = [];
  const directories = [];
  const collisionKeys = new Set();
  let directoryCount = 1;
  let totalBytes = 0;

  async function walk(directory, depth) {
    if (depth > limits.maxDepth) {
      throw new Error("Pages artifact directory depth exceeds the release limit.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => canonicalPathCompare(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (!isPathInside(distRoot, absolutePath)) {
        throw new Error("Pages artifact entry resolves outside its root.");
      }
      const relativePath = relative(distRoot, absolutePath).split(sep).join("/");
      assertSafeArtifactRelativePath(relativePath, limits);
      const collisionKey = canonicalCollisionKey(relativePath);
      if (collisionKeys.has(collisionKey)) {
        throw new Error("Pages artifact paths collide case-insensitively.");
      }
      collisionKeys.add(collisionKey);
      const stats = await lstat(absolutePath, { bigint: true });
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error("Pages artifact must not contain links or reparse points.");
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > limits.maxDirectories) {
          throw new Error("Pages artifact directory count exceeds the release limit.");
        }
        directories.push({
          absolutePath,
          path: relativePath,
          identity: statsIdentity(stats),
        });
        await walk(absolutePath, depth + 1);
      } else if (entry.isFile() && stats.isFile()) {
        if (stats.nlink !== 1n) {
          throw new Error("Pages artifact must not contain linked regular files.");
        }
        if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Pages artifact contains a file that is too large.");
        }
        const size = Number(stats.size);
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          throw new Error("Pages artifact byte size exceeds the release limit.");
        }
        files.push({
          absolutePath,
          path: relativePath,
          size,
          identity: statsIdentity(stats),
        });
        if (files.length > limits.maxFiles) {
          throw new Error("Pages artifact file count exceeds the release limit.");
        }
      } else {
        throw new Error("Pages artifact contains a non-regular filesystem entry.");
      }
    }
  }

  await walk(distRoot, 0);
  directories.sort((left, right) => canonicalPathCompare(left.path, right.path));
  files.sort((left, right) => canonicalPathCompare(left.path, right.path));
  if (files.length === 0) {
    throw new Error("Pages artifact directory is empty.");
  }
  const worker = files.find((file) => file.path === REQUIRED_WORKER_PATH);
  if (!worker) {
    throw new Error("Pages artifact is missing _worker.js.");
  }
  if (worker.size === 0) {
    throw new Error("Pages _worker.js must not be empty.");
  }
  return { directories, files, totalBytes };
}

async function sha256RegularFile(file) {
  const before = await lstat(file.absolutePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    statsIdentity(before) !== file.identity
  ) {
    throw new Error("Pages artifact changed while its manifest was being prepared.");
  }
  const handle = await open(
    file.absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      statsIdentity(opened) !== file.identity
    ) {
      throw new Error("Pages artifact changed while its manifest was being prepared.");
    }
    const stream = createReadStream(file.absolutePath, {
      fd: handle.fd,
      autoClose: false,
    });
    for await (const chunk of stream) {
      byteCount += chunk.byteLength;
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (statsIdentity(after) !== file.identity || byteCount !== file.size) {
      throw new Error("Pages artifact changed while its manifest was being prepared.");
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(file.absolutePath, { bigint: true }).catch(() => null);
  if (
    !afterPath ||
    !afterPath.isFile() ||
    afterPath.isSymbolicLink() ||
    statsIdentity(afterPath) !== file.identity
  ) {
    throw new Error("Pages artifact changed while its manifest was being prepared.");
  }
  return hash.digest("hex");
}

function assertEquivalentScans(before, after) {
  if (
    before.totalBytes !== after.totalBytes ||
    before.directories.length !== after.directories.length ||
    before.files.length !== after.files.length
  ) {
    throw new Error("Pages artifact changed while its manifest was being prepared.");
  }
  for (let index = 0; index < before.directories.length; index += 1) {
    const left = before.directories[index];
    const right = after.directories[index];
    if (left.path !== right.path || left.identity !== right.identity) {
      throw new Error("Pages artifact changed while its manifest was being prepared.");
    }
  }
  for (let index = 0; index < before.files.length; index += 1) {
    const left = before.files[index];
    const right = after.files[index];
    if (
      left.path !== right.path ||
      left.size !== right.size ||
      left.identity !== right.identity
    ) {
      throw new Error("Pages artifact changed while its manifest was being prepared.");
    }
  }
}

export async function createPagesArtifactManifest({
  projectRoot,
  distRoot,
  sourceCommit,
  generatedAt = new Date().toISOString(),
  limits: limitOverrides,
  runGit = defaultRunGit,
}) {
  const limits = resolveLimits(limitOverrides);
  assertIsoTimestamp(generatedAt);
  assertReviewedCleanHead({ projectRoot, sourceCommit, runGit });
  const context = await resolveArtifactContext(projectRoot, distRoot);
  const initial = await scanArtifactTree(context.distRoot, limits);
  assertExactDirectoryInventory(
    initial,
    initial.files,
    "Pages artifact contains a directory not represented by its file inventory.",
  );
  const files = [];
  for (const file of initial.files) {
    files.push({
      path: file.path,
      size: file.size,
      sha256: await sha256RegularFile(file),
    });
  }
  const finalScan = await scanArtifactTree(context.distRoot, limits);
  assertEquivalentScans(initial, finalScan);
  const aggregateSha256 = computePagesArtifactAggregate(files);
  const manifest = {
    schemaVersion: PAGES_ARTIFACT_SCHEMA_VERSION,
    artifactRoot: PAGES_ARTIFACT_ROOT,
    sourceCommit,
    generatedAt,
    fileCount: files.length,
    totalBytes: initial.totalBytes,
    aggregateSha256,
    deploymentMessage: pagesReleaseMessage(sourceCommit, aggregateSha256),
    files,
  };
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit: sourceCommit,
    limits,
  });
  return manifest;
}

export async function verifyPagesArtifactManifest(
  manifest,
  {
    projectRoot,
    distRoot,
    expectedSourceCommit = manifest?.sourceCommit,
    limits,
    runGit = defaultRunGit,
  },
) {
  assertLowercaseCommit(expectedSourceCommit, "Expected source commit");
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit,
    limits,
  });
  const recomputed = await createPagesArtifactManifest({
    projectRoot,
    distRoot,
    sourceCommit: expectedSourceCommit,
    generatedAt: manifest.generatedAt,
    limits,
    runGit,
  });
  const validation = validatePagesArtifactManifest(recomputed, {
    expectedSourceCommit,
    limits,
  });
  if (!validation.valid || recomputed.aggregateSha256 !== manifest.aggregateSha256) {
    throw new Error("Pages artifact does not match its reviewed manifest.");
  }
  if (JSON.stringify(recomputed.files) !== JSON.stringify(manifest.files)) {
    throw new Error("Pages artifact file inventory does not match its reviewed manifest.");
  }
  return recomputed;
}

function expectedArtifactDirectories(files) {
  const paths = new Set();
  for (const file of files) {
    let parent = posix.dirname(file.path);
    while (parent !== ".") {
      paths.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return [...paths].sort(canonicalPathCompare);
}

function assertExactDirectoryInventory(scan, files, message) {
  const expected = expectedArtifactDirectories(files);
  if (
    scan.directories.length !== expected.length ||
    scan.directories.some((directory, index) => directory.path !== expected[index])
  ) {
    throw new Error(message);
  }
}

function sameFilesystemObject(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

async function captureDirectoryContext(directory, label) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const root = resolve(directory);
  const stats = await assertDirectoryWithoutLinks(root, label);
  const realRoot = await realpath(root);
  const after = await assertDirectoryWithoutLinks(root, label);
  if (!sameFilesystemObject(stats, after)) {
    throw new Error(`${label} changed while it was being verified.`);
  }
  return { root, realRoot, stats };
}

async function assertDirectoryContextStable(context, label) {
  const stats = await assertDirectoryWithoutLinks(context.root, label);
  const realRoot = await realpath(context.root);
  if (
    !sameFilesystemObject(context.stats, stats) ||
    !isSamePath(context.realRoot, realRoot)
  ) {
    throw new Error(`${label} changed while it was being verified.`);
  }
}

export async function verifyPagesArtifactDirectory(
  manifest,
  {
    directory,
    expectedSourceCommit = manifest?.sourceCommit,
    limits: limitOverrides,
  } = {},
) {
  const limits = resolveLimits(limitOverrides);
  assertLowercaseCommit(expectedSourceCommit, "Expected source commit");
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit,
    limits,
  });
  const context = await captureDirectoryContext(
    directory,
    "Pages artifact directory",
  );
  const initial = await scanArtifactTree(context.root, limits);
  assertExactDirectoryInventory(
    initial,
    manifest.files,
    "Pages artifact directory inventory does not match its reviewed manifest.",
  );
  if (
    initial.files.length !== manifest.files.length ||
    initial.totalBytes !== manifest.totalBytes
  ) {
    throw new Error(
      "Pages artifact file inventory does not match its reviewed manifest.",
    );
  }

  const verifiedFiles = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = initial.files[index];
    if (actual.path !== expected.path || actual.size !== expected.size) {
      throw new Error(
        "Pages artifact file inventory does not match its reviewed manifest.",
      );
    }
    const sha256 = await sha256RegularFile(actual);
    if (sha256 !== expected.sha256) {
      throw new Error("Pages artifact does not match its reviewed manifest.");
    }
    verifiedFiles.push({ path: actual.path, size: actual.size, sha256 });
  }

  const finalScan = await scanArtifactTree(context.root, limits);
  assertEquivalentScans(initial, finalScan);
  assertExactDirectoryInventory(
    finalScan,
    manifest.files,
    "Pages artifact directory inventory does not match its reviewed manifest.",
  );
  await assertDirectoryContextStable(context, "Pages artifact directory");
  const aggregateSha256 = computePagesArtifactAggregate(verifiedFiles);
  if (aggregateSha256 !== manifest.aggregateSha256) {
    throw new Error("Pages artifact does not match its reviewed manifest.");
  }
  return {
    directory: context.root,
    fileCount: verifiedFiles.length,
    totalBytes: initial.totalBytes,
    aggregateSha256,
  };
}

function assertReleaseTempPrefix(prefix) {
  if (typeof prefix !== "string" || !RELEASE_TEMP_PREFIXES.has(prefix)) {
    throw new Error("External release temporary directory prefix is not approved.");
  }
  return prefix;
}

async function resolveExternalTempContext({ externalRoot, projectRoot }) {
  if (
    typeof externalRoot !== "string" ||
    typeof projectRoot !== "string" ||
    !isAbsolute(externalRoot) ||
    !isAbsolute(projectRoot)
  ) {
    throw new Error("External release root and project root must be absolute paths.");
  }
  const release = await captureDirectoryContext(
    resolve(externalRoot),
    "External release root",
  );
  const repository = await captureDirectoryContext(
    resolve(projectRoot),
    "Project root",
  );
  if (
    !isDDrivePath(release.root) ||
    isSamePath(repository.root, release.root) ||
    isPathInside(repository.root, release.root) ||
    isPathInside(release.root, repository.root) ||
    isSamePath(repository.realRoot, release.realRoot) ||
    isPathInside(repository.realRoot, release.realRoot) ||
    isPathInside(release.realRoot, repository.realRoot)
  ) {
    throw new Error(
      "External release root must be a separate repository-external D-drive directory.",
    );
  }
  return { release, repository };
}

function assertGeneratedReleaseTempPath(path, releaseRoot, prefix) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("External release temporary directory path must be absolute.");
  }
  const target = resolve(path);
  const name = basename(target);
  const suffix = name.slice(prefix.length);
  if (
    !isSamePath(dirname(target), releaseRoot) ||
    !name.startsWith(prefix) ||
    !RELEASE_TEMP_SUFFIX_PATTERN.test(suffix)
  ) {
    throw new Error(
      "External release temporary directory is not an exact generated child of its root.",
    );
  }
  return target;
}

export async function createExternalReleaseTempDirectory({
  externalRoot,
  projectRoot,
  prefix,
}) {
  assertReleaseTempPrefix(prefix);
  const context = await resolveExternalTempContext({ externalRoot, projectRoot });
  const directory = await mkdtemp(join(context.release.root, prefix));
  let keep = false;
  try {
    const target = assertGeneratedReleaseTempPath(
      directory,
      context.release.root,
      prefix,
    );
    const targetStats = await assertDirectoryWithoutLinks(
      target,
      "External release temporary directory",
    );
    const targetRealPath = await realpath(target);
    if (
      !isPathInside(context.release.realRoot, targetRealPath) ||
      !isSamePath(dirname(targetRealPath), context.release.realRoot) ||
      (await readdir(target)).length !== 0
    ) {
      throw new Error(
        "External release temporary directory was not created safely under its root.",
      );
    }
    await assertDirectoryContextStable(context.release, "External release root");
    const finalStats = await assertDirectoryWithoutLinks(
      target,
      "External release temporary directory",
    );
    if (!sameFilesystemObject(targetStats, finalStats)) {
      throw new Error(
        "External release temporary directory changed while it was created.",
      );
    }
    keep = true;
    return target;
  } finally {
    if (!keep) {
      await rmdir(directory).catch(() => undefined);
    }
  }
}

async function chmodOpenedFilesystemObject(path, stats, mode) {
  let handle;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (stats.isDirectory() ? (fsConstants.O_DIRECTORY ?? 0) : 0);
    handle = await open(path, flags);
    const opened = await handle.stat({ bigint: true });
    if (!sameFilesystemObject(stats, opened)) {
      throw new Error("Release temporary filesystem entry changed unexpectedly.");
    }
    await handle.chmod(mode);
  } catch (error) {
    if (process.platform !== "win32" || !stats.isDirectory()) throw error;
    const current = await lstat(path, { bigint: true });
    if (!sameFilesystemObject(stats, current)) {
      throw new Error("Release temporary filesystem entry changed unexpectedly.");
    }
    await chmod(path, mode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const after = await lstat(path, { bigint: true });
  if (!sameFilesystemObject(stats, after)) {
    throw new Error("Release temporary filesystem entry changed unexpectedly.");
  }
}

async function removeTreeWithoutFollowingLinks(path, treeRoot, realTreeRoot) {
  const target = resolve(path);
  if (!isSamePath(target, treeRoot) && !isPathInside(treeRoot, target)) {
    throw new Error("Release temporary cleanup attempted to leave its exact root.");
  }
  const stats = await lstat(target, { bigint: true }).catch(() => null);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  if (stats.isFile()) {
    await chmodOpenedFilesystemObject(target, stats, 0o600);
    await unlink(target);
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(
      "Release temporary cleanup found a non-regular filesystem entry.",
    );
  }
  const realTarget = await realpath(target);
  if (
    !isSamePath(realTarget, realTreeRoot) &&
    !isPathInside(realTreeRoot, realTarget)
  ) {
    throw new Error("Release temporary cleanup directory resolves outside its root.");
  }
  await chmodOpenedFilesystemObject(target, stats, 0o700);
  const entries = await readdir(target);
  entries.sort(canonicalPathCompare);
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry === "." ||
      entry === ".." ||
      entry.includes("/") ||
      entry.includes("\\") ||
      CONTROL_CHARACTER_PATTERN.test(entry)
    ) {
      throw new Error("Release temporary cleanup found an unsafe entry name.");
    }
    await removeTreeWithoutFollowingLinks(
      resolve(target, entry),
      treeRoot,
      realTreeRoot,
    );
  }
  const finalStats = await lstat(target, { bigint: true });
  if (!sameFilesystemObject(stats, finalStats)) {
    throw new Error("Release temporary cleanup directory changed unexpectedly.");
  }
  await rmdir(target);
}

export async function removeExternalReleaseTempDirectory(
  path,
  { externalRoot, projectRoot, prefix } = {},
) {
  assertReleaseTempPrefix(prefix);
  const context = await resolveExternalTempContext({ externalRoot, projectRoot });
  const target = assertGeneratedReleaseTempPath(
    path,
    context.release.root,
    prefix,
  );
  const stats = await lstat(target, { bigint: true }).catch(() => null);
  if (!stats) return false;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      "External release temporary directory must remain a real directory.",
    );
  }
  const realTarget = await realpath(target);
  if (
    !isPathInside(context.release.realRoot, realTarget) ||
    !isSamePath(dirname(realTarget), context.release.realRoot)
  ) {
    throw new Error(
      "External release temporary directory resolves outside its exact root.",
    );
  }
  await assertDirectoryContextStable(context.release, "External release root");
  await removeTreeWithoutFollowingLinks(target, target, realTarget);
  await assertDirectoryContextStable(context.release, "External release root");
  if (await lstat(target).catch(() => null)) {
    throw new Error("External release temporary directory was not fully removed.");
  }
  return true;
}

async function ensureExclusiveSnapshotParent(
  snapshotRoot,
  relativePath,
  directoryIdentities,
) {
  let cursor = snapshotRoot;
  const segments = relativePath.split("/").slice(0, -1);
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!isPathInside(snapshotRoot, cursor)) {
      throw new Error("Pages snapshot parent resolves outside its root.");
    }
    const known = directoryIdentities.get(cursor);
    if (!known) {
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error("Pages snapshot directory was created concurrently.");
        }
        throw error;
      }
      const created = await assertDirectoryWithoutLinks(
        cursor,
        "Pages snapshot directory",
      );
      directoryIdentities.set(cursor, created);
    } else {
      const current = await assertDirectoryWithoutLinks(
        cursor,
        "Pages snapshot directory",
      );
      if (!sameFilesystemObject(known, current)) {
        throw new Error("Pages snapshot directory changed while files were copied.");
      }
    }
  }
  return cursor;
}

async function copyManifestFileExclusive({
  sourceRoot,
  realSourceRoot,
  snapshotRoot,
  realSnapshotRoot,
  file,
  directoryIdentities,
}) {
  assertSafeArtifactRelativePath(file.path);
  const segments = file.path.split("/");
  const sourcePath = resolve(sourceRoot, ...segments);
  const expectedRealSource = resolve(realSourceRoot, ...segments);
  const destinationParent = await ensureExclusiveSnapshotParent(
    snapshotRoot,
    file.path,
    directoryIdentities,
  );
  const destinationPath = resolve(destinationParent, segments.at(-1));
  if (
    !isPathInside(sourceRoot, sourcePath) ||
    !isPathInside(snapshotRoot, destinationPath)
  ) {
    throw new Error("Pages snapshot file path resolves outside an approved root.");
  }
  const sourceStats = await lstat(sourcePath, { bigint: true }).catch(() => null);
  if (
    !sourceStats ||
    !sourceStats.isFile() ||
    sourceStats.isSymbolicLink() ||
    sourceStats.nlink !== 1n ||
    sourceStats.size !== BigInt(file.size) ||
    !isSamePath(await realpath(sourcePath), expectedRealSource)
  ) {
    throw new Error("Pages snapshot source is not the reviewed regular file.");
  }

  let sourceHandle;
  let destinationHandle;
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    sourceHandle = await open(
      sourcePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedSource = await sourceHandle.stat({ bigint: true });
    if (
      openedSource.nlink !== 1n ||
      !sameFilesystemObject(sourceStats, openedSource)
    ) {
      throw new Error("Pages snapshot source changed before it was copied.");
    }
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > file.size) {
        throw new Error("Pages snapshot source exceeded its reviewed size.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          chunk,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten < 1) {
          throw new Error("Pages snapshot destination stopped accepting bytes.");
        }
        written += result.bytesWritten;
      }
    }
    if (byteCount !== file.size || hash.digest("hex") !== file.sha256) {
      throw new Error("Pages snapshot source bytes do not match the manifest.");
    }
    const finalSource = await sourceHandle.stat({ bigint: true });
    if (
      finalSource.nlink !== 1n ||
      !sameFilesystemObject(sourceStats, finalSource)
    ) {
      throw new Error("Pages snapshot source changed while it was copied.");
    }
    await destinationHandle.sync();
    const openedDestination = await destinationHandle.stat({ bigint: true });
    if (
      !openedDestination.isFile() ||
      openedDestination.nlink !== 1n ||
      openedDestination.size !== BigInt(file.size)
    ) {
      throw new Error("Pages snapshot destination size is invalid.");
    }
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }

  const [finalSourcePath, finalDestinationPath] = await Promise.all([
    lstat(sourcePath, { bigint: true }).catch(() => null),
    lstat(destinationPath, { bigint: true }).catch(() => null),
  ]);
  if (
    !finalSourcePath ||
    finalSourcePath.nlink !== 1n ||
    !sameFilesystemObject(sourceStats, finalSourcePath) ||
    !finalDestinationPath?.isFile() ||
    finalDestinationPath.isSymbolicLink() ||
    finalDestinationPath.nlink !== 1n ||
    finalDestinationPath.size !== BigInt(file.size) ||
    !isSamePath(await realpath(sourcePath), expectedRealSource) ||
    !isSamePath(
      await realpath(destinationPath),
      resolve(realSnapshotRoot, ...segments),
    )
  ) {
    throw new Error("Pages snapshot file changed while it was copied.");
  }
}

async function makeSnapshotTreeReadOnly(directory) {
  const stats = await lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Pages snapshot contains a link or reparse point.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => canonicalPathCompare(left.name, right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const entryStats = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink() || entryStats.isSymbolicLink()) {
      throw new Error("Pages snapshot contains a link or reparse point.");
    }
    if (entry.isDirectory() && entryStats.isDirectory()) {
      await makeSnapshotTreeReadOnly(path);
    } else if (entry.isFile() && entryStats.isFile()) {
      await chmodOpenedFilesystemObject(path, entryStats, 0o400);
    } else {
      throw new Error("Pages snapshot contains a non-regular filesystem entry.");
    }
  }
  if (process.platform !== "win32") {
    await chmodOpenedFilesystemObject(directory, stats, 0o500);
  }
}

export async function createVerifiedPagesArtifactSnapshot(
  manifest,
  {
    projectRoot,
    externalRoot,
    sourceCommit = manifest?.sourceCommit,
    runGit = defaultRunGit,
    limits,
  } = {},
) {
  assertLowercaseCommit(sourceCommit, "Source commit");
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit: sourceCommit,
    limits,
  });
  assertReviewedCleanHead({ projectRoot, sourceCommit, runGit });
  const source = await resolveArtifactContext(projectRoot);
  await verifyPagesArtifactDirectory(manifest, {
    directory: source.distRoot,
    expectedSourceCommit: sourceCommit,
    limits,
  });
  const snapshot = await createExternalReleaseTempDirectory({
    externalRoot,
    projectRoot,
    prefix: PAGES_STAGE_DIRECTORY_PREFIX,
  });
  try {
    const realSourceRoot = await realpath(source.distRoot);
    const realSnapshotRoot = await realpath(snapshot);
    const directoryIdentities = new Map();
    for (const file of manifest.files) {
      await copyManifestFileExclusive({
        sourceRoot: source.distRoot,
        realSourceRoot,
        snapshotRoot: snapshot,
        realSnapshotRoot,
        file,
        directoryIdentities,
      });
    }
    await verifyPagesArtifactDirectory(manifest, {
      directory: source.distRoot,
      expectedSourceCommit: sourceCommit,
      limits,
    });
    assertReviewedCleanHead({ projectRoot, sourceCommit, runGit });
    await verifyPagesArtifactDirectory(manifest, {
      directory: snapshot,
      expectedSourceCommit: sourceCommit,
      limits,
    });
    await makeSnapshotTreeReadOnly(snapshot);
    await verifyPagesArtifactDirectory(manifest, {
      directory: snapshot,
      expectedSourceCommit: sourceCommit,
      limits,
    });
    return snapshot;
  } catch (error) {
    try {
      await removeExternalReleaseTempDirectory(snapshot, {
        externalRoot,
        projectRoot,
        prefix: PAGES_STAGE_DIRECTORY_PREFIX,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Pages snapshot creation and constrained cleanup both failed.",
      );
    }
    throw error;
  }
}

export async function readPagesArtifactManifestFile(
  manifestPath,
  { maxBytes = DEFAULT_PAGES_ARTIFACT_LIMITS.maxManifestBytes } = {},
) {
  assertPositiveSafeInteger(maxBytes, "maxBytes");
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new Error("Pages artifact manifest path must be absolute.");
  }
  const stats = await lstat(manifestPath, { bigint: true }).catch(() => null);
  if (
    !stats ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > BigInt(maxBytes)
  ) {
    throw new Error("Pages artifact manifest must be a bounded regular file.");
  }
  const handle = await open(
    manifestPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const chunks = [];
  let byteCount = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.size > BigInt(maxBytes) ||
      statsIdentity(opened) !== statsIdentity(stats)
    ) {
      throw new Error("Pages artifact manifest changed before it was read.");
    }
    const stream = createReadStream(manifestPath, {
      fd: handle.fd,
      autoClose: false,
    });
    for await (const chunk of stream) {
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) {
        stream.destroy();
        throw new Error("Pages artifact manifest exceeds the release size limit.");
      }
      chunks.push(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      statsIdentity(after) !== statsIdentity(stats) ||
      byteCount !== Number(stats.size)
    ) {
      throw new Error("Pages artifact manifest changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(manifestPath, { bigint: true }).catch(() => null);
  if (
    !afterPath ||
    !afterPath.isFile() ||
    afterPath.isSymbolicLink() ||
    statsIdentity(afterPath) !== statsIdentity(stats)
  ) {
    throw new Error("Pages artifact manifest path changed while it was read.");
  }
  const bytes = Buffer.concat(chunks, byteCount);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export function readPagesArtifactManifestFileSync(
  manifestPath,
  { maxBytes = DEFAULT_PAGES_ARTIFACT_LIMITS.maxManifestBytes } = {},
) {
  assertPositiveSafeInteger(maxBytes, "maxBytes");
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new Error("Pages artifact manifest path must be absolute.");
  }
  let stats;
  try {
    stats = lstatSync(manifestPath, { bigint: true });
  } catch {
    throw new Error("Pages artifact manifest must be a bounded regular file.");
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > BigInt(maxBytes)
  ) {
    throw new Error("Pages artifact manifest must be a bounded regular file.");
  }
  const descriptor = openSync(
    manifestPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const chunks = [];
  let byteCount = 0;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.size > BigInt(maxBytes) ||
      statsIdentity(opened) !== statsIdentity(stats)
    ) {
      throw new Error("Pages artifact manifest changed before it was read.");
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > maxBytes) {
        throw new Error("Pages artifact manifest exceeds the release size limit.");
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      statsIdentity(after) !== statsIdentity(stats) ||
      byteCount !== Number(stats.size)
    ) {
      throw new Error("Pages artifact manifest changed while it was read.");
    }
  } finally {
    closeSync(descriptor);
  }
  let afterPath;
  try {
    afterPath = lstatSync(manifestPath, { bigint: true });
  } catch {
    throw new Error("Pages artifact manifest path changed while it was read.");
  }
  if (
    !afterPath.isFile() ||
    afterPath.isSymbolicLink() ||
    statsIdentity(afterPath) !== statsIdentity(stats)
  ) {
    throw new Error("Pages artifact manifest path changed while it was read.");
  }
  const bytes = Buffer.concat(chunks, byteCount);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function isDDrivePath(value) {
  if (process.platform !== "win32") return true;
  return parse(resolve(value)).root.toLowerCase() === "d:\\";
}

export async function assertExternalPagesReleasePath({
  manifestPath,
  externalRoot,
  projectRoot,
  mustExist = false,
  mustBeNew = false,
}) {
  if (
    typeof manifestPath !== "string" ||
    typeof externalRoot !== "string" ||
    typeof projectRoot !== "string" ||
    !isAbsolute(manifestPath) ||
    !isAbsolute(externalRoot) ||
    !isAbsolute(projectRoot)
  ) {
    throw new Error("External manifest paths must be absolute.");
  }
  if (mustExist && mustBeNew) {
    throw new Error("External release path cannot be both existing and new.");
  }
  const destination = resolve(manifestPath);
  const releaseRoot = resolve(externalRoot);
  const repositoryRoot = resolve(projectRoot);
  if (
    !isDDrivePath(destination) ||
    !isDDrivePath(releaseRoot) ||
    !isPathInside(releaseRoot, destination) ||
    isSamePath(repositoryRoot, destination) ||
    isPathInside(repositoryRoot, destination) ||
    isSamePath(repositoryRoot, releaseRoot) ||
    isPathInside(repositoryRoot, releaseRoot) ||
    !destination.toLowerCase().endsWith(".json")
  ) {
    throw new Error(
      "Pages artifact manifest must be a new JSON file under an external D-drive release root.",
    );
  }
  await assertDirectoryWithoutLinks(releaseRoot, "External release root");
  const parent = dirname(destination);
  if (!isSamePath(parent, releaseRoot)) {
    let cursor = releaseRoot;
    const segments = relative(releaseRoot, parent).split(sep);
    for (const segment of segments) {
      cursor = join(cursor, segment);
      await assertDirectoryWithoutLinks(cursor, "External manifest directory");
    }
  }
  const [realReleaseRoot, realParent] = await Promise.all([
    realpath(releaseRoot),
    realpath(parent),
  ]);
  if (!isSamePath(realReleaseRoot, realParent) && !isPathInside(realReleaseRoot, realParent)) {
    throw new Error("External manifest directory resolves outside its release root.");
  }
  const destinationStats = await lstat(destination, { bigint: true }).catch(
    () => null,
  );
  if (
    mustExist &&
    (!destinationStats ||
      !destinationStats.isFile() ||
      destinationStats.isSymbolicLink())
  ) {
    throw new Error("External Pages release file must be an existing regular file.");
  }
  if (mustBeNew && destinationStats) {
    throw new Error("External Pages release file must be new.");
  }
  return destination;
}

export async function writePagesArtifactManifestExclusive(
  manifestPath,
  manifest,
  { externalRoot, projectRoot, limits } = {},
) {
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit: manifest?.sourceCommit,
    limits,
  });
  const destination = await assertExternalPagesReleasePath({
    manifestPath,
    externalRoot,
    projectRoot,
    mustBeNew: true,
  });
  const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const maxManifestBytes = resolveLimits(limits).maxManifestBytes;
  if (payload.byteLength > maxManifestBytes) {
    throw new Error("Pages artifact manifest exceeds the release size limit.");
  }
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.pending`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, destination);
    const recorded = await readFile(destination);
    if (!recorded.equals(payload)) {
      throw new Error("Recorded Pages artifact manifest failed byte verification.");
    }
    return destination;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}
