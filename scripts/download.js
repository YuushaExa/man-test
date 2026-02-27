#!/usr/bin/env node
import { Manga, Chapter } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join } from 'path';

// Extract UUID from URL or use as-is
function extractUuid(input) {
  const match = input.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : input.trim();
}

// Sanitize filename for zip
function sanitize(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 100);
}

// Parse chapter number (handles decimals like 2.5)
function parseChapterNum(chapStr) {
  if (!chapStr) return Infinity;
  const num = parseFloat(chapStr);
  return isNaN(num) ? Infinity : num;
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

// 🌟 Smart chapter selection - avoids duplicates, prioritizes English
function selectChapters(allChapters, maxChapters = 10) {
  // Group chapters by chapter number
  const chapterMap = new Map();
  
  for (const ch of allChapters) {
    if (!ch.chapter || ch.externalUrl) continue;
    
    const chapNum = parseChapterNum(ch.chapter);
    if (chapNum === Infinity) continue;
    
    const isEnglish = ch.translatedLanguage === 'en';
    
    if (!chapterMap.has(chapNum)) {
      chapterMap.set(chapNum, { english: null, other: null });
    }
    
    const entry = chapterMap.get(chapNum);
    
    // Priority: English > Other languages
    if (isEnglish) {
      entry.english = ch;
    } else if (!entry.other) {
      entry.other = ch;
    }
  }
  
  // Select chapters: prefer English, fallback to other
  const selected = [];
  const sortedKeys = Array.from(chapterMap.keys()).sort((a, b) => a - b);
  
  for (const chapNum of sortedKeys) {
    if (selected.length >= maxChapters) break;
    
    const entry = chapterMap.get(chapNum);
    const chosen = entry.english || entry.other;
    
    if (chosen) {
      selected.push({
        ...chosen,
        _isEnglish: !!entry.english,
        _chapNum: chapNum
      });
    }
  }
  
  return selected;
}

async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  const useDataSaver = process.env.USE_DATA_SAVER === 'true';
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '1000', 1000);
  
  if (!mangaInput) {
    console.error('❌ MANGA_INPUT environment variable not set');
    process.exit(1);
  }

  const mangaId = extractUuid(mangaInput);
  console.log(`🔍 Fetching manga: ${mangaId}`);
  console.log(`💾 Data Saver Mode: ${useDataSaver ? 'ON' : 'OFF'}`);
  console.log(`📖 Max Chapters: ${maxChapters}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    const zipSuffix = useDataSaver ? ' (data-saver)' : '';
    const zipName = `${safeTitle}${zipSuffix}.zip`;
    
    console.log(`📚 Manga: ${mangaTitle}`);
    console.log(`📦 Output: ${zipName}`);

    // 🌟 Fetch chapters with pagination (more efficient)
    console.log('📖 Scanning chapters (this may take a moment)...');
    const allChapters = [];
    let offset = 0;
    const limit = 100;
    
    while (true) {
      const chapters = await manga.getFeed({
        limit,
        offset,
        translatedLanguage: ['en', 'ru', 'pl', 'id', 'pt-br', 'th', 'vi', 'ko', 'zh', 'zh-ro', 'jp'],
        order: { chapter: 'asc' }
      });
      
      if (chapters.length === 0) break;
      
      allChapters.push(...chapters);
      offset += limit;
      
      // Stop if we have enough chapters to work with
      if (allChapters.length >= 300) {
        console.log(`⏹️  Stopped at ${allChapters.length} chapters (sufficient for selection)`);
        break;
      }
      
      // Throttle to respect API limits
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`📊 Found ${allChapters.length} total chapters`);

    // 🌟 Smart selection - avoid duplicates, prioritize English
    const validChapters = selectChapters(allChapters, maxChapters);

    if (validChapters.length === 0) {
      console.error('❌ No valid chapters found');
      process.exit(1);
    }
    
    console.log(`✅ Selected ${validChapters.length} unique chapters`);
    
    // Show language breakdown
    const englishCount = validChapters.filter(c => c._isEnglish).length;
    const otherCount = validChapters.length - englishCount;
    console.log(`   🇬🇧 English: ${englishCount} | 🌐 Other: ${otherCount}`);

    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, 'chapters');
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });

    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const chapTitle = chapter.title ? ` - ${chapter.title}` : '';
      const langTag = chapter._isEnglish ? '' : ` [${chapter.translatedLanguage}]`;
      const chapDirName = `Ch.${String(chapNum).padStart(4, '0')}${chapTitle}${langTag}`.substring(0, 150);
      const chapDir = join(mangaDir, sanitize(chapDirName));
      
      if (!existsSync(chapDir)) mkdirSync(chapDir, { recursive: true });
      console.log(`⬇️  Chapter ${idx + 1}/${validChapters.length}: ${chapDirName}`);

      // Fetch full chapter data
      const fullChapter = await Chapter.get(chapter.id);
      
      // 🌟 CORRECT: Use getReadablePages with useDataSaver option
      const pages = await fullChapter.getReadablePages({ useDataSaver });

      // Download each page
      for (const [pageIdx, pageUrl] of pages.entries()) {
        const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
        const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
        const destPath = join(chapDir, filename);
        await downloadImage(pageUrl, destPath);
      }
      
      // Throttle between chapters to respect API limits
      await new Promise(r => setTimeout(r, 800));
    }

    const zipPath = join(workDir, zipName);
    console.log(`🗜️  Creating archive: ${zipName}`);
    const size = await createZip(mangaDir, zipPath);
    console.log(`✅ Archive created: ${(size / 1024 / 1024).toFixed(2)} MB`);
    
    // Output for GitHub Actions
    console.log(`::set-output name=zip_name::${zipName}`);
    console.log(`::set-output name=zip_path::${zipPath}`);
    writeFileSync(join(workDir, 'zip_name.txt'), zipName);
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
