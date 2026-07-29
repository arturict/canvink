import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stableSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractReleaseNotes(changelog, version) {
  if (!stableSemverPattern.test(version)) {
    throw new Error(`Release version must be exact stable SemVer: ${version}`);
  }

  const escapedVersion = escapeRegExp(version);
  const plainHeading = new RegExp(
    `^##[ \\t]+${escapedVersion}(?:[ \\t]+.*)?$`,
  );
  const linkedHeading = new RegExp(
    `^##[ \\t]+\\[${escapedVersion}\\]\\([^)\\r\\n]+\\)(?:[ \\t]+.*)?$`,
  );
  const lines = changelog.split(/\r?\n/);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (plainHeading.test(lines[index]) || linkedHeading.test(lines[index])) {
      matches.push(index);
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one section for ${version}; found ${matches.length}`,
    );
  }

  const start = matches[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##[ \t]+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const notes = lines.slice(start, end).join("\n").trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md section for ${version} is empty`);
  }
  return `${notes}\n`;
}

function main() {
  const [version, inputPath, outputPath] = process.argv.slice(2);
  if (!version || !inputPath || !outputPath || process.argv.length !== 5) {
    throw new Error(
      "Usage: node scripts/extract-release-notes.mjs VERSION INPUT OUTPUT",
    );
  }

  const changelog = readFileSync(inputPath, "utf8");
  writeFileSync(outputPath, extractReleaseNotes(changelog, version), "utf8");
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";
if (import.meta.url === entryPoint) {
  try {
    main();
  } catch (error) {
    console.error(`Release notes extraction failed: ${error.message}`);
    process.exitCode = 1;
  }
}
