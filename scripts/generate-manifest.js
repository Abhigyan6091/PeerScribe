/**
 * BitChat-Standard Cryptographic Source Manifest Generator
 * Walks tracked Git repository files (or workspace files) and generates
 * a verifiable SHA-256 manifest alongside commit and tree hashes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function getGitOutput(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    return 'unknown';
  }
}

function getTrackedFiles() {
  try {
    const output = execSync('git ls-files', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = output.split('\n').map(f => f.trim()).filter(f => f.length > 0);
    if (files.length > 0) return files;
  } catch (err) {
    // Fall back to filesystem scan
  }

  // Filesystem fallback scan
  return scanDirectory(process.cwd());
}

function scanDirectory(dir, baseDir = process.cwd()) {
  const ignoredPatterns = ['node_modules', '.git', '.system_generated', 'dist', 'build-manifest', 'coverage'];
  let results = [];
  const list = fs.readdirSync(dir);

  for (const file of list) {
    if (ignoredPatterns.includes(file)) continue;
    const fullPath = path.join(dir, file);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      results = results.concat(scanDirectory(fullPath, baseDir));
    } else {
      results.push(relPath);
    }
  }

  return results;
}

function computeFileSha256(filePath) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (err) {
    return null;
  }
}

function main() {
  const commitHash = getGitOutput('git rev-parse HEAD');
  const treeHash = getGitOutput('git rev-parse HEAD^{tree}');
  const tag = getGitOutput('git describe --tags --exact-match') || process.env.GITHUB_REF_NAME || 'v1.0.0-dev';
  const branch = getGitOutput('git rev-parse --abbrev-ref HEAD');

  const files = getTrackedFiles();
  const fileManifest = [];

  for (const file of files) {
    const hash = computeFileSha256(file);
    if (hash) {
      fileManifest.push({
        path: file.replace(/\\/g, '/'),
        sha256: hash
      });
    }
  }

  // Sort files lexicographically for deterministic hashing
  fileManifest.sort((a, b) => a.path.localeCompare(b.path));

  const manifestObject = {
    project: 'PeerScribe',
    standard: 'BitChat-Verifiable-Build-v1',
    timestamp: new Date().toISOString(),
    version_tag: tag,
    branch: branch,
    git_commit: commitHash,
    git_tree: treeHash,
    file_count: fileManifest.length,
    tracked_files: fileManifest
  };

  // Compute canonical checksum of the manifest itself
  const canonicalString = JSON.stringify(fileManifest);
  manifestObject.source_tree_sha256 = crypto.createHash('sha256').update(canonicalString).digest('hex');

  console.log(JSON.stringify(manifestObject, null, 2));
}

main();
