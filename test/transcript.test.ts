import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTranscript } from '../src/transcript.js';

const TICKET = {
  ticketId: '0001',
  creatorUsername: 'tester',
  creatorId: 'user_1',
  reason: 'test',
  createdAt: new Date().toISOString(),
  status: 'closed',
};

function render(content: string): string {
  return renderMessages([
    { id: 'm1', authorId: 'user_1', username: 'tester', content, createdAt: new Date().toISOString() },
  ]);
}

function renderMessages(messages: any[], options: any = {}): string {
  return generateTranscript(TICKET, messages, options);
}

function renderMsg(msg: any): string {
  return renderMessages([{ id: 'm1', authorId: 'user_1', username: 'tester', createdAt: new Date().toISOString(), ...msg }]);
}

test('markdown javascript: links are neutralized', () => {
  const html = render('[click](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(html), 'no javascript: href should survive');
});

test('vbscript: and data:text/html schemes are neutralized', () => {
  const html = render('[a](vbscript:msgbox) and [b](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/href="vbscript:/i.test(html));
  assert.ok(!/href="data:text\/html/i.test(html));
});

test('raw <script> in user content does not become an executable tag', () => {
  const html = render('<script>alert(document.cookie)</script>');
  // The only <script> in the document is the transcript viewer bundle, never the
  // user payload — assert the payload text is escaped, not live.
  assert.ok(!/<script>alert\(document\.cookie\)/i.test(html));
});

test('img onerror handler does not survive as a live attribute', () => {
  const html = render('<img src=x onerror=alert(1)>');
  // The raw tag must be escaped to inert text, not rendered as a live element.
  assert.ok(!/<img[^>]*onerror/i.test(html), 'no live <img onerror> element may survive');
});

test('legitimate https links are preserved', () => {
  const html = render('[ok](https://example.com/page)');
  assert.ok(/href="https:\/\/example\.com\/page"/.test(html));
});

// --- Custom emoji ---

test('custom emoji renders as a live <img>, not escaped text', () => {
  const html = render(':01KYTPB24E0PVH5GZE74M8SDW9:');
  assert.ok(/<img[^>]*class="stoat-emoji-image"/.test(html), 'emoji <img> should be live');
  assert.ok(!/&lt;img[^&]*stoat-emoji-image/.test(html), 'emoji <img> must not be escaped to text');
});

test('user-typed <img> claiming the emoji class but with onerror is still escaped', () => {
  const html = render('<img src=x onerror=alert(1) class="stoat-emoji-image">');
  assert.ok(!/<img[^>]*onerror/i.test(html), 'no live onerror <img> may survive');
});

// --- gifbox (stoat.chat's GIF service) ---

test('gifbox embed renders the direct mp4 media, not the /view/ page as an <img>', () => {
  const html = renderMsg({
    content: '',
    embeds: [{ type: 'GIF', url: 'https://gifbox.me/view/rzDTDu72dkWVJx0W-0j4A' }],
  });
  assert.ok(
    /<video[^>]*>[\s\S]*?<source[^>]*src="https:\/\/rpc\.gifbox\.me\/media\/post\/rzDTDu72dkWVJx0W-0j4A\/mp4"/.test(html),
    'should emit a <video> with the rpc.gifbox.me mp4 source'
  );
  assert.ok(
    !/<img[^>]*src="https:\/\/gifbox\.me\/view\//.test(html),
    'must NOT render the gifbox /view/ page as an <img>'
  );
});

test('gifbox video is a looping muted autoplay clip with a poster', () => {
  const html = renderMsg({ content: '', embeds: [{ type: 'GIF', url: 'https://gifbox.me/view/abc123' }] });
  assert.ok(/<video[^>]*\bautoplay\b/.test(html));
  assert.ok(/<video[^>]*\bloop\b/.test(html));
  assert.ok(/<video[^>]*\bmuted\b/.test(html));
  assert.ok(/poster="https:\/\/rpc\.gifbox\.me\/media\/post\/abc123\/poster"/.test(html));
});

test('bare gifbox link in message text renders the mp4 media', () => {
  const html = renderMsg({ content: 'lol https://gifbox.me/view/xyz789' });
  assert.ok(/src="https:\/\/rpc\.gifbox\.me\/media\/post\/xyz789\/mp4"/.test(html));
});

// --- other GIF providers ---

test('giphy page link resolves to a direct .gif image', () => {
  const html = renderMsg({ content: 'https://giphy.com/gifs/funny-cat-abcDEF123' });
  assert.ok(/<img[^>]*src="https:\/\/i\.giphy\.com\/media\/abcDEF123\/giphy\.gif"/.test(html));
  assert.ok(!/<iframe[^>]*giphy/.test(html), 'should not fall back to an iframe when the id is known');
});

test('giphy embed link resolves to a direct .gif image', () => {
  const html = renderMsg({ content: '', embeds: [{ type: 'GIF', url: 'https://giphy.com/embed/xY12ab34' }] });
  assert.ok(/src="https:\/\/i\.giphy\.com\/media\/xY12ab34\/giphy\.gif"/.test(html));
});

test('direct giphy media .gif is rendered as an image', () => {
  const html = renderMsg({ content: 'https://media.giphy.com/media/abcDEF123/giphy.gif' });
  assert.ok(/<img[^>]*src="https:\/\/media\.giphy\.com\/media\/abcDEF123\/giphy\.gif"/.test(html));
});

test('imgur .gifv link renders as a looping mp4 video', () => {
  const html = renderMsg({ content: 'https://i.imgur.com/AbCdEf1.gifv' });
  assert.ok(/<video[^>]*\bloop\b[\s\S]*?<source[^>]*src="https:\/\/i\.imgur\.com\/AbCdEf1\.mp4"/.test(html));
});

test('tenor page link still falls back to an embeddable iframe', () => {
  const html = renderMsg({ content: '', embeds: [{ type: 'GIF', url: 'https://tenor.com/view/cat-dance-12345678' }] });
  assert.ok(/<iframe[^>]*src="https:\/\/tenor\.com\/embed\/12345678"/.test(html));
});

test('a plain .gif URL from any host renders as an image', () => {
  const html = renderMsg({ content: 'https://example.com/cool.gif' });
  assert.ok(/<img[^>]*src="https:\/\/example\.com\/cool\.gif"/.test(html));
});

// --- media types ---

test('audio attachment renders an <audio> player', () => {
  const html = renderMsg({ content: '', attachments: [{ filename: 'song.mp3', url: 'https://example.com/song.mp3', contentType: 'audio/mpeg' }] });
  assert.ok(/<audio[^>]*controls/.test(html));
  assert.ok(/<source[^>]*src="https:\/\/example\.com\/song\.mp3"/.test(html));
});

test('audio is detected by extension when MIME is missing', () => {
  const html = renderMsg({ content: '', attachments: [{ filename: 'v.ogg', url: 'https://example.com/v.ogg' }] });
  assert.ok(/<audio[^>]*controls/.test(html));
});

test('pdf attachment renders an inline iframe viewer', () => {
  const html = renderMsg({ content: '', attachments: [{ filename: 'doc.pdf', url: 'https://example.com/doc.pdf', contentType: 'application/pdf' }] });
  assert.ok(/class="attachment-pdf-frame"[^>]*src="https:\/\/example\.com\/doc\.pdf"/.test(html));
});

test('video attachment renders a <video> player', () => {
  const html = renderMsg({ content: '', attachments: [{ filename: 'clip.mp4', url: 'https://example.com/clip.mp4', contentType: 'video/mp4' }] });
  assert.ok(/<video class="attachment-video"/.test(html));
  assert.ok(/<source[^>]*src="https:\/\/example\.com\/clip\.mp4"/.test(html));
});

test('unknown file type falls back to a download card', () => {
  const html = renderMsg({ content: '', attachments: [{ filename: 'archive.zip', url: 'https://example.com/archive.zip', size: 1024 }] });
  assert.ok(/class="attachment-name"[^>]*>archive\.zip</.test(html));
});

// --- bot badge ---

test('bot messages get a BOT badge', () => {
  const html = renderMessages([
    { id: 'm1', authorId: 'bot_1', username: 'YetAnotherOverengineeredStoatBot', isBot: true, content: 'beep', createdAt: new Date().toISOString() },
  ]);
  assert.ok(/class="author-badge"[\s\S]*?BOT/.test(html));
});

test('non-bot messages do not get a BOT badge', () => {
  const html = renderMsg({ content: 'hi' });
  assert.ok(!/class="author-badge"/.test(html));
});
