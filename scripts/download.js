#!/usr/bin/env node
import { Manga, Chapter, Api } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, rmSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join, basename } from 'path';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';

// ─────────────────────────────────────────────────────────────
// CONFIG & CONSTANTS
// ─────────────────────────────────────────────────────────────
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50MB
const MANGADEX_AT_HOME_LIMIT = 40; // requests per minute
const MIN_AT_HOME_INTERVAL = Math.ceil(60000 / MANGADEX_AT_HOME_LIMIT) + 200; // ~1.7s + jitter
const IMAGE_DOWNLOAD_CONCURRENCY = 8; // Parallel image downloads (CDN-safe)
const CHAPTER_FETCH_DELAY = 500; // Between MangaDex feed requests

// ─────────────────────────────────────────────────────────────
// TELEGRAM HELPERS
// ─────────────────────────────────────────────────────────────
async function sendText(chatId, text, replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch { return null; }
}

async function sendDocument(chatId, filePath, fileName, caption = '', replyToMessageId = null, maxRetries = 5) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', await fileFromPath(filePath), fileName);
      if (caption) form.append('caption', caption.substring(0, 1024));
      if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
      
      const res = await fetch(`${TELEGRAM_API}/sendDocument`, { method: 'POST', body: form });
      const data = await res.json();
      
      if (data.ok) return data;
      
      // Handle Telegram rate limiting
      if (data.description?.includes('Too Many Requests')) {
        const retryAfter = data.description.match(/retry after (\d+)/)?.[1] || 5;
        const waitTime = Math.min(parseInt(retryAfter) * 1000, 30000);
        console.log(`  ⏳ Telegram rate limited, waiting ${waitTime/1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      
      // Exponential backoff for other errors
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`  ⏳ Error: ${data.description}, retrying in ${waitTime/1000}s`);
        await new Promise(r => setTimeout(r, waitTime));
      } else {
        throw new Error(data.description || 'Unknown error');
      }
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`  ⏳ Error: ${err.message}, retrying in ${waitTime/1000}s`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  return null;
}

async function editMessageText(chatId, messageId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch { /* Ignore edit errors */ }
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
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

async function downloadImage(url, destPath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'MangaDex-Telegram-Bot/1.0' } });
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

// ─────────────────────────────────────────────────────────────
// CHAPTER SELECTION LOGIC
// ─────────────────────────────────────────────────────────────
function selectChapters(allChapters, maxChapters) {
  const chapterMap = new Map();
  for (const ch of allChapters) {
    if (!ch.chapter || ch.externalUrl) continue;
    const chapNum = parseChapterNum(ch.chapter);
    if (chapNum === Infinity) continue;
    const isEnglish = ch.translatedLanguage === 'en';
    if (!chapterMap.has(chapNum)) chapterMap.set(chapNum, { english: null, other: null });
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

// ─────────────────────────────────────────────────────────────
// MANGADEX: SAFE AT-HOME FETCH WITH RATE LIMITING
// ─────────────────────────────────────────────────────────────
class MangaDexRateLimiter {
  constructor(requestsPerMinute = 40) {
    this.minInterval = Math.ceil(60000 / requestsPerMinute) + 150; // +jitter buffer
    this.lastCall = 0;
  }
  
  async waitIfNeeded() {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastCall = Date.now();
  }
  
  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      await this.waitIfNeeded();
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'MangaDex-Telegram-Bot/1.0' } });
        
        // Handle 429 Rate Limit
        if (res.status === 429) {
          const retryAfter = res.headers.get('X-RateLimit-Retry-After');
          const waitMs = retryAfter 
            ? Math.max(0, parseInt(retryAfter) * 1000 - Date.now()) 
            : 60000;
          console.log(`  ⏳ At-Home rate limited, waiting ${Math.round(waitMs/1000)}s`);
          await new Promise(r => setTimeout(r, Math.min(waitMs, 60000)));
          continue;
        }
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// PARALLEL IMAGE DOWNLOADER (SEMAPHORE PATTERN)
// ─────────────────────────────────────────────────────────────
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.count--;
  }
}

async function downloadImagesParallel(serverResponse, chapDir, concurrency = IMAGE_DOWNLOAD_CONCURRENCY) {
  const { baseUrl, hash, chapter } = serverResponse;
  const pages = chapter.data.map(f => `${baseUrl}/data/${hash}/${f}`);
  const sem = new Semaphore(concurrency);
  
  const results = await Promise.all(pages.map(async (url, idx) => {
    await sem.acquire();
    try {
      // Small jitter to avoid CDN hammering
      await new Promise(r => setTimeout(r, Math.random() * 50));
      const ext = url.split('.').pop().split('?')[0] || 'jpg';
      const filename = `${String(idx + 1).padStart(3, '0')}.${ext}`;
      await downloadImage(url, join(chapDir, filename));
      return { success: true, idx };
    } catch (e) {
      console.error(`  ❌ Page ${idx + 1}: ${e.message}`);
      return { success: false, idx, error: e.message };
    } finally {
      sem.release();
    }
  }));
  
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.warn(`  ⚠️  ${failed.length}/${pages.length} pages failed to download`);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// MAIN EXECUTION
// ─────────────────────────────────────────────────────────────
async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  const useDataSaver = process.env.USE_DATA_SAVER === 'true';
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '10', 10);
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!mangaInput) {
    console.error('❌ MANGA_INPUT not set');
    process.exit(1);
  }

  const mangaId = mangaInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || mangaInput.trim();
  
  console.log(`📚 Fetching manga: ${mangaId}`);
  console.log(`⚙️  Data Saver: ${useDataSaver} | Max Chapters: ${maxChapters}`);

  const rateLimiter = new MangaDexRateLimiter(40);

  try {
    // Initialize MangaDex API
    await Api.login();
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    console.log(`✅ Manga: ${mangaTitle}`);

    // Fetch chapters with pagination
    const allChapters = [];
    let offset = 0;
    while (true) {
      const chapters = await manga.getFeed({
        limit: 100,
        offset,
        translatedLanguage: ['en', 'ru', 'pl', 'id', 'pt-br', 'th', 'vi', 'ko', 'zh', 'jp'],
        order: { chapter: 'asc' }
      });
      if (chapters.length === 0) break;
      allChapters.push(...chapters);
      offset += 100;
      if (allChapters.length >= 300) break;
      await new Promise(r => setTimeout(r, CHAPTER_FETCH_DELAY));
    }
    console.log(`📋 Found ${allChapters.length} chapters`);

    const validChapters = selectChapters(allChapters, maxChapters);
    if (validChapters.length === 0) throw new Error('No valid chapters found');
    console.log(`🎯 Selected ${validChapters.length} chapters`);

    // Setup directories
    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, 'chapters');
    const bundleDir = join(workDir, 'bundles');
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });
    if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

    // Post initial message to Telegram
    let rootMessageId = null;
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      const titleMsg = `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
                      `<i>Downloading ${validChapters.length} chapter(s)...</i>\n` +
                      `<i>Max bundle: 50MB | Parallel downloads: ${IMAGE_DOWNLOAD_CONCURRENCY}x</i>`;
      rootMessageId = await sendText(telegramChatId, titleMsg);
    }

    // 📦 Bundle chapters (50MB limit)
    const bundles = [];
    let currentBundle = { chapters: [], size: 0 };
    
    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const chapTitle = chapter.title ? ` - ${chapter.title}` : '';
      const langCode = chapter.translatedLanguage;
      const langTag = chapter._isEnglish ? '' : ` [${langCode}]`;
      const chapDirName = `Ch.${String(chapNum).padStart(4, '0')}${chapTitle}${langTag}`.substring(0, 120);
      const chapDir = join(mangaDir, sanitize(chapDirName));
      
      if (!existsSync(chapDir)) mkdirSync(chapDir, { recursive: true });
      console.log(`\n📖 Chapter ${idx + 1}/${validChapters.length}: ${chapNum}${langTag}`);

      // Update progress
      if (rootMessageId) {
        await editMessageText(telegramChatId, rootMessageId, 
          `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
          `<i>Processing chapter ${idx + 1}/${validChapters.length}...</i>`
        );
      }

      try {
        console.time(`  Chapter ${chapNum}`);
        
        // Fetch At-Home server info (rate-limited)
        const serverResp = await rateLimiter.fetchWithRetry(
          `https://api.mangadex.org/at-home/server/${chapter.id}`
        );
        
        // Download images in parallel (CDN - not API rate limited)
        await downloadImagesParallel(serverResp, chapDir, IMAGE_DOWNLOAD_CONCURRENCY);
        
        console.timeEnd(`  Chapter ${chapNum}`);
        
        // Create ZIP for this chapter
        const chapZipName = `Ch.${String(chapNum).padStart(4, '0')}${langTag}.zip`;
        const chapZipPath = join(chapDir, '..', chapZipName);
        const zipSize = await createZip(chapDir, chapZipPath);
        console.log(`  🗜️  ZIP: ${(zipSize / 1024 / 1024).toFixed(2)} MB`);

        // Bundle logic: start new bundle if limit exceeded
        if (currentBundle.size + zipSize > TELEGRAM_FILE_LIMIT && currentBundle.chapters.length > 0) {
          bundles.push({ ...currentBundle });
          currentBundle = { chapters: [], size: 0 };
          console.log(`  📦 Bundle complete (${bundles[bundles.length - 1].chapters.length} chapters)`);
        }

        currentBundle.chapters.push({
          zipPath: chapZipPath,
          chapNum,
          chapTitle: chapter.title,
          langCode,
          pages: serverResp.chapter.data.length,
          size: zipSize
        });
        currentBundle.size += zipSize;

        // Cleanup chapter folder
        rmSync(chapDir, { recursive: true, force: true });
        
      } catch (chapErr) {
        console.error(`  ❌ Failed: ${chapErr.message}`);
        rmSync(chapDir, { recursive: true, force: true });
      }
    }

    // Push final bundle
    if (currentBundle.chapters.length > 0) bundles.push(currentBundle);
    console.log(`\n📦 Created ${bundles.length} bundle(s)`);

    // 📤 Upload bundles to Telegram WITH 2-SECOND DELAY BETWEEN REQUESTS
    const failedBundles = [];
    
    for (const [bundleIdx, bundle] of bundles.entries()) {
      const bundleStart = bundle.chapters[0].chapNum;
      const bundleEnd = bundle.chapters[bundle.chapters.length - 1].chapNum;
      const bundleZipName = `${safeTitle} - Ch.${String(bundleStart).padStart(4, '0')}-${String(bundleEnd).padStart(4, '0')}.zip`;
      const bundleZipPath = join(bundleDir, bundleZipName);

      console.log(`\n📤 Uploading bundle ${bundleIdx + 1}/${bundles.length} (Ch.${bundleStart}-${bundleEnd})`);

      // Create combined bundle ZIP
      const bundleArchive = archiver('zip', { zlib: { level: 9 } });
      const bundleOutput = createWriteStream(bundleZipPath);
      bundleArchive.pipe(bundleOutput);
      
      for (const chap of bundle.chapters) {
        const chapFileName = `Ch.${String(chap.chapNum).padStart(4, '0')}.zip`;
        bundleArchive.file(chap.zipPath, { name: chapFileName });
      }
      
      await new Promise((resolve, reject) => {
        bundleOutput.on('close', resolve);
        bundleArchive.on('error', reject);
        bundleArchive.finalize();
      });

      const bundleSize = bundle.chapters.reduce((sum, c) => sum + c.size, 0);
      console.log(`  💾 Bundle size: ${(bundleSize / 1024 / 1024).toFixed(2)} MB`);

      // Upload to Telegram
      if (rootMessageId) {
        const chapterList = bundle.chapters.map(c => `Ch.${c.chapNum}`).join(', ');
        const caption = `📦 <b>Bundle ${bundleIdx + 1}/${bundles.length}</b>\n` +
                       `📖 Chapters: ${chapterList}\n` +
                       `📄 Total: ${bundle.chapters.reduce((sum, c) => sum + c.pages, 0)} pages\n` +
                       `💾 ${(bundleSize / 1024 / 1024).toFixed(2)} MB`;
        
        const result = await sendDocument(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId, 5);
        
        if (result?.ok) {
          console.log(`  ✅ Uploaded successfully`);
        } else {
          console.error(`  ❌ Upload failed after retries`);
          failedBundles.push({ bundleIdx, bundleZipPath, bundleZipName, caption });
        }

        // ⏱️ 2-SECOND DELAY BETWEEN SUCCESSFUL UPLOADS (as requested)
        if (result?.ok && bundleIdx < bundles.length - 1) {
          console.log(`  ⏱️  Waiting 2s before next upload...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Cleanup bundle ZIP if upload succeeded
      if (!failedBundles.find(f => f.bundleIdx === bundleIdx)) {
        rmSync(bundleZipPath, { force: true });
      }
    }

    // 🔄 Retry failed bundles
    if (failedBundles.length > 0) {
      console.log(`\n⚠️  ${failedBundles.length} bundle(s) failed, retrying...`);
      
      for (const [retryIdx, failed] of failedBundles.entries()) {
        console.log(`\n🔄 Retrying failed bundle ${retryIdx + 1}/${failedBundles.length}`);
        const result = await sendDocument(telegramChatId, failed.bundleZipPath, failed.bundleZipName, failed.caption, rootMessageId, 3);
        
        if (result?.ok) {
          console.log(`  ✅ Retry successful`);
          rmSync(failed.bundleZipPath, { force: true });
        } else {
          console.error(`  ❌ Retry failed`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Final status update
    if (rootMessageId) {
      const status = failedBundles.length === 0 ? '✅' : '⚠️';
      await editMessageText(telegramChatId, rootMessageId, 
        `<b>${status} ${escapeHtml(mangaTitle)}</b>\n` +
        `<i>Complete!</i>\n` +
        `📦 ${bundles.length} bundle(s)\n` +
        `📖 ${validChapters.length} chapter(s)\n` +
        (failedBundles.length > 0 ? `⚠️  ${failedBundles.length} bundle(s) failed` : '')
      );
    }

    console.log('\n🎉 Done!');
    rmSync(workDir, { recursive: true, force: true });
    
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message}`);
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      await sendText(telegramChatId, `<b>❌ Failed</b>\n<code>${escapeHtml(err.message)}</code>`);
    }
    process.exit(1);
  }
}

main();
