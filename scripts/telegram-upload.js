#!/usr/bin/env node
import fetch from 'node-fetch';
import FormData from 'form-data';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_SPLIT_SIZE = 45 * 1024 * 1024; // 45MB safe

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function telegramRequest(endpoint, data, isFile = false) {
  const url = `${API_BASE}/${endpoint}`;
  
  let body, headers;
  
  if (isFile) {
    const form = new FormData();
    for (const [key, value] of Object.entries(data)) {
      form.append(key, value);
    }
    body = form;
    headers = form.getHeaders();
  } else {
    body = JSON.stringify(data);
    headers = { 'Content-Type': 'application/json' };
  }
  
  const res = await fetch(url, { method: 'POST', headers, body });
  const json = await res.json();
  
  if (!json.ok) throw new Error(`Telegram API: ${json.description}`);
  return json.result;
}

function splitFile(filePath, maxChunkSize) {
  const buffer = readFileSync(filePath);
  const chunks = [];
  let offset = 0;
  
  while (offset < buffer.length) {
    const chunk = buffer.slice(offset, offset + maxChunkSize);
    chunks.push(chunk);
    offset += maxChunkSize;
  }
  
  return chunks;
}

async function sendMetadata(metadata) {
  const coverArtPath = metadata.coverArtPath;
  let photoBuffer = null;
  
  if (coverArtPath && existsSync(coverArtPath)) {
    photoBuffer = readFileSync(coverArtPath);
  }
  
  const chapterRange = metadata.bundles.length > 0 
    ? `Ch.${String(metadata.bundles[0].startChapter).padStart(4, '0')}-${String(metadata.bundles[metadata.bundles.length - 1].endChapter).padStart(4, '0')}`
    : 'N/A';
  
  const caption = `📚 *${metadata.title}*

👤 **Author:** ${metadata.author}
🎨 **Artist:** ${metadata.artist}
📅 **Year:** ${metadata.year}
📊 **Status:** ${metadata.status}
🌐 **Language:** ${metadata.originalLanguage}
⚠️ **Rating:** ${metadata.contentRating}

📖 **Chapters:** ${chapterRange} (${metadata.chapterCount} chapters → ${metadata.bundleCount} bundles)
💾 **Quality:** ${metadata.useDataSaver ? 'Data Saver' : 'Original'}
📥 **Downloaded:** ${new Date(metadata.downloadDate).toLocaleDateString()}

🏷️ **Genres:** ${metadata.genres}
🎭 **Themes:** ${metadata.themes}
🏷️ **Tags:** ${metadata.tags}

📝 **Description:**
${metadata.description}

─────────────────
_Chapter bundles will be uploaded as replies below_`;

  console.log('📤 Sending metadata message...');
  
  let message;
  if (photoBuffer) {
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('photo', photoBuffer, { filename: 'cover.jpg' });
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    
    message = await telegramRequest('sendPhoto', form, true);
  } else {
    message = await telegramRequest('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      text: caption,
      parse_mode: 'Markdown'
    });
  }
  
  console.log(`✅ Metadata sent (message_id: ${message.message_id})`);
  return message.message_id;
}

async function sendBundleZip(zipPath, zipName, parentId, partNum = null, totalParts = null) {
  const fileBuffer = readFileSync(zipPath);
  const fileSize = fileBuffer.length;
  
  let displayName = zipName;
  if (totalParts > 1) {
    displayName = `${zipName} (Part ${partNum}/${totalParts})`;
  }
  
  const caption = `📖 **${displayName}**
💾 Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`;

  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);
  form.append('document', fileBuffer, { filename: displayName });
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('reply_to_message_id', parentId);
  
  const message = await telegramRequest('sendDocument', form, true);
  console.log(`   ✅ Uploaded: ${displayName}`);
  
  return message.message_id;
}

async function sendSplitBundle(zipPath, zipName, parentId) {
  const chunks = splitFile(zipPath, MAX_SPLIT_SIZE);
  const totalParts = chunks.length;
  
  console.log(`   📦 Splitting into ${totalParts} parts...`);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = join(process.cwd(), 'temp', `chunk_${i}.tmp`);
    writeFileSync(chunkPath, chunks[i]);
    
    await sendBundleZip(chunkPath, zipName, parentId, i + 1, totalParts);
    unlinkSync(chunkPath);
    
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function sendArtwork(artworkFiles, parentId) {
  if (!artworkFiles || artworkFiles.length === 0) {
    console.log('🎨 No artwork to upload');
    return;
  }
  
  console.log(`🎨 Uploading ${artworkFiles.length} artwork images...`);
  
  for (const [idx, artPath] of artworkFiles.entries()) {
    if (!existsSync(artPath)) continue;
    
    const fileBuffer = readFileSync(artPath);
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('photo', fileBuffer, { filename: `art_${idx + 1}.jpg` });
    form.append('caption', `🎨 Artwork ${idx + 1}/${artworkFiles.length}`);
    form.append('reply_to_message_id', parentId);
    
    await telegramRequest('sendPhoto', form, true);
    console.log(`   ✅ Artwork ${idx + 1} uploaded`);
    
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function main() {
  const workDir = join(process.cwd(), 'temp');
  const metadataPath = join(workDir, 'metadata.json');
  
  if (!existsSync(metadataPath)) {
    console.error('❌ metadata.json not found. Run download.js first.');
    process.exit(1);
  }
  
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  console.log(`📚 Uploading: ${metadata.title}`);
  console.log(`📦 Bundles: ${metadata.bundleCount}`);
  
  try {
    // Step 1: Send metadata with cover art
    const parentId = await sendMetadata(metadata);
    
    // Step 2: Send artwork if enabled
    if (metadata.uploadArtwork && metadata.artworkFiles.length > 0) {
      await sendArtwork(metadata.artworkFiles, parentId);
    }
    
    // Step 3: Send each bundle
    for (const [idx, bundle] of metadata.bundles.entries()) {
      console.log(`⬆️  Bundle ${idx + 1}/${metadata.bundleCount}: ${bundle.zipName}`);
      
      const fileSize = bundle.size;
      
      if (fileSize > MAX_FILE_SIZE) {
        console.log(`   ⚠️  File too large (${(fileSize / 1024 / 1024).toFixed(2)} MB), splitting...`);
        await sendSplitBundle(bundle.zipPath, bundle.zipName, parentId);
      } else {
        await sendBundleZip(bundle.zipPath, bundle.zipName, parentId);
      }
      
      await new Promise(r => setTimeout(r, 1500));
    }
    
    console.log('✅ All uploads complete!');
    
    // Cleanup
    unlinkSync(metadataPath);
    if (metadata.coverArtPath && existsSync(metadata.coverArtPath)) {
      unlinkSync(metadata.coverArtPath);
    }
    
  } catch (err) {
    console.error(`❌ Upload error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
