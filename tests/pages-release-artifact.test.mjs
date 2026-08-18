import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertReviewedCleanHead,
  computePagesArtifactAggregate,
  createExternalReleaseTempDirectory,
  createPagesArtifactManifest,
  createVerifiedPagesArtifactSnapshot,
  PAGES_STAGE_DIRECTORY_PREFIX,
  PAGES_WRANGLER_DIRECTORY_PREFIX,
  pagesReleaseMessage,
  readPagesArtifactManifestFile,
  readPagesArtifactManifestFileSync,
  removeExternalReleaseTempDirectory,
  validatePagesArtifactManifest,
  verifyPagesArtifactDirectory,
  verifyPagesArtifactManifest,
  writePagesArtifactManifestExclusive,
} from "../lib/pages-release-artifact.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const GENERATED_AT = "2026-08-18T10:00:00.000Z";

function temporaryBase() {
  return process.platform === "win32" ? "D:\\CodexTemp" : tmpdir();
}

function fakeGit(projectRoot, sourceCommit = SOURCE_COMMIT, status = "") {
  return (args, cwd) => {
    assert.equal(resolve(cwd), resolve(projectRoot));
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") {
      return { status: 0, stdout: `${projectRoot}\n`, stderr: "" };
    }
    if (command === "rev-parse --verify HEAD^{commit}") {
      return { status: 0, stdout: `${sourceCommit}\n`, stderr: "" };
    }
    if (command === "status --porcelain=v1 --untracked-files=all") {
      return { status: 0, stdout: status, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected Git command" };
  };
}

async function createFixture(t) {
  await mkdir(temporaryBase(), { recursive: true });
  const container = await mkdtemp(join(temporaryBase(), "torudake-pages-artifact-"));
  t.after(async () => {
    await rm(container, { recursive: true, force: true });
  });
  const projectRoot = join(container, "project");
  const distRoot = join(projectRoot, "dist", "cloudflare-pages");
  const externalRoot = join(container, "release-manifests");
  await mkdir(join(distRoot, "assets", "nested"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await Promise.all([
    writeFile(join(distRoot, "_worker.js"), "export default { fetch() {} };\n"),
    writeFile(join(distRoot, "index.html"), "<!doctype html><title>Torudake</title>\n"),
    writeFile(join(distRoot, "assets", "z.js"), "console.log('z');\n"),
    writeFile(join(distRoot, "assets", "nested", "a.css"), "body { color: #111; }\n"),
  ]);
  return { container, projectRoot, distRoot, externalRoot };
}

async function buildManifest(fixture, overrides = {}) {
  return createPagesArtifactManifest({
    projectRoot: fixture.projectRoot,
    sourceCommit: SOURCE_COMMIT,
    generatedAt: GENERATED_AT,
    runGit: fakeGit(fixture.projectRoot),
    ...overrides,
  });
}

test("Pages artifact manifest is sorted, deterministic, and deployment-bound", async (t) => {
  const fixture = await createFixture(t);
  const first = await buildManifest(fixture);
  const second = await buildManifest(fixture, {
    generatedAt: "2026-08-18T10:01:00.000Z",
  });

  assert.deepEqual(
    first.files.map((file) => file.path),
    ["_worker.js", "assets/nested/a.css", "assets/z.js", "index.html"],
  );
  assert.equal(first.fileCount, 4);
  assert.equal(first.aggregateSha256, second.aggregateSha256);
  assert.deepEqual(first.files, second.files);
  assert.equal(
    first.aggregateSha256,
    computePagesArtifactAggregate(first.files),
  );
  assert.equal(
    first.deploymentMessage,
    `torudake-pages-v1 commit=${SOURCE_COMMIT} artifactSha256=${first.aggregateSha256}`,
  );
  assert.equal(
    pagesReleaseMessage(SOURCE_COMMIT, first.aggregateSha256),
    first.deploymentMessage,
  );
  assert.deepEqual(validatePagesArtifactManifest(first), {
    valid: true,
    errors: [],
  });
});

test("clean reviewed HEAD must be exact, lowercase, and match the worktree", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(
    assertReviewedCleanHead({
      projectRoot: fixture.projectRoot,
      sourceCommit: SOURCE_COMMIT,
      runGit: fakeGit(fixture.projectRoot),
    }),
    SOURCE_COMMIT,
  );
  assert.throws(
    () =>
      assertReviewedCleanHead({
        projectRoot: fixture.projectRoot,
        sourceCommit: SECOND_COMMIT,
        runGit: fakeGit(fixture.projectRoot),
      }),
    /does not exactly match/,
  );
  assert.throws(
    () =>
      assertReviewedCleanHead({
        projectRoot: fixture.projectRoot,
        sourceCommit: SOURCE_COMMIT.toUpperCase(),
        runGit: fakeGit(fixture.projectRoot),
      }),
    /lowercase 40-character/,
  );
  assert.throws(
    () =>
      assertReviewedCleanHead({
        projectRoot: fixture.projectRoot,
        sourceCommit: SOURCE_COMMIT,
        runGit: fakeGit(fixture.projectRoot, SOURCE_COMMIT, " M app/page.tsx\n"),
      }),
    /clean Git worktree/,
  );
});

test("verification detects replaced, added, and deleted artifact files", async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildManifest(fixture);
  const verificationOptions = {
    projectRoot: fixture.projectRoot,
    expectedSourceCommit: SOURCE_COMMIT,
    runGit: fakeGit(fixture.projectRoot),
  };

  await writeFile(join(fixture.distRoot, "index.html"), "same path, stale bytes\n");
  await assert.rejects(
    verifyPagesArtifactManifest(manifest, verificationOptions),
    /does not match its reviewed manifest/,
  );

  await writeFile(
    join(fixture.distRoot, "index.html"),
    "<!doctype html><title>Torudake</title>\n",
  );
  await writeFile(join(fixture.distRoot, "unexpected.txt"), "unexpected\n");
  await assert.rejects(
    verifyPagesArtifactManifest(manifest, verificationOptions),
    /does not match its reviewed manifest|inventory does not match/,
  );

  await rm(join(fixture.distRoot, "unexpected.txt"));
  await rm(join(fixture.distRoot, "assets", "z.js"));
  await assert.rejects(
    verifyPagesArtifactManifest(manifest, verificationOptions),
    /does not match its reviewed manifest|inventory does not match/,
  );
});

test("manifest validation rejects traversal, case collisions, and tampering", async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildManifest(fixture);

  const traversal = structuredClone(manifest);
  traversal.files[1].path = "../escape.js";
  traversal.aggregateSha256 = computePagesArtifactAggregate(traversal.files);
  traversal.deploymentMessage = pagesReleaseMessage(
    traversal.sourceCommit,
    traversal.aggregateSha256,
  );
  assert.match(
    validatePagesArtifactManifest(traversal).errors.join(" "),
    /unsafe relative path/,
  );

  const collision = structuredClone(manifest);
  collision.files.push({ ...collision.files[0], path: "_WORKER.js" });
  collision.files.sort((left, right) => (left.path < right.path ? -1 : 1));
  collision.fileCount = collision.files.length;
  collision.totalBytes = collision.files.reduce((sum, file) => sum + file.size, 0);
  collision.aggregateSha256 = computePagesArtifactAggregate(collision.files);
  collision.deploymentMessage = pagesReleaseMessage(
    collision.sourceCommit,
    collision.aggregateSha256,
  );
  assert.match(
    validatePagesArtifactManifest(collision).errors.join(" "),
    /collide case-insensitively/,
  );

  const tamperedHash = structuredClone(manifest);
  tamperedHash.files[0].sha256 = "0".repeat(64);
  assert.match(
    validatePagesArtifactManifest(tamperedHash).errors.join(" "),
    /aggregate hash does not match/,
  );

  const tamperedMessage = structuredClone(manifest);
  tamperedMessage.deploymentMessage = "torudake-pages-v1 forged";
  assert.match(
    validatePagesArtifactManifest(tamperedMessage).errors.join(" "),
    /deployment message does not bind/,
  );

  const extraProperty = { ...manifest, token: "must-not-be-recorded" };
  assert.match(
    validatePagesArtifactManifest(extraProperty).errors.join(" "),
    /exact schema/,
  );
});

