#!/usr/bin/env node
import { Manga, Chapter, Cover } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join } from 'path';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 4;

// 🚀 Download cover image
async function downloadCover(coverUrl, destPath) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(coverUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const writer = createWriteStream(destPath);
      await pipeline(res.body, writer);
      return destPath;
    } catch {
      if (i === 2) return null;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// 🚀 Fast send with thumbnail support
async function sendDocumentWithThumb(chatId, filePath, fileName, caption, replyToMessageId, thumbPath) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', await fileFromPath(filePath), fileName);
      if (caption) form.append('caption', caption.substring(0, 1024));
      if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
      if (thumbPath && existsSync(thumbPath)) {
        form.append('thumb', await fileFromPath(thumbPath), 'thumb.jpg');
      }
      
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

async function sendText(chatId, text, replyToMessageId = null, disablePreview = true) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text, 
        reply_to_message_id: replyToMessageId, 
        parse_mode: 'HTML',
        disable_web_page_preview: disablePreview
      })
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

// Format chapter number without leading zeros
function formatChapNum(num) {
  return Number(num).toString();
}

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
        if (i === 1) throw new Error(`Failed page ${pageIdx + 1}`);
        await new Promise(r => setTimeout(r, 200));
      }
    }
  };

  for (let i = 0; i < pages.length; i += MAX_CONCURRENT_PAGES) {
    const batch = pages.slice(i, i + MAX_CONCURRENT_PAGES);
    await Promise.all(batch.map((url, idx) => downloadPage(url, i + idx)));
  }
}

