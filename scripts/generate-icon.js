import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const assetsDir = join(rootDir, 'assets');

// Ensure assets directory exists
if (!existsSync(assetsDir)) {
  mkdirSync(assetsDir, { recursive: true });
}

const svgPath = join(assetsDir, 'icon.svg');
const pngPath = join(assetsDir, 'icon.png');
const icoPath = join(assetsDir, 'icon.ico');

async function generateIcons() {
  console.log('Reading SVG...');
  const svgBuffer = readFileSync(svgPath);

  // Generate PNG at 256x256 (required for Windows ICO)
  console.log('Generating PNG...');
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(pngPath);

  // Generate multiple sizes for ICO
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map(size =>
      sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer()
    )
  );

  console.log('Generating ICO...');
  const icoBuffer = await pngToIco(pngBuffers);
  writeFileSync(icoPath, icoBuffer);

  console.log('Icons generated successfully!');
  console.log(`  PNG: ${pngPath}`);
  console.log(`  ICO: ${icoPath}`);
}

generateIcons().catch(console.error);
