// scripts/telegram.js
import fetch from 'node-fetch';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Send a text message and return its message_id
export async function sendText(chatId, text, replyToMessageId = null) {
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
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.message_id;
}

// Send a ZIP file as a document
export async function sendDocument(chatId, filePath, fileName, caption = '', replyToMessageId = null) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', {
    [Symbol.toStringTag]: 'File',
    name: fileName,
    type: 'application/zip',
    stream: () => require('fs').createReadStream(filePath)
  }, fileName);
  
  if (caption) form.append('caption', caption);
  if (replyToMessageId) form.append('reply_to_message_id', replyToMessageId);
  
  // node-fetch v3 + FormData requires node >= 18 + --experimental-global-webcrypto or use formdata-node
  const res = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: form
  });
  
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.message_id;
}

// Edit an existing message (e.g., update progress)
export async function editMessageText(chatId, messageId, text) {
  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML'
    })
  });
  return res.json();
}
