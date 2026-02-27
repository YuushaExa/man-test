#!/usr/bin/env node
import { Manga, Chapter } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join } from 'path';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 4; // Download 8 pages at once
const MAX_CONCURRENT_BUNDLES = 1; // Upload 2 bundles at once

// 🚀 Fast send with minimal retry
async function sendDocument(chatId, filePath, fileName, caption = '', replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', await fileFromPath(filePath), fileName);
      if (caption) form.append('caption', caption.substring(0, 1024));
      if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
      
      const res = await fetch(`${TELEGRAM_API}/sendDocument`, { 
        method: 'POST', 
        body: form,
        timeout: 60000
      });
      const data = await res.json();
      
      if (data.ok) return data;
      
      if (data.description?.includes('Too Many Requests')) {
        const retryAfter = data.description.match(/retry after (\d+)/)?.[1] || 3;
        await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 10000)));
      } else if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

async function sendText(chatId, text, replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyToMessageId, parse_mode: 'HTML' })
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch { return null; }
}

async function editMessageText(chatId, messageId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !messageId) return;
  try {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch {}
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function sanitize(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 100);
}

function parseChapterNum(chapStr) {
  if (!chapStr) return Infinity;
  const num = parseFloat(chapStr);
  return isNaN(num) ? Infinity : num;
}

