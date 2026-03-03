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

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 4;

// ─────────────────────────────────────────────────────────────
// 🖼️ Send multiple local photos as Telegram album (media group)
// ─────────────────────────────────────────────────────────────
async function sendMediaGroupWithLocalFiles(chatId, filePaths, replyToMessageId = null, caption = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN || filePaths.length === 0) return null;
  
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
      .resize(54, 54)
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
// 🔐 Calculate file hash for duplicate detection
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
    return data.ok ? data.result?.message_id : null;
  } catch { return null; }
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
// 📥 Download chapter pages with concurrency
// ─────────────────────────────────────────────────────────────
async function downloadPages(pages, chapDir) {
  const downloadPage = async (pageUrl, pageIdx) => {
    const ext = pageUrl.split('.').pop()?.split('?')[0] || 'jpg';
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
    
    // 📥 Fetch chapters FIRST (before covers)
    console.log('📥 Fetching chapters...');
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
    
    // ✅ Skip everything if no chapters found
    if (validChapters.length === 0) {
      console.warn('⚠️ No chapters found - skipping Telegram message and download');
      process.exit(0);
    }
    
    console.log(`✅ ${validChapters.length} chapters selected`);
    
    // 📥 Fetch ALL covers from MangaDex
    console.log('📥 Fetching all covers...');
    const allCovers = await Cover.getMangaCovers(mangaId);
    
    // ✅ FIXED: Skip main cover (volume === null), only keep volume covers
    const seenHashes = new Set();
    const validCovers = allCovers
      .filter(c => c?.fileName)
      .filter(c => {
        // ✅ Skip main cover (no volume)
        if (c.volume === null || c.volume === undefined) {
          console.log(`⚠️ Skipping main cover: ${c.fileName}`);
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Sort by volume number
        if (a.volume !== null && b.volume !== null) {
          return parseFloat(a.volume) - parseFloat(b.volume);
        }
        return 0;
      });
    
    console.log(`📥 Found ${validCovers.length} volume cover(s)`);
    
    const workDir = join(process.cwd(), 'manga_download');
    mkdirSync(workDir, { recursive: true });
    
    // Download covers with hash-based deduplication
    const coverPaths = [];
    const thumbPath = join(workDir, 'thumb.jpg');
    const maxCoversToDownload = Math.min(validCovers.length, 10);
    
    for (let i = 0; i < maxCoversToDownload; i++) {
      const cover = validCovers[i];
      const coverUrl = `https://uploads.mangadex.org/covers/${mangaId}/${cover.fileName}`;
      const coverPath = join(workDir, `cover_${i}.jpg`);
      
      console.log(`📥 Downloading cover ${i + 1}/${maxCoversToDownload} (Vol.${cover.volume}): ${cover.fileName}`);
      const result = await downloadCover(coverUrl, coverPath);
      
      if (result) {
        const stats = statSync(result);
        if (stats.size > 1000) {
          // ✅ Check file hash to detect actual duplicates
          const hash = await getFileHash(result);
          if (seenHashes.has(hash)) {
            console.log(`  ⚠️ Duplicate content detected (hash: ${hash.substring(0, 8)}...), skipping`);
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
        }
      }
      
      await new Promise(r => setTimeout(r, 150));
    }
    
    console.log(`📊 Total unique covers downloaded: ${coverPaths.length}`);
    
    // 📤 Post manga info with cover album
    let rootMessageId = null;
    if (telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      const genresStr = genres.length > 0 ? genres.join(', ') : 'N/A';
      const themesStr = themes.length > 0 ? themes.join(', ') : null;
      const truncatedDesc = description.length > 800 
        ? description.substring(0, 800) + '...' 
        : description;
      
      let infoText = `<b>${escapeHtml(mangaTitle)}</b>\n\n`;
      
      if (authors.length) infoText += `<b>📝 Author:</b> ${escapeHtml(authors.join(', '))}\n`;
      if (artists.length) infoText += `<b>🎨 Artist:</b> ${escapeHtml(artists.join(', '))}\n`;
      infoText += `<b>🌐 Original Language:</b> <code>${originalLanguage}</code>\n`;
      
      if (altTitles) infoText += `<b>Also known as:</b> <i>${escapeHtml(altTitles)}</i>\n`;
      
      infoText += 
        `<b>📖 Chapters:</b> ${validChapters.length} (${escapeHtml(status)})\n` +
        `<b>📅 Year:</b> ${year}\n` +
        `<b>🏷️ Genres:</b> <code>${escapeHtml(genresStr)}</code>\n`;
      
      if (themesStr) {
        infoText += `<b>✨ Themes:</b> <code>${escapeHtml(themesStr)}</code>\n`;
      }
      
      infoText += `\n<b>📄 Description</b>\n<blockquote><i>${escapeHtml(truncatedDesc)}</i></blockquote>`;
      
      if (coverPaths.length === 0) {
        rootMessageId = await sendText(telegramChatId, infoText, null, false);
      } else if (coverPaths.length === 1) {
        const form = new FormData();
        form.append('chat_id', telegramChatId);
        form.append('photo', await fileFromPath(coverPaths[0]), 'cover.jpg');
        form.append('caption', infoText);
        form.append('parse_mode', 'HTML');
        
        const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
        const data = await res.json();
        if (data.ok) {
          rootMessageId = data.result?.message_id;
          console.log('📤 Posted manga info with single cover');
        }
      } else {
        const albumResult = await sendMediaGroupWithLocalFiles(
          telegramChatId, 
          coverPaths, 
          null, 
          infoText
        );
        if (albumResult?.ok) {
          rootMessageId = albumResult.result[0]?.message_id;
          console.log('📤 Posted manga info with cover album');
        }
      }
    }
    
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
