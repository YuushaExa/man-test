#!/usr/bin/env node
import { Manga, Chapter } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, writeFileSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join, basename } from 'path';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';

// 🌐 Telegram API helpers
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendText(chatId, text, replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
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
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.message_id;
}

async function sendDocument(chatId, filePath, fileName, caption = '', replyToMessageId = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  const form = new FormData();
  form.append('chat_id', chatId);
  
  const file = await fileFromPath(filePath);
  form.append('document', file, fileName);
  
  if (caption) form.append('caption', caption.substring(0, 1024)); // Telegram caption limit
  if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
  
  const res = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: form
  });
  
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.message_id;
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

// Extract UUID from URL or use as-is
function extractUuid(input) {
  const match = input.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : input.trim();
}

// Sanitize filename for filesystem and ZIP
function sanitize(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
}

// Escape HTML for Telegram captions
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '10', 10);
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const useTelegram = !!(telegramChatId && telegramToken);
  
  if (!mangaInput) {
    console.error('❌ MANGA_INPUT environment variable not set');
    process.exit(1);
  }

  const mangaId = extractUuid(mangaInput);
  console.log(`🔍 Fetching manga: ${mangaId}`);
  console.log(`💾 Data Saver Mode: ${useDataSaver ? 'ON' : 'OFF'}`);
  console.log(`📖 Max Chapters: ${maxChapters}`);
  console.log(`📤 Telegram Upload: ${useTelegram ? 'ENABLED' : 'DISABLED'}`);

  try {
    const manga = await Manga.get(mangaId);
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || Object.values(manga.title)[0] || 'Unknown';
    const safeTitle = sanitize(mangaTitle);
    
    console.log(`📚 Manga: ${mangaTitle}`);

    // 🌟 Fetch chapters with pagination
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
      
      if (allChapters.length >= 300) {
        console.log(`⏹️  Stopped at ${allChapters.length} chapters (sufficient for selection)`);
        break;
      }
      
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`📊 Found ${allChapters.length} total chapters`);

    // 🌟 Smart selection
    const validChapters = selectChapters(allChapters, maxChapters);

    if (validChapters.length === 0) {
      console.error('❌ No valid chapters found');
      process.exit(1);
    }
    
    console.log(`✅ Selected ${validChapters.length} unique chapters`);
    
    const englishCount = validChapters.filter(c => c._isEnglish).length;
    const otherCount = validChapters.length - englishCount;
    console.log(`   🇬🇧 English: ${englishCount} | 🌐 Other: ${otherCount}`);

    const workDir = join(process.cwd(), 'manga_download');
    const mangaDir = join(workDir, 'chapters');
    if (!existsSync(mangaDir)) mkdirSync(mangaDir, { recursive: true });

    // 📤 Telegram: Post manga title as main message
    let rootMessageId = null;
    if (useTelegram) {
      try {
        const titleMsg = `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
                        `<i>Starting download: ${validChapters.length} chapter(s) | ` +
                        `Data Saver: ${useDataSaver ? '✅' : '❌'}</i>\n` +
                        `<code>${mangaId}</code>`;
        rootMessageId = await sendText(telegramChatId, titleMsg);
        console.log('📤 Posted manga title to Telegram');
      } catch (err) {
        console.warn(`⚠️  Failed to post title to Telegram: ${err.message}`);
        useTelegram = false; // Fallback to local-only
      }
    }

    // 🔄 Process each chapter individually
    for (const [idx, chapter] of validChapters.entries()) {
      const chapNum = chapter._chapNum;
      const chapTitle = chapter.title ? ` - ${chapter.title}` : '';
      const langCode = chapter.translatedLanguage;
      const langTag = chapter._isEnglish ? '' : ` [${langCode}]`;
      
      const chapDirName = `Ch.${String(chapNum).padStart(4, '0')}${chapTitle}${langTag}`.substring(0, 120);
      const chapDir = join(mangaDir, sanitize(chapDirName));
      
      if (!existsSync(chapDir)) mkdirSync(chapDir, { recursive: true });
      console.log(`⬇️  Chapter ${idx + 1}/${validChapters.length}: ${chapDirName}`);

      // Update Telegram progress
      if (useTelegram && rootMessageId) {
        try {
          const progressText = `<b>📚 ${escapeHtml(mangaTitle)}</b>\n` +
                              `<i>Downloading chapter ${idx + 1}/${validChapters.length}...</i>\n` +
                              `<code>Ch.${chapNum}${escapeHtml(chapTitle || '')}</code>`;
          await editMessageText(telegramChatId, rootMessageId, progressText);
        } catch (e) {
          // Ignore progress update errors
        }
      }

      try {
        // Fetch full chapter data
        const fullChapter = await Chapter.get(chapter.id);
        
        // Get page URLs
        const pages = await fullChapter.getReadablePages({ useDataSaver });
        console.log(`   📄 ${pages.length} pages found`);

        // Download each page
        for (const [pageIdx, pageUrl] of pages.entries()) {
          const ext = pageUrl.split('.').pop().split('?')[0] || 'jpg';
          const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
          const destPath = join(chapDir, filename);
          await downloadImage(pageUrl, destPath);
        }
        
        // 🗜️ Create ZIP for THIS chapter only
        const chapZipName = `${safeTitle} - Ch.${String(chapNum).padStart(4, '0')}${langTag}.zip`;
        const chapZipPath = join(chapDir, '..', chapZipName);
        const zipSize = await createZip(chapDir, chapZipPath);
        console.log(`   🗜️  Chapter ZIP: ${(zipSize / 1024 / 1024).toFixed(2)} MB`);

        // 📤 Upload to Telegram as reply to manga title
        if (useTelegram && rootMessageId) {
          try {
            const langDisplay = langCode.toUpperCase();
            const caption = `📖 <b>Ch.${chapNum}</b>${escapeHtml(chapTitle ? ` - ${chapter.title}` : '')}\n` +
                           `🌐 ${langDisplay} | 📄 ${pages.length} pages | 💾 ${(zipSize/1024/1024).toFixed(1)} MB`;
            
            await sendDocument(
              telegramChatId,
              chapZipPath,
              chapZipName,
              caption,
              rootMessageId // 👈 Replies to the manga title message
            );
            console.log(`   ✅ Uploaded to Telegram`);
          } catch (uploadErr) {
            console.warn(`   ⚠️  Telegram upload failed: ${uploadErr.message}`);
          }
        }

        // 🧹 Clean up chapter folder to save disk space
        rmSync(chapDir, { recursive: true, force: true });
        console.log(`   🧹 Cleaned up temporary files`);
        
      } catch (chapErr) {
        console.error(`   ❌ Failed to process chapter: ${chapErr.message}`);
        // Continue with next chapter instead of failing entirely
      }
      
      // Throttle between chapters
      await new Promise(r => setTimeout(r, 1000));
    }

    // 📤 Final Telegram update
    if (useTelegram && rootMessageId) {
      try {
        const finalText = `<b>✅ ${escapeHtml(mangaTitle)}</b>\n` +
                         `<i>Download complete!</i>\n` +
                         `📦 ${validChapters.length} chapter(s) uploaded\n` +
                         `💾 Data Saver: ${useDataSaver ? 'ON' : 'OFF'}\n` +
                         `<code>${mangaId}</code>`;
        await editMessageText(telegramChatId, rootMessageId, finalText);
        console.log('📤 Final update posted to Telegram');
      } catch (e) {
        console.warn(`⚠️  Failed to post final update: ${e.message}`);
      }
    }

    console.log(`\n🎉 All done!`);
    console.log(`📁 Local output: ${mangaDir}`);
    if (useTelegram) {
      console.log(`📤 Telegram: Check your channel for uploaded chapters`);
    }
    
    // GitHub Actions compatibility (optional)
    console.log(`::set-output name=chapters_downloaded::${validChapters.length}`);
    writeFileSync(join(workDir, 'summary.txt'), 
      `Manga: ${mangaTitle}\nChapters: ${validChapters.length}\nCompleted: ${new Date().toISOString()}`);
    
  } catch (err) {
    console.error(`❌ Fatal Error: ${err.message}`);
    console.error(err.stack);
    
    // Notify Telegram of failure
    if (useTelegram && telegramChatId) {
      try {
        await sendText(telegramChatId, 
          `<b>❌ Download Failed</b>\n` +
          `<code>${escapeHtml(err.message)}</code>`,
          null
        );
      } catch (e) {
        // Ignore notification errors
      }
    }
    
    process.exit(1);
  }
}

main();
