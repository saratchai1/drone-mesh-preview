#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const input = process.argv[2];
const outputDir = process.argv[3];
const targetPoints = Number(process.argv[4] || 1_000_000);

if (!input || !outputDir) {
  console.error("Usage: node scripts/create-las-preview.js <input.las> <output-dir> [target-points]");
  process.exit(1);
}

function readHeader(file) {
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(375);
  fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);

  const signature = header.toString("ascii", 0, 4);
  if (signature !== "LASF") throw new Error("Not a LAS file");

  const major = header.readUInt8(24);
  const minor = header.readUInt8(25);
  const pointOffset = header.readUInt32LE(96);
  const pointFormatRaw = header.readUInt8(104);
  const pointFormat = pointFormatRaw & 0x3f;
  const recordLength = header.readUInt16LE(105);
  const legacyPointCount = header.readUInt32LE(107);
  const pointCount = minor >= 4 ? Number(header.readBigUInt64LE(247)) || legacyPointCount : legacyPointCount;

  const scale = [header.readDoubleLE(131), header.readDoubleLE(139), header.readDoubleLE(147)];
  const offset = [header.readDoubleLE(155), header.readDoubleLE(163), header.readDoubleLE(171)];
  const bounds = {
    maxX: header.readDoubleLE(179),
    minX: header.readDoubleLE(187),
    maxY: header.readDoubleLE(195),
    minY: header.readDoubleLE(203),
    maxZ: header.readDoubleLE(211),
    minZ: header.readDoubleLE(219),
  };

  return {
    version: `${major}.${minor}`,
    pointOffset,
    pointFormat,
    pointFormatRaw,
    recordLength,
    pointCount,
    scale,
    offset,
    bounds,
  };
}

function colorOffsets(pointFormat) {
  if ([2, 3, 5].includes(pointFormat)) return [20, 22, 24];
  if ([7, 8, 10].includes(pointFormat)) return [30, 32, 34];
  return null;
}

function clampColor(value) {
  return Math.max(0, Math.min(255, value > 255 ? Math.round(value / 256) : value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeChunkedFile(dir, baseName, buffer, chunkSize = 5 * 1024 * 1024) {
  if (buffer.byteLength <= chunkSize) {
    const fileName = `${baseName}.bin`;
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return fileName;
  }

  const files = [];
  for (let offset = 0, index = 0; offset < buffer.byteLength; offset += chunkSize, index += 1) {
    const fileName = `${baseName}-${String(index).padStart(3, "0")}.bin`;
    fs.writeFileSync(path.join(dir, fileName), buffer.subarray(offset, offset + chunkSize));
    files.push(fileName);
  }
  return files;
}

const header = readHeader(input);
const rgbOffsets = colorOffsets(header.pointFormat);
const stride = Math.max(1, Math.ceil(header.pointCount / targetPoints));
const estimatedPoints = Math.ceil(header.pointCount / stride);
const center = [
  (header.bounds.minX + header.bounds.maxX) / 2,
  (header.bounds.minY + header.bounds.maxY) / 2,
  (header.bounds.minZ + header.bounds.maxZ) / 2,
];

ensureDir(outputDir);
const metadataPath = path.join(outputDir, "metadata.json");

const inputFd = fs.openSync(input, "r");

const chunkBytesTarget = 64 * 1024 * 1024;
const chunkRecords = Math.max(1, Math.floor(chunkBytesTarget / header.recordLength));
const positionOut = Buffer.allocUnsafe(estimatedPoints * 12);
const colorOut = Buffer.allocUnsafe(estimatedPoints * 3);
const sampledBounds = {
  minX: Infinity,
  minY: Infinity,
  minZ: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
  maxZ: -Infinity,
};

let written = 0;
let lastProgress = 0;

try {
  for (let chunkStart = 0; chunkStart < header.pointCount && written < estimatedPoints; chunkStart += chunkRecords) {
    const records = Math.min(chunkRecords, header.pointCount - chunkStart);
    const bytes = records * header.recordLength;
    const buffer = Buffer.allocUnsafe(bytes);
    fs.readSync(inputFd, buffer, 0, bytes, header.pointOffset + chunkStart * header.recordLength);

    let pointIndex = Math.ceil(chunkStart / stride) * stride;
    const chunkEnd = chunkStart + records;

    for (; pointIndex < chunkEnd && written < estimatedPoints; pointIndex += stride) {
      const recordOffset = (pointIndex - chunkStart) * header.recordLength;
      const rawX = buffer.readInt32LE(recordOffset);
      const rawY = buffer.readInt32LE(recordOffset + 4);
      const rawZ = buffer.readInt32LE(recordOffset + 8);
      const x = rawX * header.scale[0] + header.offset[0] - center[0];
      const y = rawZ * header.scale[2] + header.offset[2] - center[2];
      const z = -(rawY * header.scale[1] + header.offset[1] - center[1]);

      const positionOffset = written * 12;
      positionOut.writeFloatLE(x, positionOffset);
      positionOut.writeFloatLE(y, positionOffset + 4);
      positionOut.writeFloatLE(z, positionOffset + 8);

      if (rgbOffsets) {
        const [rOffset, gOffset, bOffset] = rgbOffsets;
        colorOut[written * 3] = clampColor(buffer.readUInt16LE(recordOffset + rOffset));
        colorOut[written * 3 + 1] = clampColor(buffer.readUInt16LE(recordOffset + gOffset));
        colorOut[written * 3 + 2] = clampColor(buffer.readUInt16LE(recordOffset + bOffset));
      } else {
        const intensity = buffer.readUInt16LE(recordOffset + 12);
        const value = clampColor(intensity);
        colorOut[written * 3] = value;
        colorOut[written * 3 + 1] = value;
        colorOut[written * 3 + 2] = value;
      }

      sampledBounds.minX = Math.min(sampledBounds.minX, x);
      sampledBounds.minY = Math.min(sampledBounds.minY, y);
      sampledBounds.minZ = Math.min(sampledBounds.minZ, z);
      sampledBounds.maxX = Math.max(sampledBounds.maxX, x);
      sampledBounds.maxY = Math.max(sampledBounds.maxY, y);
      sampledBounds.maxZ = Math.max(sampledBounds.maxZ, z);
      written += 1;
    }

    const progress = Math.floor((chunkStart / header.pointCount) * 100);
    if (progress >= lastProgress + 5) {
      lastProgress = progress;
      console.log(`${progress}% sampled (${written.toLocaleString()} points)`);
    }
  }

} finally {
  fs.closeSync(inputFd);
}

const positionFiles = writeChunkedFile(outputDir, "positions", positionOut.subarray(0, written * 12));
const colorFiles = writeChunkedFile(outputDir, "colors", colorOut.subarray(0, written * 3));

const metadata = {
  source: path.basename(input),
  generatedAt: new Date().toISOString(),
  format: "las-sampled-preview-v1",
  las: header,
  originalPoints: header.pointCount,
  sampledPoints: written,
  sampleStride: stride,
  center,
  sampledBounds,
  files: {
    positions: positionFiles,
    colors: colorFiles,
  },
};

fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
console.log(`Wrote ${written.toLocaleString()} sampled points to ${outputDir}`);
