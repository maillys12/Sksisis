const CONFIG = Object.freeze({
  DOMAIN: 'maillys.shop',
  MAX_THREADS: 50,
  MAX_MESSAGES: 100,
  SEARCH_PERIOD: 'newer_than:30d',
  BODY_LIMIT: 30000,
  MESSAGE_TTL_MS: 15 * 60 * 1000,
  APP_SENDERS: Object.freeze({
    netflix: ['netflix.com'],
    disney: ['disney.com', 'disneyplus.com'],
  }),
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
  const request = normalizeRequest_(input);
  const email = request.email;
  const app = request.app;
  const query = `in:anywhere ${CONFIG.SEARCH_PERIOD} to:${email}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  const results = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (results.length >= CONFIG.MAX_MESSAGES) return;
      if (!wasAddressedTo_(message, email)) return;
      if (!isAllowedSender_(message, app)) return;

      const body = cleanBody_(message.getPlainBody());
      const subject = message.getSubject() || '(ไม่มีหัวข้อ)';
      const category = classifyAllowedMessage_(app, subject, body);
      if (!category) return;
      const expired = isMessageExpired_(message);

      results.push({
        id: message.getId(),
        from: message.getFrom() || 'ไม่ทราบผู้ส่ง',
        to: email,
        subject: subject,
        date: message.getDate().toISOString(),
        preview: expired ? '' : body.slice(0, 180),
        otp: expired ? '' : extractOtp_(subject + '\n' + body),
        category: category,
        app: app,
        expired: expired,
      });
    });
  });

  results.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    email: email,
    app: app,
    count: results.length,
    messages: results.slice(0, CONFIG.MAX_MESSAGES),
    searchedAt: new Date().toISOString(),
  };
}

function getMessageContent(messageId, inputEmail, inputApp) {
  const email = normalizeAndValidateEmail_(inputEmail);
  const app = normalizeAndValidateApp_(inputApp);
  const id = String(messageId || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(id)) throw new Error('รหัสข้อความไม่ถูกต้อง');

  const message = GmailApp.getMessageById(id);
  if (!message || !wasAddressedTo_(message, email) || !isAllowedSender_(message, app)) {
    throw new Error('ไม่พบข้อความสำหรับอีเมลนี้');
  }
  if (isMessageExpired_(message)) throw new Error('ข้อความหมดอายุ');

  const plainBody = cleanBody_(message.getPlainBody());
  const subject = message.getSubject() || '(ไม่มีหัวข้อ)';
  const category = classifyAllowedMessage_(app, subject, plainBody);
  if (!category) throw new Error('ข้อความประเภทนี้ไม่อนุญาตให้แสดง');

  return {
    id: message.getId(),
    from: message.getFrom() || 'ไม่ทราบผู้ส่ง',
    to: email,
    subject: subject,
    date: message.getDate().toISOString(),
    htmlBody: prepareHtmlBody_(message.getBody(), plainBody),
    otp: extractOtp_(subject + '\n' + plainBody),
    category: category,
    app: app,
  };
}

function normalizeRequest_(input) {
  if (!input || typeof input !== 'object') throw new Error('กรุณาเลือกแอปก่อนค้นหา');
  return {
    email: normalizeAndValidateEmail_(input.email),
    app: normalizeAndValidateApp_(input.app),
  };
}

function normalizeAndValidateApp_(input) {
  const app = String(input || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CONFIG.APP_SENDERS, app)) {
    throw new Error('กรุณาเลือก Netflix หรือ Disney+ ก่อนค้นหา');
  }
  return app;
}

function isMessageExpired_(message) {
  const receivedAt = message.getDate().getTime();
  return Date.now() - receivedAt >= CONFIG.MESSAGE_TTL_MS;
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

function isAllowedSender_(message, app) {
  const from = String(message.getFrom() || '').toLowerCase();
  const addresses = from.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  const allowedDomains = CONFIG.APP_SENDERS[app] || [];

  return addresses.some((address) => {
    const senderDomain = address.split('@').pop();
    return allowedDomains.some((allowedDomain) =>
      senderDomain === allowedDomain || senderDomain.endsWith('.' + allowedDomain)
    );
  });
}

/**
 * Only exposes Netflix messages needed for sign-in, household confirmation,
 * or temporary viewing. Account-security and account-change messages are
 * rejected before any allow rule is evaluated.
 */
function classifyAllowedMessage_(app, subject, body) {
  const searchable = normalizeForMatch_(subject + '\n' + body);

  const blockedPatterns = [
    /(?:reset|forgot|change|update|recover|create|set).{0,35}password/,
    /password.{0,35}(?:reset|recovery|change|update|ใหม่)/,
    /(?:ลืม|เปลี่ยน|รีเซ็ต|ตั้ง|กู้|แก้ไข|อัปเดต).{0,24}รหัสผ่าน/,
    /รหัสผ่าน.{0,24}(?:ใหม่|เปลี่ยน|รีเซ็ต|กู้|แก้ไข|อัปเดต)/,
    /(?:change|update|replace|confirm|verify).{0,45}(?:email address|e-mail address|phone|mobile|payment|billing|account details|account information|profile|plan)/,
    /(?:email address|e-mail address|phone|mobile|payment|billing|account details|account information|profile|plan).{0,45}(?:change|update|replace|confirmation|verification)/,
    /(?:เปลี่ยน|อัปเดต|แก้ไข|ยืนยัน).{0,35}(?:อีเมลใหม่|ที่อยู่อีเมล|เบอร์โทร|หมายเลขโทรศัพท์|วิธีชำระเงิน|ข้อมูลการชำระเงิน|ข้อมูลบัญชี|รายละเอียดบัญชี|โปรไฟล์|แพ็กเกจ|แผนบริการ)/,
    /(?:extra|additional).{0,25}(?:member|screen)/,
    /(?:member|screen).{0,25}(?:extra|additional)/,
    /(?:เพิ่ม|สมัคร|ยืนยัน).{0,20}(?:สมาชิกเสริม|จอเสริม)/,
  ];

  if (matchesAny_(searchable, blockedPatterns)) return '';

  const commonSignInPatterns = [
    /(?:netflix.{0,35})?(?:sign[\s-]?in|log[\s-]?in).{0,35}(?:code|verification|attempt)/,
    /(?:code|verification).{0,35}(?:sign[\s-]?in|log[\s-]?in)/,
    /(?:someone|somebody).{0,45}(?:tried|attempted|trying).{0,45}(?:access|sign in|log in).{0,30}(?:your )?account/,
    /(?:มีคน|บุคคล).{0,40}(?:พยายาม|กำลัง).{0,40}(?:เข้าใช้|เข้าสู่|เข้าถึง).{0,30}บัญชี/,
    /(?:รหัสยืนยัน|ยืนยันด้วยรหัส|รหัสความปลอดภัย|รหัสเข้าสู่ระบบ).{0,45}(?:เข้าสู่ระบบ|ล็อกอิน|เข้าใช้บัญชี)/,
    /(?:เข้าสู่ระบบ|ล็อกอิน|เข้าใช้บัญชี).{0,45}(?:รหัสยืนยัน|ยืนยันด้วยรหัส|รหัสความปลอดภัย)/,
  ];

  const disneySignInPatterns = [
    /(?:disney\+?|mydisney).{0,45}(?:sign[\s-]?in|log[\s-]?in).{0,45}(?:code|verification|passcode)/,
    /(?:sign[\s-]?in|log[\s-]?in).{0,45}(?:disney\+?|mydisney).{0,45}(?:code|verification|passcode)/,
    /(?:รหัสยืนยัน|รหัสความปลอดภัย).{0,45}(?:เข้าสู่ระบบ|ล็อกอิน|เข้าใช้).{0,25}(?:disney|ดิสนีย์)/,
    /(?:เข้าสู่ระบบ|ล็อกอิน|เข้าใช้).{0,45}(?:disney|ดิสนีย์).{0,25}(?:รหัสยืนยัน|รหัสความปลอดภัย)/,
  ];

  const householdPatterns = [
    /(?:netflix\s+)?household/,
    /(?:update|confirm|verify|manage).{0,35}household/,
    /(?:อัปเดต|ยืนยัน|จัดการ|ตรวจสอบ).{0,35}ครัวเรือน/,
    /ครัวเรือน.{0,35}(?:อัปเดต|ยืนยัน|จัดการ|ตรวจสอบ)/,
  ];

  const signInPatterns = app === 'disney'
    ? commonSignInPatterns.concat(disneySignInPatterns)
    : commonSignInPatterns;

  if (matchesAny_(searchable, signInPatterns)) return 'sign_in_code';
  if (matchesAny_(searchable, householdPatterns)) return 'household';

  // A vague subject such as "verification code expires in 15 minutes" is
  // intentionally insufficient; its body must identify an allowed purpose.
  return '';
}

function normalizeForMatch_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny_(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
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
    /(?:otp|one[- ]time (?:password|passcode)|sign[\s-]?in code)\s*(?:is|คือ|:|-)?\s*([0-9](?:[\s\u00a0]*[0-9]){3,7})(?![\s\u00a0]*[0-9])/i,
    /(?:verification|security|authentication)\s+code\s*(?:is|คือ|:|-)?\s*([0-9](?:[\s\u00a0]*[0-9]){3,7})(?![\s\u00a0]*[0-9])/i,
    /(?:ยืนยันด้วยรหัสนี้|ป้อนรหัสนี้เพื่อยืนยัน|รหัสยืนยัน|รหัสความปลอดภัย|รหัสเข้าสู่ระบบ)\s*(?:คือ|:|-)?\s*([0-9](?:[\s\u00a0]*[0-9]){3,7})(?![\s\u00a0]*[0-9])/i,
  ];

  for (let i = 0; i < patterns.length; i += 1) {
    const match = source.match(patterns[i]);
    if (match) {
      const code = match[1].replace(/\D/g, '');
      if (code.length >= 4 && code.length <= 8) return code;
    }
  }
  return '';
}
