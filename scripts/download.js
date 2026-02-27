#!/usr/bin/env node
import { Manga, Chapter } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { 
  createWriteStream, 
  mkdirSync, 
  existsSync, 
  writeFileSync, 
  readFileSync,
  readdirSync,
  statSync,
  cpSync,
  rmSync
} from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join, basename } from 'path';

function extractUuid(input) {
  const match = input.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : input.trim();
}

function sanitize(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 100);
}

function parseChapterNum(chapStr) {
  if (!chapStr) return Infinity;
  const num = parseFloat(chapStr);
  return isNaN(num) ? Infinity : num;
}

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

// 🌟 Copy directory recursively (fixed version)
function copyDir(src, dest) {
  if (!existsSync(src)) return;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  
  const entries = readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

function selectChapters(allChapters, maxChapters = 10) {
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
    if (isEnglish) {
      entry.english = ch;
    } else if (!entry.other) {
      entry.other = ch;
    }
  }
  
  const selected = [];
  const sortedKeys = Array.from(chapterMap.keys()).sort((a, b) => a - b);
  
  for (const chapNum of sortedKeys) {
    if (selected.length >= maxChapters) break;
    const entry = chapterMap.get(chapNum);
    const chosen = entry.english || entry.other;
    if (chosen) {
      selected.push({ ...chosen, _isEnglish: !!entry.english, _chapNum: chapNum });
    }
  }
  
  return selected;
}

// 🌟 Smart chapter grouping - combine small chapters under target MB
function groupChapters(chapterList, maxSizeMB = 45) {
  const groups = [];
  let currentGroup = null;
  let currentSize = 0;
  
  for (const chapter of chapterList) {
    const chapterSizeMB = chapter.size / (1024 * 1024);
    
    if (!currentGroup) {
      currentGroup = {
        chapters: [chapter],
        totalSize: chapter.size,
        startChapter: chapter.chapterNum,
        endChapter: chapter.chapterNum
      };
      currentSize = chapterSizeMB;
      continue;
    }
    
    if (currentSize + chapterSizeMB <= maxSizeMB) {
      currentGroup.chapters.push(chapter);
      currentGroup.totalSize += chapter.size;
      currentGroup.endChapter = chapter.chapterNum;
      currentSize += chapterSizeMB;
    } else {
      groups.push(currentGroup);
      currentGroup = {
        chapters: [chapter],
        totalSize: chapter.size,
        startChapter: chapter.chapterNum,
        endChapter: chapter.chapterNum
      };
      currentSize = chapterSizeMB;
    }
  }
  
  if (currentGroup) {
    groups.push(currentGroup);
  }
  
  return groups;
}