test("artifact creation rejects links, the wrong dist root, and release limits", async (t) => {
  const fixture = await createFixture(t);
  const outside = join(fixture.container, "outside-assets");
  await mkdir(outside);
  await writeFile(join(outside, "escape.js"), "outside\n");
  try {
    await symlink(
      outside,
      join(fixture.distRoot, "linked-assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic("Link creation is unavailable; link assertion skipped.");
    } else {
      throw error;
    }
  }
  if (existsSync(join(fixture.distRoot, "linked-assets"))) {
    await assert.rejects(buildManifest(fixture), /links or reparse points/);
    await rm(join(fixture.distRoot, "linked-assets"), { force: true });
  }

  await assert.rejects(
    buildManifest(fixture, { distRoot: join(fixture.container, "outside-assets") }),
    /exact dist\/cloudflare-pages/,
  );
  await assert.rejects(
    buildManifest(fixture, { limits: { maxFiles: 2 } }),
    /file count exceeds/,
  );
  await assert.rejects(
    buildManifest(fixture, { limits: { maxTotalBytes: 5 } }),
    /byte size exceeds/,
  );
});

test("external manifest creation is atomic, exclusive, bounded, and outside the repo", async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildManifest(fixture);
  const manifestPath = join(fixture.externalRoot, "pages-artifact.json");

  assert.equal(
    await writePagesArtifactManifestExclusive(manifestPath, manifest, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
    }),
    resolve(manifestPath),
  );
  const recorded = await readPagesArtifactManifestFile(manifestPath);
  assert.deepEqual(recorded, manifest);
  assert.deepEqual(readPagesArtifactManifestFileSync(manifestPath), manifest);
  assert.equal(
    (await readFile(manifestPath, "utf8")).includes("token"),
    false,
  );
  await assert.rejects(
    writePagesArtifactManifestExclusive(manifestPath, manifest, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
    }),
    /EEXIST|already exists|must be new/i,
  );
  assert.equal(
    (await readFile(manifestPath, "utf8")),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const linkedManifestPath = join(fixture.externalRoot, "linked-manifest.json");
  try {
    await symlink(manifestPath, linkedManifestPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic("File-link creation is unavailable; linked manifest assertion skipped.");
    } else {
      throw error;
    }
  }
  if (existsSync(linkedManifestPath)) {
    await assert.rejects(
      readPagesArtifactManifestFile(linkedManifestPath),
      /bounded regular file/,
    );
    await rm(linkedManifestPath, { force: true });
  }

  const insideRepository = join(fixture.projectRoot, "manifest.json");
  await assert.rejects(
    writePagesArtifactManifestExclusive(insideRepository, manifest, {
      externalRoot: fixture.projectRoot,
      projectRoot: fixture.projectRoot,
    }),
    /external D-drive release root/,
  );
  await assert.rejects(
    readPagesArtifactManifestFile(manifestPath, { maxBytes: 10 }),
    /bounded regular file/,
  );
  assert.throws(
    () => readPagesArtifactManifestFileSync(manifestPath, { maxBytes: 10 }),
    /bounded regular file/,
  );
});