// 🚀 Parallel page downloads
async function downloadPages(pages, chapDir) {
  const downloadPage = async (pageUrl, pageIdx) => {
    const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
    const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
    const destPath = join(chapDir, filename);
    
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(pageUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const writer = createWriteStream(destPath);
        await pipeline(res.body, writer);
        return true;
      } catch {
        if (i === 1) throw new Error(`Failed to download page ${pageIdx + 1}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };

  // Process pages in batches of MAX_CONCURRENT_PAGES
  for (let i = 0; i < pages.length; i += MAX_CONCURRENT_PAGES) {
    const batch = pages.slice(i, i + MAX_CONCURRENT_PAGES);
    await Promise.all(batch.map((url, idx) => downloadPage(url, i + idx)));
  }
}

async function createZip(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } }); // Faster compression
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function selectChapters(allChapters, maxChapters) {
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
    if (isEnglish) entry.english = ch;
    else if (!entry.other) entry.other = ch;
  }
  const selected = [];
  const sortedKeys = Array.from(chapterMap.keys()).sort((a, b) => a - b);
  for (const chapNum of sortedKeys) {
    if (selected.length >= maxChapters) break;
    const entry = chapterMap.get(chapNum);
    const chosen = entry.english || entry.other;
    if (chosen) selected.push({ ...chosen, _isEnglish: !!entry.english, _chapNum: chapNum });
  }
  return selected;
}

async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  const useDataSaver = process.env.USE_DATA_SAVER === 'true';
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '10', 10);
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!mangaInput) { console.error('❌ MANGA_INPUT not set'); process.exit(1); }

  const mangaId = mangaInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || mangaInput.trim();
  
  console.log(`📚 ${mangaId} | Data Saver: ${useDataSaver} | Max: ${maxChapters}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    
    // 🚀 Fetch chapters faster (larger limit, less pagination)
    const allChapters = [];
    let offset = 0;
    while (true) {
      const chapters = await manga.getFeed({
        limit: 500, // Larger batches
        offset,
        translatedLanguage: ['en', 'ru', 'pl', 'id', 'pt-br', 'th', 'vi', 'ko', 'zh', 'jp'],
        order: { chapter: 'asc' }
      });
      if (chapters.length === 0) break;
      allChapters.push(...chapters);
      offset += 500;
      if (allChapters.length >= 300 || offset >= 500) break; // Stop earlier
    }
    
    const validChapters = selectChapters(allChapters, maxChapters);
    if (validChapters.length === 0) { console.error('❌ No chapters found'); process.exit(1); }
    
    console.log(`✅ ${validChapters.length} chapters selected`);

    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, 'chapters');
    const bundleDir = join(workDir, 'bundles');
    mkdirSync(mangaDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    let rootMessageId = null;
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      rootMessageId = await sendText(telegramChatId, `<b>📚 ${escapeHtml(mangaTitle)}</b>\n<i>${validChapters.length} chapters...</i>`);
    }

    // 📦 Bundle chapters
    const bundles = [];
    let currentBundle = { chapters: [], size: 0 };
    
    // 🚀 Process chapters with minimal delays
    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const langCode = chapter.translatedLanguage;
      const langTag = chapter._isEnglish ? '' : ` [${langCode}]`;
      
      const chapDir = join(mangaDir, `Ch.${String(chapNum).padStart(4, '0')}${langTag}`);
      mkdirSync(chapDir, { recursive: true });
      
      console.log(`[${idx + 1}/${validChapters.length}] Ch.${chapNum}`);

      try {
        const fullChapter = await Chapter.get(chapter.id);
        const pages = await fullChapter.getReadablePages({ useDataSaver });

        // 🚀 Parallel page download
        await downloadPages(pages, chapDir);
        
        const chapZipName = `Ch.${String(chapNum).padStart(4, '0')}${langTag}.zip`;
        const chapZipPath = join(chapDir, '..', chapZipName);
        const zipSize = await createZip(chapDir, chapZipPath);
        
        // Bundle logic
        if (currentBundle.size + zipSize > TELEGRAM_FILE_LIMIT && currentBundle.chapters.length > 0) {
          bundles.push({ ...currentBundle });
          currentBundle = { chapters: [], size: 0 };
        }

        currentBundle.chapters.push({ zipPath: chapZipPath, chapNum, langCode, pages: pages.length, size: zipSize });
        currentBundle.size += zipSize;
        rmSync(chapDir, { recursive: true, force: true });
        
      } catch (chapErr) {
        console.error(`  ❌ ${chapErr.message}`);
      }
      
      // 🚀 Reduced delay between chapters (100ms instead of 500ms)
      await new Promise(r => setTimeout(r, 100));
    }

    if (currentBundle.chapters.length > 0) bundles.push(currentBundle);
    console.log(`\n📦 ${bundles.length} bundles`);

    // 🚀 Parallel bundle uploads (2 at a time)
    const uploadBundle = async (bundle, bundleIdx) => {
      const bundleStart = bundle.chapters[0].chapNum;
      const bundleEnd = bundle.chapters[bundle.chapters.length - 1].chapNum;
      const bundleZipName = `${safeTitle} - Ch.${String(bundleStart).padStart(4, '0')}-${String(bundleEnd).padStart(4, '0')}.zip`;
      const bundleZipPath = join(bundleDir, bundleZipName);

      const bundleArchive = archiver('zip', { zlib: { level: 6 } });
      const bundleOutput = createWriteStream(bundleZipPath);
      bundleArchive.pipe(bundleOutput);
      
      for (const chap of bundle.chapters) {
        bundleArchive.file(chap.zipPath, { name: `Ch.${String(chap.chapNum).padStart(4, '0')}.zip` });
      }
      
      await new Promise((resolve, reject) => {
        bundleOutput.on('close', resolve);
        bundleArchive.on('error', reject);
        bundleArchive.finalize();
      });

      const bundleSize = bundle.chapters.reduce((sum, c) => sum + c.size, 0);
      console.log(`📤 Bundle ${bundleIdx + 1}/${bundles.length} (${(bundleSize/1024/1024).toFixed(1)} MB)`);

      if (rootMessageId) {
        const chapterList = bundle.chapters.map(c => `Ch.${c.chapNum}`).join(', ');
        const caption = `📦 Bundle ${bundleIdx + 1}/${bundles.length}\n📖 ${chapterList}\n💾 ${(bundleSize/1024/1024).toFixed(1)} MB`;
        await sendDocument(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId);
      }

      rmSync(bundleZipPath, { force: true });
    };

    // 🚀 Upload bundles in parallel (2 at a time)
    for (let i = 0; i < bundles.length; i += MAX_CONCURRENT_BUNDLES) {
      const batch = bundles.slice(i, i + MAX_CONCURRENT_BUNDLES);
      await Promise.all(batch.map((b, idx) => uploadBundle(b, i + idx)));
      
      // Small delay between batch uploads
      if (i + MAX_CONCURRENT_BUNDLES < bundles.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (rootMessageId) {
      await editMessageText(telegramChatId, rootMessageId, `<b>✅ ${escapeHtml(mangaTitle)}</b>\n<i>Done! ${bundles.length} bundles</i>`);
    }

    console.log('\n🎉 Done!');
    rmSync(workDir, { recursive: true, force: true });
    
  } catch (err) {
    console.error(`❌ ${err.message}`);
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      await sendText(telegramChatId, `<b>❌ Failed</b>\n<code>${escapeHtml(err.message)}</code>`);
    }
    process.exit(1);
  }
}

main();
