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
const MAX_CONCURRENT_PAGES = 8;

// 📥 Download cover image with proper error handling
async function downloadCover(coverUrl, destPath) {
  console.log(`📥 Downloading cover from: ${coverUrl}`);
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(coverUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const writer = createWriteStream(destPath);
      await pipeline(res.body, writer);
      console.log(`✅ Cover downloaded: ${destPath}`);
      return destPath;
    } catch (err) {
      console.log(`⚠️  Cover download attempt ${i + 1} failed: ${err.message}`);
      if (i === 2) {
        console.log('❌ Cover download failed after 3 attempts');
        return null;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// 📤 Send document with thumbnail
async function sendDocumentWithThumb(chatId, filePath, fileName, caption, replyToMessageId, thumbPath) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', await fileFromPath(filePath), fileName);
      if (caption) form.append('caption', caption.substring(0, 1024));
      if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
      
      // Telegram thumbnail requirements: JPG, <200KB, 320x320 max
      if (thumbPath && existsSync(thumbPath)) {
        try {
          const thumbFile = await fileFromPath(thumbPath);
          form.append('thumb', thumbFile, 'thumb.jpg');
          console.log(`  🖼️  Using thumbnail: ${thumbPath}`);
        } catch (thumbErr) {
          console.log(`  ⚠️  Thumbnail error: ${thumbErr.message}`);
        }
      }
      
      const res = await fetch(`${TELEGRAM_API}/sendDocument`, { 
        method: 'POST', 
        body: form,
        timeout: 60000
      });
      const data = await res.json();
      
      if (data.ok) {
        console.log(`  ✅ Uploaded: ${fileName}`);
        return data;
      }
      
      console.log(`  ⚠️  Upload attempt ${attempt} failed: ${data.description}`);
      
      if (data.description?.includes('Too Many Requests')) {
        const retryAfter = data.description.match(/retry after (\d+)/)?.[1] || 3;
        await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 10000)));
      } else if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    } catch (err) {
      console.log(`  ⚠️  Upload error: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

// 📤 Send photo (for initial manga info)
async function sendPhoto(chatId, photoPath, caption) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !existsSync(photoPath)) {
    console.log('⚠️  Cannot send photo: no token or file missing');
    return null;
  }
  
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', await fileFromPath(photoPath), 'cover.jpg');
    if (caption) form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    
    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { 
      method: 'POST', 
      body: form,
      timeout: 60000
    });
    const data = await res.json();
    
    if (data.ok) {
      console.log('📤 Manga info posted with cover photo');
      return data.result.message_id;
    } else {
      console.log(`⚠️  SendPhoto failed: ${data.description}`);
      return null;
    }
  } catch (err) {
    console.log(`⚠️  SendPhoto error: ${err.message}`);
    return null;
  }
}

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
        parse_mode: 'HTML',
        disable_web_page_preview: true
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
  if (!telegramChatId) { console.error('❌ TELEGRAM_CHAT_ID not set'); process.exit(1); }
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

  const mangaId = mangaInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || mangaInput.trim();
  
  console.log(`📚 Manga ID: ${mangaId}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    const description = manga.description?.en || Object.values(manga.description || {})[0] || 'No description available';
    const genres = manga.tags?.filter(t => t.group === 'genre').map(t => t.name?.en || Object.values(t.name)[0]) || [];
    const status = manga.status ? manga.status.charAt(0).toUpperCase() + manga.status.slice(1) : 'Unknown';
    const year = manga.year || 'N/A';
    
    console.log(`📖 Title: ${mangaTitle}`);
    console.log(`🏷️  Genres: ${genres.join(', ') || 'N/A'}`);

    // 📥 Setup working directory
    const workDir = join(process.cwd(), 'manga_download');
    const coverPath = join(workDir, 'cover.jpg');
    mkdirSync(workDir, { recursive: true });
    
    // 📥 Download cover image
    let coverUrl = null;
    if (manga.cover) {
      coverUrl = `https://uploads.mangadex.org/covers/${manga.id}/${manga.cover.fileName}`;
    } else {
      // Try to get cover from relationships
      const coverRel = manga.relationships?.find(r => r.type === 'cover_art');
      if (coverRel) {
        coverUrl = `https://uploads.mangadex.org/covers/${manga.id}/${coverRel.attributes?.fileName}`;
      }
    }
    
    let hasCover = false;
    if (coverUrl) {
      const coverResult = await downloadCover(coverUrl, coverPath);
      hasCover = coverResult !== null;
    } else {
      console.log('⚠️  No cover URL found for this manga');
    }

    // Fetch chapters
    console.log('📖 Fetching chapters...');
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
      
      // Send with cover photo if available
      if (hasCover && existsSync(coverPath)) {
        rootMessageId = await sendPhoto(telegramChatId, coverPath, infoText);
      }
      
      // Fallback to text only
      if (!rootMessageId) {
        console.log('⚠️  Falling back to text-only message');
        rootMessageId = await sendText(telegramChatId, infoText);
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
    console.log(`\n📦 ${bundles.length} bundles created`);

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
        
        // Use cover as thumbnail (only if it exists)
        const thumbToUse = (hasCover && existsSync(coverPath)) ? coverPath : null;
        await sendDocumentWithThumb(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId, thumbToUse);
      }

      rmSync(bundleZipPath, { force: true });
    };

    for (let i = 0; i < bundles.length; i += 2) {
      const batch = bundles.slice(i, i + 2);
      await Promise.all(batch.map((b, idx) => uploadBundle(b, i + idx)));
      if (i + 2 < bundles.length) await new Promise(r => setTimeout(r, 1000));
    }

    // Final update
    if (rootMessageId) {
      await editMessageText(telegramChatId, rootMessageId, 
        `<b>✅ ${escapeHtml(mangaTitle)}</b>\n` +
        `<i>Download complete!</i>\n` +
        `📦 ${bundles.length} bundles uploaded\n` +
        `📖 ${validChapters.length} chapters total`
      );
    }

    console.log('\n🎉 Done!');
    rmSync(workDir, { recursive: true, force: true });
    
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(err.stack);
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      await sendText(telegramChatId, `<b>❌ Failed</b>\n<code>${escapeHtml(err.message)}</code>`);
    }
    process.exit(1);
  }
}

main();