async function createZip(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
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
  
  console.log(`📚 Manga ID: ${mangaId}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    const description = manga.description?.en || Object.values(manga.description || {})[0] || 'No description';
    const genres = manga.tags?.filter(t => t.group === 'genre').map(t => t.name?.en || Object.values(t.name)[0]) || [];
    const status = manga.status ? manga.status.charAt(0).toUpperCase() + manga.status.slice(1) : 'Unknown';
    const year = manga.year || 'N/A';
    
    // 📥 STEP 1: Get manga ID (already have it)
    // 📥 STEP 2: Get cover ID using Cover API
    console.log('📥 Fetching cover...');
    const covers = await Cover.getMangaCovers(mangaId);
    
    // Find main cover (usually the first one or with volume=null)
    const mainCover = covers.find(c => c.volume === null) || covers[0];
    
    let coverUrl = null;
    const workDir = join(process.cwd(), 'manga_download');
    const coverPath = join(workDir, 'cover.jpg');
    mkdirSync(workDir, { recursive: true });
    
    if (mainCover) {
      const coverId = mainCover.id;
      // Construct URL like: https://mangadex.org/covers/{manga-id}/{cover-id}.jpg
      coverUrl = `https://mangadex.org/covers/${mangaId}/${coverId}.jpg`;
      console.log(`📥 Cover URL: ${coverUrl}`);
      console.log('📥 Downloading cover image...');
      await downloadCover(coverUrl, coverPath);
    } else {
      console.log('⚠️  No cover found');
    }

    // Fetch chapters
    const allChapters = [];
    let offset = 0;
    while (true) {
      const chapters = await manga.getFeed({
        limit: 500,
        offset,
        translatedLanguage: ['en', 'ru', 'pl', 'id', 'pt-br', 'th', 'vi', 'ko', 'zh', 'jp'],
        order: { chapter: 'asc' }
      });
      if (chapters.length === 0) break;
      allChapters.push(...chapters);
      offset += 500;
      if (allChapters.length >= 300 || offset >= 500) break;
    }
    
    const validChapters = selectChapters(allChapters, maxChapters);
    if (validChapters.length === 0) { console.error('❌ No chapters found'); process.exit(1); }
    
    console.log(`✅ ${validChapters.length} chapters selected`);

    const mangaDir = join(workDir, 'chapters');
    const bundleDir = join(workDir, 'bundles');
    mkdirSync(mangaDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    // 📤 Post manga info with cover
    let rootMessageId = null;
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      const genresStr = genres.length > 0 ? genres.join(', ') : 'N/A';
      const infoText = `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
                      `<b>📖 Chapters:</b> ${validChapters.length}\n` +
                      `<b>📅 Year:</b> ${year}\n` +
                      `<b>📊 Status:</b> ${status}\n` +
                      `<b>🏷️ Genres:</b> ${escapeHtml(genresStr)}\n` +
                      `<b>📝 Description:</b>\n<i>${escapeHtml(description.substring(0, 800))}${description.length > 800 ? '...' : ''}</i>`;
      
      if (coverPath && existsSync(coverPath)) {
        const form = new FormData();
        form.append('chat_id', telegramChatId);
        form.append('photo', await fileFromPath(coverPath), 'cover.jpg');
        form.append('caption', infoText);
        form.append('parse_mode', 'HTML');
        
        const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
        const data = await res.json();
        if (data.ok) {
          rootMessageId = data.result.message_id;
          console.log('📤 Posted manga info with cover');
        }
      } else {
        rootMessageId = await sendText(telegramChatId, infoText, null, false);
      }
    }

    // 📦 Bundle chapters
    const bundles = [];
    let currentBundle = { chapters: [], size: 0 };
    
    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const langCode = chapter.translatedLanguage;
      const langTag = chapter._isEnglish ? '' : ` [${langCode}]`;
      
      const chapDir = join(mangaDir, `Ch.${formatChapNum(chapNum)}${langTag}`);
      mkdirSync(chapDir, { recursive: true });
      
      console.log(`[${idx + 1}/${validChapters.length}] Ch.${formatChapNum(chapNum)}`);

      try {
        const fullChapter = await Chapter.get(chapter.id);
        const pages = await fullChapter.getReadablePages({ useDataSaver });
        await downloadPages(pages, chapDir);
        
        const chapZipName = `Ch.${formatChapNum(chapNum)}${langTag}.zip`;
        const chapZipPath = join(chapDir, '..', chapZipName);
        const zipSize = await createZip(chapDir, chapZipPath);
        
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
      
      await new Promise(r => setTimeout(r, 100));
    }

    if (currentBundle.chapters.length > 0) bundles.push(currentBundle);
    console.log(`\n📦 Created ${bundles.length} bundle(s)`);

    // 📤 Upload bundles with cover thumbnail
    const uploadBundle = async (bundle, bundleIdx) => {
      const bundleStart = formatChapNum(bundle.chapters[0].chapNum);
      const bundleEnd = formatChapNum(bundle.chapters[bundle.chapters.length - 1].chapNum);
      const bundleZipName = `${safeTitle} - Ch.${bundleStart}-${bundleEnd}.zip`;
      const bundleZipPath = join(bundleDir, bundleZipName);

      const bundleArchive = archiver('zip', { zlib: { level: 6 } });
      const bundleOutput = createWriteStream(bundleZipPath);
      bundleArchive.pipe(bundleOutput);
      
      for (const chap of bundle.chapters) {
        bundleArchive.file(chap.zipPath, { name: `Ch.${formatChapNum(chap.chapNum)}.zip` });
      }
      
      await new Promise((resolve, reject) => {
        bundleOutput.on('close', resolve);
        bundleArchive.on('error', reject);
        bundleArchive.finalize();
      });

      const bundleSize = bundle.chapters.reduce((sum, c) => sum + c.size, 0);
      console.log(`📤 Bundle ${bundleIdx + 1}/${bundles.length} (Ch.${bundleStart}-${bundleEnd}, ${(bundleSize/1024/1024).toFixed(1)} MB)`);

      if (rootMessageId) {
        const chapterList = bundle.chapters.map(c => `Ch.${formatChapNum(c.chapNum)}`).join(', ');
        const caption = `📦 <b>Bundle ${bundleIdx + 1}/${bundles.length}</b>\n` +
                       `📖 <b>Chapters:</b> ${chapterList}\n` +
                       `📄 <b>Pages:</b> ${bundle.chapters.reduce((sum, c) => sum + c.pages, 0)}\n` +
                       `💾 <b>Size:</b> ${(bundleSize/1024/1024).toFixed(1)} MB`;
        
        await sendDocumentWithThumb(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId, coverPath);
      }

      rmSync(bundleZipPath, { force: true });
    };

    for (let i = 0; i < bundles.length; i += 2) {
      const batch = bundles.slice(i, i + 2);
      await Promise.all(batch.map((b, idx) => uploadBundle(b, i + idx)));
      if (i + 2 < bundles.length) await new Promise(r => setTimeout(r, 1000));
    }

    // ❌ REMOVED: Final status update message
    // No more "Download complete! 📦 2 bundles uploaded 📖 10 chapters total"

    console.log('\n✅ All bundles uploaded successfully');
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
