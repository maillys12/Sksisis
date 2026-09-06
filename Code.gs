const CONFIG = Object.freeze({
  DOMAIN: 'maillys.shop',
  MAX_THREADS: 50,
  MAX_MESSAGES: 100,
  SEARCH_PERIOD: 'newer_than:30d',
  BODY_LIMIT: 30000,
});

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Maillys Inbox')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Returns messages addressed to one alias under @maillys.shop.
 * This function runs as the account that deployed the web app.
 */
function getMessages(input) {
  const email = normalizeAndValidateEmail_(input);
  const query = `in:anywhere ${CONFIG.SEARCH_PERIOD} to:${email}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  const results = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (results.length >= CONFIG.MAX_MESSAGES) return;
      if (!wasAddressedTo_(message, email)) return;

      const body = cleanBody_(message.getPlainBody());
      const subject = message.getSubject() || '(ไม่มีหัวข้อ)';
      const category = classifyAllowedMessage_(subject, body);
      if (!category) return;

      results.push({
        id: message.getId(),
        from: message.getFrom() || 'ไม่ทราบผู้ส่ง',
        to: email,
        subject: subject,
        date: message.getDate().toISOString(),
        preview: body.slice(0, 180),
        otp: extractOtp_(subject + '\n' + body),
        category: category,
      });
    });
  });

  results.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    email: email,
    count: results.length,
    messages: results.slice(0, CONFIG.MAX_MESSAGES),
    searchedAt: new Date().toISOString(),
  };
}

function getMessageContent(messageId, inputEmail) {
  const email = normalizeAndValidateEmail_(inputEmail);
  const id = String(messageId || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(id)) throw new Error('รหัสข้อความไม่ถูกต้อง');

  const message = GmailApp.getMessageById(id);
  if (!message || !wasAddressedTo_(message, email)) {
    throw new Error('ไม่พบข้อความสำหรับอีเมลนี้');
  }

  const plainBody = cleanBody_(message.getPlainBody());
  const subject = message.getSubject() || '(ไม่มีหัวข้อ)';
  const category = classifyAllowedMessage_(subject, plainBody);
  if (!category) throw new Error('ข้อความนี้ไม่อยู่ในประเภทที่อนุญาต');

  return {
    id: message.getId(),
    from: message.getFrom() || 'ไม่ทราบผู้ส่ง',
    to: email,
    subject: subject,
    date: message.getDate().toISOString(),
    htmlBody: prepareHtmlBody_(message.getBody(), plainBody),
    otp: extractOtp_(subject + '\n' + plainBody),
    category: category,
  };
}

/**
 * Only exposes Netflix-style operational messages that customers need:
 * sign-in verification, household updates, and temporary viewing access.
 * Password recovery and extra-member messages are intentionally excluded.
 */
function classifyAllowedMessage_(subject, body) {
  const normalizedSubject = normalizeForMatch_(subject);
  const searchable = normalizeForMatch_(subject + '\n' + String(body || '').slice(0, 12000));

  const blockedSubjectPatterns = [
    /(?:forgot|reset|change|update|recover|create|set).{0,40}password/,
    /password.{0,40}(?:forgot|reset|change|update|recover|create|set)/,
    /(?:ลืม|เปลี่ยน|รีเซ็ต|ตั้ง|กู้).{0,24}รหัสผ่าน/,
    /รหัสผ่าน.{0,24}(?:ใหม่|ถูกเปลี่ยน|เปลี่ยน|รีเซ็ต|กู้คืน)/,
    /(?:add|adding|added|invite|buy|manage).{0,45}(?:extra|additional)\s+member/,
    /(?:extra|additional)\s+member(?:\s+slot)?/,
    /(?:เพิ่ม|สมัคร|เชิญ|ซื้อ|จัดการ).{0,24}(?:สมาชิก|จอ).{0,12}(?:เสริม|เพิ่มเติม)/,
    /(?:สมาชิก|จอ).{0,12}(?:เสริม|เพิ่มเติม)/,
  ];

  if (matchesAny_(normalizedSubject, blockedSubjectPatterns)) return '';

  const rules = [
    {
      category: 'sign_in_code',
      patterns: [
        /(?:sign[\s-]?in|log[\s-]?in).{0,45}(?:code|verification)/,
        /(?:code|verification).{0,45}(?:sign[\s-]?in|log[\s-]?in)/,
        /(?:netflix).{0,45}(?:verification|security)\s+code/,
        /(?:verification|security)\s+code.{0,45}(?:netflix)/,
        /(?:รหัส|โค้ด).{0,35}(?:เข้าสู่ระบบ|ล็อกอิน|ยืนยันการเข้าสู่ระบบ)/,
        /(?:เข้าสู่ระบบ|ล็อกอิน|ยืนยันการเข้าสู่ระบบ).{0,35}(?:รหัส|โค้ด)/,
      ],
    },
    {
      category: 'household_update',
      patterns: [
        /(?:update|confirm|verify).{0,45}(?:netflix\s+)?household/,
        /(?:netflix\s+)?household.{0,45}(?:update|confirm|verify)/,
        /(?:อัปเดต|ยืนยัน|ตรวจสอบ).{0,35}ครัวเรือน/,
        /ครัวเรือน.{0,35}(?:อัปเดต|ยืนยัน|ตรวจสอบ)/,
      ],
    },
    {
      category: 'temporary_access',
      patterns: [
        /(?:watch|view|access).{0,45}temporar/,
        /temporar.{0,45}(?:watch|view|access|code)/,
        /(?:รับชม|ดู|เข้าถึง|เข้าใช้งาน).{0,35}ชั่วคราว/,
        /(?:รหัส|โค้ด).{0,35}(?:รับชม|เข้าใช้งาน|เข้าถึง|ชั่วคราว)/,
        /ชั่วคราว.{0,35}(?:รหัส|โค้ด|รับชม|เข้าใช้งาน|เข้าถึง)/,
      ],
    },
  ];

  for (let i = 0; i < rules.length; i += 1) {
    if (matchesAny_(searchable, rules[i].patterns)) return rules[i].category;
  }
  return '';
}

function normalizeForMatch_(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny_(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeAndValidateEmail_(input) {
  const email = String(input || '').trim().toLowerCase();
  const escapedDomain = CONFIG.DOMAIN.replace(/\./g, '\\.');
  const pattern = new RegExp(`^[a-z0-9._+-]+@${escapedDomain}$`, 'i');

  if (!pattern.test(email) || email.length > 254) {
    throw new Error(`กรุณากรอกอีเมลที่ลงท้ายด้วย @${CONFIG.DOMAIN}`);
  }

  return email;
}

function wasAddressedTo_(message, email) {
  const fields = [
    message.getTo(),
    message.getCc(),
    message.getHeader('Delivered-To'),
    message.getHeader('X-Original-To'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return fields.includes(email);
}

function cleanBody_(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, CONFIG.BODY_LIMIT);
}

function prepareHtmlBody_(html, plainBody) {
  let safe = String(html || '').trim();
  if (!safe) {
    safe = '<pre>' + escapeHtml_(plainBody || '(ไม่มีเนื้อหาข้อความ)') + '</pre>';
  }

  safe = safe
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '');

  const additions = '<base target="_blank">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0!important;padding:0!important;max-width:100%!important;overflow-wrap:anywhere}body{font-family:Arial,sans-serif}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}pre{white-space:pre-wrap;font:14px/1.65 Arial,sans-serif;padding:24px;color:#26354d}</style>';

  if (/<head[\s>]/i.test(safe)) {
    return safe.replace(/<head([^>]*)>/i, '<head$1>' + additions);
  }
  return '<!doctype html><html><head>' + additions + '</head><body>' + safe + '</body></html>';
}

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractOtp_(text) {
  const source = String(text || '');
  const patterns = [
    /(?:otp|one[- ]time password)\s*(?:is|คือ|:|-)?\s*([0-9]{4,8})(?!\d)/i,
    /(?:verification|security|authentication)\s+code\s*(?:is|คือ|:|-)?\s*([0-9]{4,8})(?!\d)/i,
    /(?:รหัสยืนยัน|รหัสความปลอดภัย|รหัสเข้าสู่ระบบ)\s*(?:คือ|:|-)?\s*([0-9]{4,8})(?!\d)/i,
  ];

  for (let i = 0; i < patterns.length; i += 1) {
    const match = source.match(patterns[i]);
    if (match) return match[1];
  }
  return '';
}