test("verified snapshot is an exact read-only external copy and Wrangler cwd is isolated", async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildManifest(fixture);
  let snapshot;
  let wranglerDirectory;
  t.after(async () => {
    if (snapshot) {
      await removeExternalReleaseTempDirectory(snapshot, {
        externalRoot: fixture.externalRoot,
        projectRoot: fixture.projectRoot,
        prefix: PAGES_STAGE_DIRECTORY_PREFIX,
      }).catch(() => undefined);
    }
    if (wranglerDirectory) {
      await removeExternalReleaseTempDirectory(wranglerDirectory, {
        externalRoot: fixture.externalRoot,
        projectRoot: fixture.projectRoot,
        prefix: PAGES_WRANGLER_DIRECTORY_PREFIX,
      }).catch(() => undefined);
    }
  });

  snapshot = await createVerifiedPagesArtifactSnapshot(manifest, {
    projectRoot: fixture.projectRoot,
    externalRoot: fixture.externalRoot,
    sourceCommit: SOURCE_COMMIT,
    runGit: fakeGit(fixture.projectRoot),
  });
  assert.equal(dirname(snapshot), resolve(fixture.externalRoot));
  assert.match(
    basename(snapshot),
    /^\.torudake-pages-stage-[A-Za-z0-9]{6}$/,
  );
  assert.deepEqual(
    await verifyPagesArtifactDirectory(manifest, {
      directory: snapshot,
      expectedSourceCommit: SOURCE_COMMIT,
    }),
    {
      directory: resolve(snapshot),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      aggregateSha256: manifest.aggregateSha256,
    },
  );
  for (const file of manifest.files) {
    assert.deepEqual(
      await readFile(join(snapshot, ...file.path.split("/"))),
      await readFile(join(fixture.distRoot, ...file.path.split("/"))),
    );
  }
  if (process.platform !== "win32") {
    assert.equal(Number((await lstat(snapshot, { bigint: true })).mode) & 0o222, 0);
    assert.equal(
      Number((await lstat(join(snapshot, "index.html"), { bigint: true })).mode) &
        0o222,
      0,
    );
  }

  wranglerDirectory = await createExternalReleaseTempDirectory({
    externalRoot: fixture.externalRoot,
    projectRoot: fixture.projectRoot,
    prefix: PAGES_WRANGLER_DIRECTORY_PREFIX,
  });
  assert.equal(dirname(wranglerDirectory), resolve(fixture.externalRoot));
  assert.match(
    basename(wranglerDirectory),
    /^\.torudake-pages-wrangler-[A-Za-z0-9]{6}$/,
  );
  assert.deepEqual(await readdir(wranglerDirectory), []);

  assert.equal(
    await removeExternalReleaseTempDirectory(snapshot, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_STAGE_DIRECTORY_PREFIX,
    }),
    true,
  );
  assert.equal(existsSync(snapshot), false);
  assert.equal(
    await removeExternalReleaseTempDirectory(snapshot, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_STAGE_DIRECTORY_PREFIX,
    }),
    false,
  );
  snapshot = undefined;
});

