#!/usr/bin/env node
import { Manga, Chapter } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { basename, join } from 'path';

// Extract UUID from URL or use as-is
function extractUuid(input) {
  const match = input.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : input.trim();
}

// Sanitize filename for zip
function sanitize(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 100);
}

// Download a single image with retry
async function downloadImage(url, destPath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const writer = createWriteStream(destPath);
      await pipeline(res.body, writer);
      return true;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// Create zip archive
async function createZip(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  if (!mangaInput) {
    console.error('❌ MANGA_INPUT environment variable not set');
    process.exit(1);
  }

  const mangaId = extractUuid(mangaInput);
  console.log(`🔍 Fetching manga: ${mangaId}`);

  try {
    // Get manga info
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    console.log(`📚 Manga: ${mangaTitle}`);

    // Get first 10 English chapters, sorted by chapter number
    console.log('📖 Fetching chapters...');
    const chapters = await manga.getFeed({
      translatedLanguage: ['en'],
      limit: 100, // fetch more to ensure we get 10 valid ones
      order: { chapter: 'asc' }
    });

    const validChapters = chapters
      .filter(ch => ch.chapter && !ch.externalUrl)
      .slice(0, 10);

    if (validChapters.length === 0) {
      console.error('❌ No English chapters found');
      process.exit(1);
    }
    console.log(`✅ Found ${validChapters.length} chapters to download`);

    // Setup directories
    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, safeTitle);
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });

    // Download each chapter
    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter.chapter || `ch${idx + 1}`;
      const chapTitle = chapter.title ? ` - ${chapter.title}` : '';
      const chapDirName = `Ch.${String(chapNum).padStart(4, '0')}${chapTitle}`.substring(0, 150);
      const chapDir = join(mangaDir, sanitize(chapDirName));
      
      if (!existsSync(chapDir)) mkdirSync(chapDir, { recursive: true });
      console.log(`⬇️  Chapter ${idx + 1}/10: ${chapDirName}`);

      // Resolve chapter to get fresh data
      const fullChapter = await Chapter.get(chapter.id);
      const pages = await fullChapter.getReadablePages();

      // Download pages
      for (const [pageIdx, pageUrl] of pages.entries()) {
        const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
        const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
        const destPath = join(chapDir, filename);
        await downloadImage(pageUrl, destPath);
      }
      
      // Throttle to respect API limits
      await new Promise(r => setTimeout(r, 800));
    }

    // Create zip
    const zipPath = join(workDir, `${safeTitle}.zip`);
    console.log(`🗜️  Creating archive: ${safeTitle}.zip`);
    const size = await createZip(mangaDir, zipPath);
    console.log(`✅ Archive created: ${(size / 1024 / 1024).toFixed(2)} MB`);

    // Output path for GitHub Actions artifact
    console.log(`::set-output name=zip_path::${zipPath}`);
    console.log(`::set-output name=zip_name::${safeTitle}.zip`);
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
