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
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50MB

async function sendText(chatId, text, replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
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
}

async function sendDocument(chatId, filePath, fileName, caption = '', replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', await fileFromPath(filePath), fileName);
  if (caption) form.append('caption', caption.substring(0, 1024));
  if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
  const res = await fetch(`${TELEGRAM_API}/sendDocument`, { method: 'POST', body: form });
  return res.json();
}

async function editMessageText(chatId, messageId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML'
    })
  });
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
  
  console.log(`Fetching manga: ${mangaId}`);
  console.log(`Data Saver: ${useDataSaver}`);
  console.log(`Max Chapters: ${maxChapters}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    
    console.log(`Manga: ${mangaTitle}`);

    // Fetch chapters
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
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`Found ${allChapters.length} chapters`);

    const validChapters = selectChapters(allChapters, maxChapters);
    if (validChapters.length === 0) {
      console.error('❌ No valid chapters found');
      process.exit(1);
    }
    
    console.log(`Selected ${validChapters.length} chapters`);

    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, 'chapters');
    const bundleDir = join(workDir, 'bundles');
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });
    if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

    // Post manga title to Telegram
    let rootMessageId = null;
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      const titleMsg = `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
                      `<i>Downloading ${validChapters.length} chapter(s)...</i>\n` +
                      `<i>Max bundle size: 50MB</i>`;
      rootMessageId = await sendText(telegramChatId, titleMsg);
    }

    // 📦 Bundle chapters together
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
      console.log(`Chapter ${idx + 1}/${validChapters.length}: ${chapNum}`);

      // Update progress
      if (rootMessageId) {
        await editMessageText(telegramChatId, rootMessageId, 
          `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
          `<i>Processing chapter ${idx + 1}/${validChapters.length}...</i>`
        );
      }

      try {
        const fullChapter = await Chapter.get(chapter.id);
        const pages = await fullChapter.getReadablePages({ useDataSaver });
        console.log(`  ${pages.length} pages`);

        for (const [pageIdx, pageUrl] of pages.entries()) {
          const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
          const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
          await downloadImage(pageUrl, join(chapDir, filename));
        }
        
        // Create ZIP for this chapter
        const chapZipName = `Ch.${String(chapNum).padStart(4, '0')}${langTag}.zip`;
        const chapZipPath = join(chapDir, '..', chapZipName);
        const zipSize = await createZip(chapDir, chapZipPath);
        
        console.log(`  ZIP size: ${(zipSize / 1024 / 1024).toFixed(2)} MB`);

        // Check if adding this chapter exceeds 50MB
        if (currentBundle.size + zipSize > TELEGRAM_FILE_LIMIT && currentBundle.chapters.length > 0) {
          // Save current bundle and start new one
          bundles.push({ ...currentBundle });
          currentBundle = { chapters: [], size: 0 };
          console.log(`  📦 Bundle complete (${currentBundle.chapters.length} chapters), starting new bundle`);
        }

        // Add chapter to current bundle
        currentBundle.chapters.push({
          zipPath: chapZipPath,
          chapNum: chapNum,
          chapTitle: chapter.title,
          langCode: langCode,
          pages: pages.length,
          size: zipSize
        });
        currentBundle.size += zipSize;

        // Clean up chapter folder
        rmSync(chapDir, { recursive: true, force: true });
        
      } catch (chapErr) {
        console.error(`  Failed: ${chapErr.message}`);
      }
      
      await new Promise(r => setTimeout(r, 500));
    }

    // Don't forget the last bundle
    if (currentBundle.chapters.length > 0) {
      bundles.push(currentBundle);
    }

    console.log(`\n📦 Created ${bundles.length} bundle(s)`);

    // 📤 Upload bundles to Telegram
    for (const [bundleIdx, bundle] of bundles.entries()) {
      const bundleStart = bundle.chapters[0].chapNum;
      const bundleEnd = bundle.chapters[bundle.chapters.length - 1].chapNum;
      const bundleZipName = `${safeTitle} - Ch.${String(bundleStart).padStart(4, '0')}-${String(bundleEnd).padStart(4, '0')}.zip`;
      const bundleZipPath = join(bundleDir, bundleZipName);

      console.log(`\n📤 Uploading bundle ${bundleIdx + 1}/${bundles.length} (Ch.${bundleStart}-${bundleEnd})`);

      // Create combined ZIP for this bundle
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
      console.log(`  Bundle size: ${(bundleSize / 1024 / 1024).toFixed(2)} MB`);

      // Upload to Telegram
      if (rootMessageId) {
        const chapterList = bundle.chapters.map(c => `Ch.${c.chapNum}`).join(', ');
        const caption = `📦 <b>Bundle ${bundleIdx + 1}/${bundles.length}</b>\n` +
                       `📖 Chapters: ${chapterList}\n` +
                       `📄 Total: ${bundle.chapters.reduce((sum, c) => sum + c.pages, 0)} pages\n` +
                       `💾 ${(bundleSize / 1024 / 1024).toFixed(2)} MB`;
        
        const result = await sendDocument(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId);
        
        if (result.ok) {
          console.log(`  ✅ Uploaded successfully`);
        } else {
          console.error(`  ❌ Upload failed: ${result.description}`);
        }

        // ⏱️ 2 second delay between bundle uploads
        if (bundleIdx < bundles.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Clean up bundle ZIP
      rmSync(bundleZipPath, { force: true });
    }

    // Final update
    if (rootMessageId) {
      await editMessageText(telegramChatId, rootMessageId, 
        `<b>✅ ${escapeHtml(mangaTitle)}</b>\n` +
        `<i>Complete!</i>\n` +
        `📦 ${bundles.length} bundle(s)\n` +
        `📖 ${validChapters.length} chapter(s) total`
      );
    }

    console.log('\n🎉 Done!');
    rmSync(workDir, { recursive: true, force: true });
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      await sendText(telegramChatId, `<b>❌ Failed</b>\n<code>${escapeHtml(err.message)}</code>`);
    }
    
    process.exit(1);
  }
}

main();