test("directory verification and snapshot creation reject stale, added, deleted, and linked sources", async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildManifest(fixture);
  const verify = () =>
    verifyPagesArtifactDirectory(manifest, {
      directory: fixture.distRoot,
      expectedSourceCommit: SOURCE_COMMIT,
    });

  await verify();
  await writeFile(join(fixture.distRoot, "index.html"), "mutated bytes\n");
  await assert.rejects(verify(), /does not match its reviewed manifest/);
  await assert.rejects(
    createVerifiedPagesArtifactSnapshot(manifest, {
      projectRoot: fixture.projectRoot,
      externalRoot: fixture.externalRoot,
      sourceCommit: SOURCE_COMMIT,
      runGit: fakeGit(fixture.projectRoot),
    }),
    /does not match its reviewed manifest/,
  );

  await writeFile(
    join(fixture.distRoot, "index.html"),
    "<!doctype html><title>Torudake</title>\n",
  );
  await mkdir(join(fixture.distRoot, "unexpected-empty-directory"));
  await assert.rejects(verify(), /directory inventory/);
  await rm(join(fixture.distRoot, "unexpected-empty-directory"), {
    recursive: true,
  });

  await rm(join(fixture.distRoot, "assets", "z.js"));
  await assert.rejects(verify(), /file inventory/);
  await writeFile(join(fixture.distRoot, "assets", "z.js"), "console.log('z');\n");

  const outsideFile = join(fixture.container, "outside-file.js");
  const linkedFile = join(fixture.distRoot, "assets", "linked.js");
  await writeFile(outsideFile, "outside\n");
  await link(outsideFile, linkedFile);
  await assert.rejects(verify(), /linked regular files/);
  await rm(linkedFile);
  try {
    await symlink(outsideFile, linkedFile, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic("File-link creation is unavailable; linked source assertion skipped.");
    } else {
      throw error;
    }
  }
  if (existsSync(linkedFile)) {
    await assert.rejects(verify(), /links or reparse points/);
    await rm(linkedFile, { force: true });
  }
  await verify();
});

test("temporary cleanup is constrained to the exact external root and approved prefix", async (t) => {
  const fixture = await createFixture(t);
  let stage = await createExternalReleaseTempDirectory({
    externalRoot: fixture.externalRoot,
    projectRoot: fixture.projectRoot,
    prefix: PAGES_STAGE_DIRECTORY_PREFIX,
  });
  t.after(async () => {
    if (stage) {
      await removeExternalReleaseTempDirectory(stage, {
        externalRoot: fixture.externalRoot,
        projectRoot: fixture.projectRoot,
        prefix: PAGES_STAGE_DIRECTORY_PREFIX,
      }).catch(() => undefined);
    }
  });

  await assert.rejects(
    createExternalReleaseTempDirectory({
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: ".unsafe-",
    }),
    /prefix is not approved/,
  );
  await assert.rejects(
    removeExternalReleaseTempDirectory(stage, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_WRANGLER_DIRECTORY_PREFIX,
    }),
    /exact generated child/,
  );
  await assert.rejects(
    removeExternalReleaseTempDirectory(join(stage, "nested"), {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_STAGE_DIRECTORY_PREFIX,
    }),
    /exact generated child/,
  );
  await assert.rejects(
    createExternalReleaseTempDirectory({
      externalRoot: fixture.container,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_STAGE_DIRECTORY_PREFIX,
    }),
    /separate repository-external D-drive directory/,
  );

  const sentinel = join(fixture.container, "cleanup-sentinel.txt");
  const linkedSentinel = join(stage, "linked-sentinel.txt");
  await writeFile(sentinel, "keep me\n");
  try {
    await symlink(sentinel, linkedSentinel, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic("File-link creation is unavailable; no-follow cleanup assertion skipped.");
    } else {
      throw error;
    }
  }
  await writeFile(join(stage, "owned.txt"), "remove me\n");
  assert.equal(
    await removeExternalReleaseTempDirectory(stage, {
      externalRoot: fixture.externalRoot,
      projectRoot: fixture.projectRoot,
      prefix: PAGES_STAGE_DIRECTORY_PREFIX,
    }),
    true,
  );
  stage = undefined;
  assert.equal(await readFile(sentinel, "utf8"), "keep me\n");
});
