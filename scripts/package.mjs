import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const releaseDir = path.join(rootDir, "releases");
const manifestPath = path.join(distDir, "manifest.json");

if (!fs.existsSync(distDir)) {
  throw new Error("dist directory does not exist. Run npm run build first.");
}

if (!fs.existsSync(manifestPath)) {
  throw new Error("dist/manifest.json does not exist.");
}

const manifest = JSON.parse(
  fs.readFileSync(manifestPath, "utf8"),
);

if (manifest.manifest_version !== 3) {
  throw new Error(
    `Expected Manifest V3, received: ${manifest.manifest_version}`,
  );
}

if (!manifest.name || !manifest.version) {
  throw new Error("manifest.json must contain name and version.");
}

fs.mkdirSync(releaseDir, { recursive: true });

const extensionName = manifest.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const outputPath = path.join(
  releaseDir,
  `${extensionName}-${manifest.version}.zip`,
);

if (fs.existsSync(outputPath)) {
  fs.rmSync(outputPath);
}

const output = fs.createWriteStream(outputPath);

const archive = new ZipArchive({
  zlib: {
    level: 9,
  },
});

const archiveFinished = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);

  archive.on("warning", (error) => {
    if (error.code === "ENOENT") {
      console.warn(error.message);
      return;
    }

    reject(error);
  });
});

archive.pipe(output);

archive.glob("**/*", {
  cwd: distDir,
  dot: true,
  ignore: [
    "**/.DS_Store",
    "**/__MACOSX/**",
    "**/*.map",
  ],
});

archive.finalize();
await archiveFinished;

const sizeMb = archive.pointer() / 1024 / 1024;

console.log("");
console.log(`Created: ${path.relative(rootDir, outputPath)}`);
console.log(`Version: ${manifest.version}`);
console.log(`Size: ${sizeMb.toFixed(2)} MB`);