async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  const useDataSaver = process.env.USE_DATA_SAVER === 'true';
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '10', 10);
  const uploadArtwork = process.env.UPLOAD_ARTWORK === 'true';
  const bundleSizeMB = parseInt(process.env.BUNDLE_SIZE_MB || '45', 10);
  
  if (!mangaInput) {
    console.error('❌ MANGA_INPUT not set');
    process.exit(1);
  }

  const mangaId = extractUuid(mangaInput);
  console.log(`🔍 Fetching manga: ${mangaId}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    const author = manga.authors?.[0]?.name || 'Unknown';
    const artist = manga.artists?.[0]?.name || author;
    const status = manga.status || 'Unknown';
    const year = manga.year || 'Unknown';
    const description = manga.description?.en || Object.values(manga.description || {})[0] || 'No description';
    const coverArt = manga.coverArtUrl || '';
    
    // 🌟 Fetch genres, themes, tags
    const genres = manga.genres?.map(g => g.name).join(', ') || 'None';
    const themes = manga.themes?.map(t => t.name).join(', ') || 'None';
    const tags = manga.tags?.slice(0, 10).map(t => t.name).join(', ') || 'None';
    const contentRating = manga.contentRating || 'Safe';
    const originalLanguage = manga.originalLanguage || 'Unknown';
    
    console.log(`📚 Manga: ${mangaTitle}`);
    console.log(`👤 Author: ${author}`);
    console.log(`📖 Max Chapters: ${maxChapters}`);
    console.log(`📦 Bundle Size Target: ${bundleSizeMB} MB`);

    // Fetch chapters with pagination
    console.log('📖 Scanning chapters...');
    const allChapters = [];
    let offset = 0;
    const limit = 100;
    
    while (true) {
      const chapters = await manga.getFeed({
        limit, offset,
        translatedLanguage: ['en', 'ja', 'ko', 'zh'],
        order: { chapter: 'asc' }
      });
      if (chapters.length === 0) break;
      allChapters.push(...chapters);
      offset += limit;
      if (allChapters.length >= 300) break;
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`📊 Found ${allChapters.length} total chapters`);
    const validChapters = selectChapters(allChapters, maxChapters);

    if (validChapters.length === 0) {
      console.error('❌ No valid chapters found');
      process.exit(1);
    }
    
    console.log(`✅ Selected ${validChapters.length} unique chapters`);

    const workDir = join(process.cwd(), 'temp');
    const mangaDir = join(workDir, 'chapters');
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });

    const chapterList = [];

    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const chapTitle = chapter.title ? ` - ${chapter.title}` : '';
      const langTag = chapter._isEnglish ? '' : ` [${chapter.translatedLanguage}]`;
      const chapDirName = `Ch.${String(chapNum).padStart(4, '0')}${chapTitle}${langTag}`.substring(0, 150);
      const chapDir = join(mangaDir, sanitize(chapDirName));
      
      if (!existsSync(chapDir)) mkdirSync(chapDir, { recursive: true });
      console.log(`⬇️  Chapter ${idx + 1}/${validChapters.length}: ${chapDirName}`);

      const fullChapter = await Chapter.get(chapter.id);
      const pages = await fullChapter.getReadablePages({ useDataSaver });

      for (const [pageIdx, pageUrl] of pages.entries()) {
        const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
        const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
        const destPath = join(chapDir, filename);
        await downloadImage(pageUrl, destPath);
      }
      
      // Create individual chapter zip
      const chapZipName = `Ch.${String(chapNum).padStart(4, '0')}${langTag}.zip`;
      const chapZipPath = join(workDir, chapZipName);
      const chapSize = await createZip(chapDir, chapZipPath);
      
      chapterList.push({
        zipPath: chapZipPath,
        zipName: chapZipName,
        size: chapSize,
        chapterNum: chapNum,
        title: chapTitle,
        lang: chapter.translatedLanguage,
        chapDirName: sanitize(chapDirName) // Store for later copying
      });
      
      console.log(`   📦 Created: ${chapZipName} (${(chapSize / 1024 / 1024).toFixed(2)} MB)`);
      
      await new Promise(r => setTimeout(r, 800));
    }

    // 🌟 Group chapters into bundles under target MB
    console.log('📦 Grouping chapters into bundles...');
    const chapterGroups = groupChapters(chapterList, bundleSizeMB);
    console.log(`✅ Created ${chapterGroups.length} chapter bundles`);

    // Create combined zips for groups
    const bundleList = [];
    for (const [idx, group] of chapterGroups.entries()) {
      const bundleDir = join(workDir, `bundle_${idx}`);
      if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });
      
      // 🌟 FIXED: Copy chapter folders to bundle using copyDir helper
      for (const ch of group.chapters) {
        const sourceDir = join(mangaDir, ch.chapDirName);
        const destDir = join(bundleDir, `Ch.${String(ch.chapterNum).padStart(4, '0')}`);
        
        if (existsSync(sourceDir)) {
          copyDir(sourceDir, destDir);
          console.log(`   📁 Copied: ${ch.chapDirName}`);
        }
      }
      
      const startChap = String(group.startChapter).padStart(4, '0');
      const endChap = group.startChapter === group.endChapter 
        ? startChap 
        : `${startChap}-${String(group.endChapter).padStart(4, '0')}`;
      
      const bundleZipName = `Ch.${endChap}.zip`;
      const bundleZipPath = join(workDir, bundleZipName);
      const bundleSize = await createZip(bundleDir, bundleZipPath);
      
      bundleList.push({
        zipPath: bundleZipPath,
        zipName: bundleZipName,
        size: bundleSize,
        startChapter: group.startChapter,
        endChapter: group.endChapter,
        chapterCount: group.chapters.length
      });
      
      console.log(`   📦 Bundle: ${bundleZipName} (${(bundleSize / 1024 / 1024).toFixed(2)} MB, ${group.chapters.length} chapters)`);
      
      // Cleanup bundle dir
      rmSync(bundleDir, { recursive: true, force: true });
    }

    // Download cover art
    let coverArtPath = null;
    if (coverArt) {
      try {
        coverArtPath = join(workDir, 'cover.jpg');
        const res = await fetch(coverArt);
        if (res.ok) {
          const writer = createWriteStream(coverArtPath);
          await pipeline(res.body, writer);
          console.log(`✅ Cover art downloaded`);
        }
      } catch (e) {
        console.warn('⚠️  Could not download cover art');
        coverArtPath = null;
      }
    }

    // Save metadata for Telegram upload
    const metadata = {
      mangaId,
      title: mangaTitle,
      safeTitle,
      author,
      artist,
      status,
      year,
      description: description.substring(0, 4000),
      coverArt,
      coverArtPath,
      genres,
      themes,
      tags,
      contentRating,
      originalLanguage,
      chapterCount: validChapters.length,
      bundleCount: bundleList.length,
      bundles: bundleList,
      useDataSaver,
      uploadArtwork,
      downloadDate: new Date().toISOString()
    };

    const metadataPath = join(workDir, 'metadata.json');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    
    console.log(`✅ Metadata saved to ${metadataPath}`);
    console.log(`✅ Ready for Telegram upload (${bundleList.length} bundles)`);
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
