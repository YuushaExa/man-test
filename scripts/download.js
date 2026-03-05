#!/usr/bin/env node
import { Manga, Chapter, Cover, Author } from 'mangadex-full-api';
import fetch from 'node-fetch';
import { createWriteStream, mkdirSync, existsSync, rmSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import { join } from 'path';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent'; 

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 2;

const PROXY_LIST = [
    'http://20.205.138.223:443',
    'http://47.243.181.85:41134',
    'http://84.17.47.147:9002'
];
let proxyIndex = 0;

function getNextProxy() {
    if (PROXY_LIST.length === 0) return null;
    const proxy = PROXY_LIST[proxyIndex % PROXY_LIST.length];
    proxyIndex++;
    return proxy;
}

// 🔐 Debug log
console.log(`🔐 PROXY_LIST: ${PROXY_LIST.length} proxies loaded (hardcoded)`);
// ─────────────────────────────────────────────────────────────
// 🖼️ Send multiple local photos as Telegram album (media group)
// ─────────────────────────────────────────────────────────────
async function sendMediaGroupWithLocalFiles(chatId, filePaths, replyToMessageId = null, caption = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN || filePaths.length === 0) {
    console.warn('⚠️ Cannot send album: missing token or no files');
    return null;
  }
  
  const MAX_MEDIA = 10;
  const filesToSend = filePaths.slice(0, MAX_MEDIA);
  
  console.log(`📤 Sending ${filesToSend.length} images as album...`);
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
      
      const media = filesToSend.map((path, idx) => {
        const attachId = `cover_${idx}`;
        const item = {
          type: 'photo',
          media: `attach://${attachId}`,
          parse_mode: 'HTML'
        };
        if (idx === 0 && caption) {
          item.caption = caption.substring(0, 1024);
        }
        return item;
      });
      
      form.append('media', JSON.stringify(media));
      
      for (const [idx, path] of filesToSend.entries()) {
        const attachId = `cover_${idx}`;
        form.append(attachId, await fileFromPath(path), `cover_${idx}.jpg`);
      }
      
      const res = await fetch(`${TELEGRAM_API}/sendMediaGroup`, { 
        method: 'POST', 
        body: form,
        timeout: 120000
      });
      
      const data = await res.json();
      if (data.ok) {
        console.log('✅ Album sent successfully');
        return data;
      }
      
      console.warn(`⚠️ Telegram API error: ${data.description}`);
      
      if (data.description?.includes('Too Many Requests')) {
        const retryAfter = data.description.match(/retry after (\d+)/)?.[1] || 3;
        await new Promise(r => setTimeout(r, Math.min(parseInt(retryAfter) * 1000, 10000)));
      } else if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    } catch (err) {
      console.warn(`⚠️ sendMediaGroup attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 🖼️ Thumbnail creation
// ─────────────────────────────────────────────────────────────
async function createThumbnail(sourcePath, destPath) {
  try {
    await sharp(sourcePath)
      .resize(108, 108)
      .jpeg({ quality: 80 })
      .toFile(destPath);
    return destPath;
  } catch (err) {
    console.warn(`⚠️ Thumbnail creation failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 📥 Download single file with retry
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// 🔐 Calculate file hash for deduplication
// ─────────────────────────────────────────────────────────────
async function getFileHash(filePath) {
  const { readFile } = await import('fs/promises');
  const data = await readFile(filePath);
  return createHash('md5').update(data).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// 📤 Send single document with thumbnail
// ─────────────────────────────────────────────────────────────
async function sendDocumentWithThumb(chatId, filePath, fileName, caption, replyToMessageId, thumbPath) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', await fileFromPath(filePath), fileName);
      if (caption) form.append('caption', caption.substring(0, 1024));
      if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
      
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
        await new Promise(r => setTimeout(r, Math.min(parseInt(retryAfter) * 1000, 10000)));
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

// ─────────────────────────────────────────────────────────────
// 💬 Send text message
// ─────────────────────────────────────────────────────────────
async function sendText(chatId, text, replyToMessageId = null, disablePreview = true) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot send text: missing bot token');
    return null;
  }
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
    if (data.ok) {
      console.log('✅ Text message sent successfully');
      return data.result?.message_id;
    }
    console.warn(`⚠️ Telegram API error: ${data.description}`);
    return null;
  } catch (err) {
    console.warn(`⚠️ sendText failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 🔤 HTML escape & sanitize helpers
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

function formatChapNum(num) {
  return Number.isInteger(num) ? num.toString() : num.toFixed(1).replace(/\.0$/, '');
}

// ─────────────────────────────────────────────────────────────
// 🌏 Format alt titles - JP/CN only
// ─────────────────────────────────────────────────────────────
function formatAltTitles(altTitles, limit = 3) {
  if (!altTitles || altTitles.length === 0) return null;
  
  const filtered = altTitles.filter(t => {
    const lang = Object.keys(t)[0]?.toLowerCase();
    return ['ja', 'jp'].includes(lang) || ['zh', 'cn', 'zh-cn', 'zh-tw'].includes(lang);
  });
  
  const titles = filtered
    .map(t => {
      const lang = Object.keys(t)[0].toLowerCase();
      const title = t[lang];
      if (['ja', 'jp'].includes(lang)) return `[JP] ${title}`;
      else if (['zh-tw'].includes(lang)) return `[CN-TW] ${title}`;
      else return `[CN] ${title}`;
    })
    .slice(0, limit);
  
  return titles.length > 0 ? titles.join(' • ') : null;
}

// ─────────────────────────────────────────────────────────────
// 🌐 Get localized name (for Manga titles, descriptions, etc.)
// ─────────────────────────────────────────────────────────────
function getLocalizedName(localized, lang = 'en') {
  if (!localized) return 'Unknown';
  if (typeof localized === 'object') {
    return localized[lang] || localized['en'] || Object.values(localized)[0] || 'Unknown';
  }
  return localized || 'Unknown';
}

// ─────────────────────────────────────────────────────────────
// ✅ Resolve author/artist IDs to names
// ─────────────────────────────────────────────────────────────
async function resolveRelationshipNames(relationships, type = 'author') {
  if (!relationships || relationships.length === 0) return [];
  
  const names = [];
  const idsToFetch = [];
  
  for (const rel of relationships) {
    if (rel.attributes && rel.attributes.name) {
      const name = rel.attributes.name;
      if (name && name.trim()) {
        names.push(name.trim());
      }
    } else if (rel.id) {
      idsToFetch.push(rel.id);
    }
  }
  
  if (idsToFetch.length > 0) {
    console.log(`📥 Fetching ${idsToFetch.length} ${type}(s)...`);
    const fetched = await Promise.all(
      idsToFetch.map(id => Author.get(id).catch(() => null))
    );
    
    for (const author of fetched) {
      if (author && author.name) {
        const name = author.name.trim();
        if (name && name !== 'Unknown') {
          names.push(name);
        }
      }
    }
  }
  
  return [...new Set(names)];
}

// ─────────────────────────────────────────────────────────────
// 📥 Download chapter pages with concurrency + PROXY
// ─────────────────────────────────────────────────────────────
async function downloadPages(pages, chapDir) {

  console.log(`📥 Downloading ${pages.length} pages...`);
  console.log(`🔗 Sample URLs:`);
  pages.slice(0, 3).forEach((url, i) => {
    console.log(`   Page ${i + 1}: ${url.substring(0, 100)}...`);
  });
  
const downloadPage = async (pageUrl, pageIdx) => {
    const ext = pageUrl.split('.').pop()?.split('?')[0] || 'jpg';
    const filename = `${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
    const destPath = join(chapDir, filename);
    
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // ✅ Increased to 60s
            
            const proxyUrl = getNextProxy();
            const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
            
            // 🔐 Debug log
            console.log(`🔄 Using proxy: ${proxyUrl || 'direct'}`);
            
            const res = await fetch(pageUrl, {
                signal: controller.signal,
                headers: { 'User-Agent': 'MangaBot/1.0' },
                agent // ✅ Add proxy agent
            });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            if (!res.body) throw new Error('Empty response body');
            
            const writer = createWriteStream(destPath);
            await pipeline(res.body, writer);
            
            const stats = statSync(destPath);
            if (stats.size < 1024) throw new Error('File too small');
            
            return true;
        } catch (err) {
            console.warn(`⚠️ Page ${pageIdx + 1} attempt ${attempt + 1} failed: ${err.message}`);
            if (attempt === 2) {
                console.error(`❌ Giving up on page ${pageIdx + 1}: ${pageUrl}`);
                throw new Error(`Failed page ${pageIdx + 1}: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt))); // ✅ Slower retries
        }
    }
};

  for (let i = 0; i < pages.length; i += MAX_CONCURRENT_PAGES) {
    const batch = pages.slice(i, i + MAX_CONCURRENT_PAGES);
    await Promise.all(batch.map((url, idx) => downloadPage(url, i + idx)));
  }
}

// ─────────────────────────────────────────────────────────────
// 🗜️ Create ZIP archive
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// 📚 Select best chapters (English priority)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// 📤 Send manga info with covers (SUPPORTS MULTIPLE POSTS)
// ─────────────────────────────────────────────────────────────
async function sendMangaInfo(telegramChatId, mangaTitle, authors, artists, originalLanguage, 
                              altTitles, validChapters, status, year, genres, themes, 
                              description, coverPaths) {
  console.log('\n📤 === SENDING MANGA INFO TO TELEGRAM ===');
  
  if (!telegramChatId) {
    console.error('❌ TELEGRAM_CHAT_ID not set');
    return null;
  }
  
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  
  const genresStr = genres.length > 0 ? genres.join(', ') : 'N/A';
  const themesStr = themes.length > 0 ? themes.join(', ') : null;
  
  // ✅ Truncate description to fit within caption limit
  const maxDescLength = 100;
  const truncatedDesc = description.length > maxDescLength 
    ? description.substring(0, maxDescLength).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])) + '...' 
    : escapeHtml(description);
  
  // ✅ Build caption SAFELY
  const CAPTION_LIMIT = 900;
  let infoText = `<b>${escapeHtml(mangaTitle)}</b>\n\n`;
  
  const sections = [];
  
  if (authors.length) {
    sections.push(`<b>📝 Author:</b> ${escapeHtml(authors.slice(0, 5).join(', '))}${authors.length > 5 ? '...' : ''}`);
  }
  if (artists.length) {
    sections.push(`<b>🎨 Artist:</b> ${escapeHtml(artists.slice(0, 5).join(', '))}${artists.length > 5 ? '...' : ''}`);
  }
  sections.push(`<b>🌐 Original Language:</b> <code>${originalLanguage}</code>`);
  
  if (altTitles) {
    sections.push(`<b>Also known as:</b> <i>${escapeHtml(altTitles)}</i>`);
  }
  
  sections.push(`<b>📖 Chapters:</b> ${validChapters.length} (${escapeHtml(status)})`);
  sections.push(`<b>📅 Year:</b> ${year}`);
  sections.push(`<b>🏷️ Genres:</b> <code>${escapeHtml(genresStr)}</code>`);
  
  if (themesStr) {
    sections.push(`<b>✨ Themes:</b> <code>${escapeHtml(themesStr)}</code>`);
  }
  
  sections.push(`<b>📄 Description</b>\n<blockquote><i>${truncatedDesc}</i></blockquote>`);
  
  if (validChapters.length === 0) {
    sections.push(`⚠️ <i>No downloadable chapters available</i>`);
  }
  
  // ✅ Build caption with length checking
  for (const section of sections) {
    const testText = infoText + section + '\n';
    if (testText.length > CAPTION_LIMIT) {
      console.log(`⚠️ Stopped adding sections at ${infoText.length} chars (limit: ${CAPTION_LIMIT})`);
      break;
    }
    infoText = testText;
  }
  
  infoText = ensureClosedTags(infoText);
  console.log(`📝 Caption length: ${infoText.length} characters`);
  
  let rootMessageId = null;
  
  try {
    if (coverPaths.length === 0) {
      // ✅ No covers - send text only
      console.log('📤 No covers, sending text only...');
      rootMessageId = await sendText(telegramChatId, infoText, null, false);
    } else if (coverPaths.length <= 10) {
      // ✅ 1-10 covers - send single album/photo
      if (coverPaths.length === 1) {
        console.log('📤 Sending single cover with caption...');
        const form = new FormData();
        form.append('chat_id', telegramChatId);
        form.append('photo', await fileFromPath(coverPaths[0]), 'cover.jpg');
        form.append('caption', infoText);
        form.append('parse_mode', 'HTML');
        
        const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
        const data = await res.json();
        if (data.ok) {
          rootMessageId = data.result?.message_id;
          console.log('✅ Posted manga info with single cover');
        } else {
          console.error(`❌ sendPhoto failed: ${data.description}`);
          rootMessageId = await sendText(telegramChatId, infoText, null, false);
        }
      } else {
        console.log(`📤 Sending album with ${coverPaths.length} covers...`);
        const albumResult = await sendMediaGroupWithLocalFiles(
          telegramChatId, 
          coverPaths, 
          null, 
          infoText
        );
        if (albumResult?.ok) {
          rootMessageId = albumResult.result[0]?.message_id;
          console.log('✅ Posted manga info with cover album');
        } else {
          console.error('❌ sendMediaGroup failed');
          rootMessageId = await sendText(telegramChatId, infoText, null, false);
        }
      }
    } else {
      // ✅ 11+ covers - send MULTIPLE albums
      console.log(`📤 Sending ${coverPaths.length} covers in multiple posts...`);
      
      const MAX_PER_ALBUM = 10;
      const totalPosts = Math.ceil(coverPaths.length / MAX_PER_ALBUM);
      
      for (let i = 0; i < coverPaths.length; i += MAX_PER_ALBUM) {
        const batch = coverPaths.slice(i, i + MAX_PER_ALBUM);
        const postNum = Math.floor(i / MAX_PER_ALBUM) + 1;
        const isLastPost = (postNum === totalPosts);
        
        // Caption only on first post
        const caption = (postNum === 1) ? infoText : `<b>${escapeHtml(mangaTitle)}</b> - Part ${postNum}/${totalPosts}`;
        
        // Reply to first post (except first post itself)
        const replyTo = (postNum === 1) ? null : rootMessageId;
        
        console.log(`📤 Sending post ${postNum}/${totalPosts} with ${batch.length} covers...`);
        
        let result;
        if (batch.length === 1) {
          const form = new FormData();
          form.append('chat_id', telegramChatId);
          form.append('photo', await fileFromPath(batch[0]), `cover_${i}.jpg`);
          form.append('caption', caption);
          form.append('parse_mode', 'HTML');
          if (replyTo) form.append('reply_to_message_id', String(replyTo));
          
          const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
          result = await res.json();
        } else {
          result = await sendMediaGroupWithLocalFiles(
            telegramChatId, 
            batch, 
            replyTo, 
            caption
          );
        }
        
        if (result?.ok) {
          if (postNum === 1) {
            rootMessageId = result.result?.[0]?.message_id || result.result?.message_id;
            console.log(`✅ Post ${postNum}/${totalPosts} sent (root message)`);
          } else {
            console.log(`✅ Post ${postNum}/${totalPosts} sent (reply to root)`);
          }
        } else {
          console.error(`❌ Post ${postNum}/${totalPosts} failed: ${result?.description}`);
        }
        
        // Rate limit protection
        if (i + MAX_PER_ALBUM < coverPaths.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error sending manga info: ${err.message}`);
    rootMessageId = await sendText(telegramChatId, infoText, null, false);
  }
  
  if (rootMessageId) {
    console.log(`✅ Manga info sent successfully (message_id: ${rootMessageId})`);
  } else {
    console.error('❌ Failed to send manga info');
  }
  
  console.log('📤 === END MANGA INFO ===\n');
  
  return rootMessageId;
}

// ─────────────────────────────────────────────────────────────
// 🔒 Ensure all HTML tags are properly closed
// ─────────────────────────────────────────────────────────────
function ensureClosedTags(text) {
  // Simple check for common Telegram HTML tags
  const tagPairs = [
    ['<b>', '</b>'],
    ['<i>', '</i>'],
    ['<code>', '</code>'],
    ['<blockquote>', '</blockquote>'],
    ['<pre>', '</pre>'],
    ['<a>', '</a>'],
    ['<s>', '</s>'],
    ['<u>', '</u>'],
    ['<span>', '</span>'],
  ];
  
  for (const [openTag, closeTag] of tagPairs) {
    const openCount = (text.match(new RegExp(openTag.replace(/[<>]/g, '\\$&'), 'g')) || []).length;
    const closeCount = (text.match(new RegExp(closeTag.replace(/[<>]/g, '\\$&'), 'g')) || []).length;
    
    // Add missing closing tags
    for (let i = 0; i < openCount - closeCount; i++) {
      text += closeTag;
    }
  }
  
  return text;
}

// ─────────────────────────────────────────────────────────────
// 🚀 MAIN FUNCTION
// ─────────────────────────────────────────────────────────────
async function main() {
  const mangaInput = process.env.MANGA_INPUT;
  const useDataSaver = process.env.USE_DATA_SAVER === 'true';
  const maxChapters = parseInt(process.env.MAX_CHAPTERS || '10', 10);
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!mangaInput) { console.error('❌ MANGA_INPUT not set'); process.exit(1); }

  const mangaId = mangaInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || mangaInput.trim();
  
  console.log(`📚 Manga ID: ${mangaId}`);
  try {
    const manga = await Manga.get(mangaId, {
      authors: true,
      artists: true,
      tags: true
    });
    
    if (!manga) throw new Error('Manga not found');
    
    const mangaTitle = manga.localTitle || getLocalizedName(manga.title);
    const safeTitle = sanitize(mangaTitle);
    const description = getLocalizedName(manga.description) || 'No description';
    
    console.log('📥 Resolving authors...');
    const authors = await resolveRelationshipNames(manga.authors, 'author');
    
    console.log('📥 Resolving artists...');
    const artists = await resolveRelationshipNames(manga.artists, 'artist');
    
    const originalLanguage = manga.originalLanguage?.toUpperCase() || 'N/A';
    
    const genres = (manga.tags || [])
      .filter(t => t.group === 'genre')
      .map(t => getLocalizedName(t.name))
      .filter(n => n && n !== 'Unknown');
    
    const themes = (manga.tags || [])
      .filter(t => t.group === 'theme')
      .map(t => getLocalizedName(t.name))
      .filter(n => n && n !== 'Unknown');
    
    const status = manga.status ? manga.status.charAt(0).toUpperCase() + manga.status.slice(1) : 'Unknown';
    const year = manga.year || 'N/A';
    const altTitles = formatAltTitles(manga.altTitles);
    
    console.log(`📝 Authors: ${authors.join(', ') || 'Unknown'}`);
    console.log(`🎨 Artists: ${artists.join(', ') || 'Unknown'}`);
    // 📥 Fetch ALL covers from MangaDex
console.log('📥 Fetching all covers...');
const allCovers = await Cover.getMangaCovers(mangaId);        
    // ✅ First: Try to get volume covers (skip main)
const seenFileNames = new Set();
let volumeCovers = allCovers
  .filter(c => c?.fileName && c.volume !== null)
  .filter(c => {
    if (seenFileNames.has(c.fileName)) {
      console.log(`⚠️ Skipping duplicate fileName: ${c.fileName}`);
      return false;
    }
    seenFileNames.add(c.fileName);
    return true;
  })
  .sort((a, b) => {
    return parseFloat(a.volume) - parseFloat(b.volume);
  });

console.log(`📥 Found ${volumeCovers.length} volume cover(s)`);

// ✅ FALLBACK: If no volume covers, use main cover
let usingMainCover = false;
if (volumeCovers.length === 0) {
  console.log('⚠️ No volume covers found, falling back to main cover...');
  
  const mainCovers = allCovers
    .filter(c => c?.fileName && c.volume === null)
    .filter(c => {
      if (seenFileNames.has(c.fileName)) {
        return false;
      }
      seenFileNames.add(c.fileName);
      return true;
    });
  
  if (mainCovers.length > 0) {
    volumeCovers = mainCovers;
    usingMainCover = true;
    console.log(`✅ Found ${mainCovers.length} main cover(s) as fallback`);
  } else {
    console.warn('⚠️ No covers found at all (neither volume nor main)');
  }
}

// Log cover details
volumeCovers.forEach((c, i) => {
  console.log(`  Cover ${i + 1}: ${c.fileName} (volume: ${c.volume || 'main'})`);
});

const workDir = join(process.cwd(), 'manga_download');
mkdirSync(workDir, { recursive: true });

// Download covers with hash-based deduplication
const coverPaths = [];
const seenHashes = new Set();
const thumbPath = join(workDir, 'thumb.jpg');

const maxCoversToDownload = Math.min(volumeCovers.length, 10);

for (let i = 0; i < maxCoversToDownload; i++) {
  const cover = volumeCovers[i];
  const coverUrl = `https://uploads.mangadex.org/covers/${mangaId}/${cover.fileName}`;
  const coverPath = join(workDir, `cover_${i}.jpg`);
  
  console.log(`📥 Downloading cover ${i + 1}/${maxCoversToDownload}: ${cover.fileName}`);
  const result = await downloadCover(coverUrl, coverPath);
  
  if (result) {
    const stats = statSync(result);
    if (stats.size > 1000) {
      const hash = await getFileHash(result);
      
      if (seenHashes.has(hash)) {
        console.warn(`  ⚠️ Duplicate image detected (hash: ${hash.substring(0, 8)}...), skipping`);
        rmSync(result, { force: true });
      } else {
        seenHashes.add(hash);
        coverPaths.push(result);
        console.log(`  ✅ Downloaded (${(stats.size / 1024).toFixed(1)} KB, hash: ${hash.substring(0, 8)}...)`);
        
        if (coverPaths.length === 1) {
          console.log('🖼️ Creating thumbnail...');
          await createThumbnail(result, thumbPath);
        }
      }
    } else {
      console.warn(`  ⚠️ File too small, skipping: ${result}`);
      rmSync(result, { force: true });
    }
  }
  
  await new Promise(r => setTimeout(r, 150));
}

console.log(`📊 Total unique covers downloaded: ${coverPaths.length}`);
    
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
    console.log(`✅ ${validChapters.length} chapters selected`);
    
    // ✅ ALWAYS send manga info + cover album FIRST (before chapter check)
    console.log('\n📢 === SENDING MANGA INFO (BEFORE CHAPTER CHECK) ===');
    const rootMessageId = await sendMangaInfo(
      telegramChatId,
      mangaTitle,
      authors,
      artists,
      originalLanguage,
      altTitles,
      validChapters,
      status,
      year,
      genres,
      themes,
      description,
      coverPaths
    );
    
    // ⚠️ If no chapters, stop here (info already sent)
    if (validChapters.length === 0) { 
      console.warn('\n⚠️ No chapters found, but manga info WAS posted');
      console.log('🧹 Cleaning up temporary files...');
      rmSync(workDir, { recursive: true, force: true });
      console.log('✅ Done!');
      process.exit(0);
    }
    
    // Continue with chapter downloads if chapters exist
    console.log('\n📚 === PROCESSING CHAPTERS ===');
    const mangaDir = join(workDir, 'chapters');
    const bundleDir = join(workDir, 'bundles');
    mkdirSync(mangaDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    
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
      console.log(`Part ${bundleIdx + 1}/${bundles.length} (Ch.${bundleStart}-${bundleEnd}, ${(bundleSize/1024/1024).toFixed(1)} MB)`);
      
      if (rootMessageId && telegramChatId) {
        const caption = `Part: ${bundleIdx + 1}/${bundles.length}`;
        await sendDocumentWithThumb(telegramChatId, bundleZipPath, bundleZipName, caption, rootMessageId, thumbPath);
      }
      
      rmSync(bundleZipPath, { force: true });
    };
    
    for (let i = 0; i < bundles.length; i += 2) {
      const batch = bundles.slice(i, i + 2);
      await Promise.all(batch.map((b, idx) => uploadBundle(b, i + idx)));
      if (i + 2 < bundles.length) await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log('\n✅ All bundles uploaded');
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
