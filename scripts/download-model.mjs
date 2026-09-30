#!/usr/bin/env node
/**
 * Streams a GGUF model into ./models using the built-in fetch.
 *
 * The default target is Qwen3-4B (Q8_0, ~4.28 GB) — 4B weights at 1 byte each.
 * Pass --sha256 <hex> to enforce integrity; without it the download is only
 * reported, never silently trusted.
 *
 *   node scripts/download-model.mjs
 *   node scripts/download-model.mjs --url https://.../model.gguf --sha256 <hex>
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_HOST = '<org>';
const DEFAULT_URL =
  'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q8_0.gguf';
const DEFAULT_SHA256 = 'skip';
const DEFAULT_OUT = 'models/Qwen3-4B-Instruct-Q8_0.gguf';
const EXPECTED_BYTES = 4_280_404_704;

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, sha256: DEFAULT_SHA256, out: DEFAULT_OUT, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i];
    else if (arg === '--sha256') options.sha256 = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/download-model.mjs [options]',
    '',
    '  --url <url>       Source URL of the GGUF file (required in practice)',
    '  --sha256 <hex>    Expected SHA-256; use "skip" to disable verification',
    '  --out <path>      Destination path (default: ' + DEFAULT_OUT + ')',
    '  --force           Re-download even when the file already exists',
    '',
    'Default target: Qwen3-4B Q8_0 (~4.28 GB) from Hugging Face.',
  ].join('\n');
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes} B`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const target = path.resolve(root, options.out);

  if (options.url.includes(PLACEHOLDER_HOST)) {
    console.error('The default URL is a placeholder.');
    console.error('Pass a real --url (and ideally --sha256) before running:\n');
    console.error('  node scripts/download-model.mjs --url <real-url> --sha256 <hex>\n');
    console.error(usage());
    process.exit(2);
  }

  if (!options.force) {
    try {
      const info = await stat(target);
      if (info.size > 0) {
        console.log(`Already present: ${target} (${formatBytes(info.size)}). Use --force to re-download.`);
        return;
      }
    } catch {
      // Not present yet: continue.
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  await rm(partial, { force: true });

  console.log(`Downloading ${options.url}`);
  console.log(`  -> ${target}`);
  console.log(`  expected size ~${formatBytes(EXPECTED_BYTES)}`);

  const response = await fetch(options.url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const totalHeader = Number(response.headers.get('content-length') ?? '0');
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : EXPECTED_BYTES;

  const hash = createHash('sha256');
  let received = 0;
  let lastReported = 0;

  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (received - lastReported > 50 * 1024 * 1024) {
      lastReported = received;
      const pct = total ? ((received / total) * 100).toFixed(1) : '?';
      process.stdout.write(`\r  ${formatBytes(received)} (${pct}%)`);
    }
  });

  await pipeline(source, createWriteStream(partial));
  process.stdout.write(`\r  ${formatBytes(received)} (100.0%)\n`);

  const digest = hash.digest('hex');
  if (options.sha256 && options.sha256 !== 'skip' && options.sha256 !== DEFAULT_SHA256) {
    if (digest !== options.sha256) {
      await rm(partial, { force: true });
      throw new Error(`Checksum mismatch.\n  expected ${options.sha256}\n  actual   ${digest}`);
    }
    console.log('  checksum OK');
  } else {
    console.log(`  checksum (unverified): ${digest}`);
    console.log('  pass --sha256 <hex> to enforce verification');
  }

  await rename(partial, target);
  console.log(`Saved ${target} (${formatBytes(received)})`);
}

main().catch((error) => {
  console.error(`\nDownload failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});