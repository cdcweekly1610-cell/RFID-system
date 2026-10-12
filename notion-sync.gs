/**
 * 混凝土試體 RFID → Notion 同步轉送站（Google Apps Script）
 *
 * 用途：網頁無法直接呼叫 Notion API（瀏覽器會擋），所以由這支程式在 Google 端代為寫入 Notion。
 * Notion 金鑰只存在這裡的「指令碼屬性」，不會出現在網頁上。
 *
 * 需要在「專案設定 → 指令碼屬性」新增 3 個屬性：
 *   NOTION_TOKEN        Notion 整合的 Internal Integration Secret（ntn_ 或 secret_ 開頭）
 *   NOTION_DATABASE_ID  Notion 資料庫網址中那串 32 碼 ID
 *   SYNC_SECRET         自訂一組同步密碼（網頁設定要填同一組），防止別人亂寫入
 *
 * 設定完先在編輯器選「testSetup」按「執行」，確認可以連到 Notion 並自動建立欄位，
 * 再「部署 → 新增部署作業 → 網頁應用程式」（執行身分：我；存取權：所有人）。
 */

const NOTION_VERSION = '2025-09-03';

// Notion 資料庫欄位（不存在時會自動建立）。標題欄位會自動使用資料庫原本的標題欄，存放「表單編號」。
const FIELDS = {
  castDate:    { name: '取樣日期',   schema: { date: {} } },
  projectName: { name: '工程名稱',   schema: { rich_text: {} } },
  supplier:    { name: '供應廠商',   schema: { select: {} } },
  memo:        { name: '取樣位置',   schema: { rich_text: {} } },
  strength:    { name: '設計強度',   schema: { select: {} } },
  test7Day:    { name: '7天試壓日',  schema: { date: {} } },
  test28Day:   { name: '28天試壓日', schema: { date: {} } },
  count:       { name: '試體數量',   schema: { number: {} } },
  rfid1:       { name: 'RFID #1',   schema: { rich_text: {} } },
  rfid2:       { name: 'RFID #2',   schema: { rich_text: {} } },
  rfid3:       { name: 'RFID #3',   schema: { rich_text: {} } },
  rfid4:       { name: 'RFID #4',   schema: { rich_text: {} } },
};

// ===================== 網頁呼叫入口 =====================
function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const props = PropertiesService.getScriptProperties();
    if (!req.secret || req.secret !== props.getProperty('SYNC_SECRET')) {
      return json_({ ok: false, error: '同步密碼錯誤' });
    }
    if (req.action === 'ping') {
      const ctx = getContext_();
      return json_({ ok: true, message: '連線成功：' + ctx.dbTitle });
    }
    if (req.action === 'upsert') {
      return json_(upsertSheet_(req.sheet, req.oldFormNumber));
    }
    return json_({ ok: false, error: '未知的動作：' + req.action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, message: 'RFID → Notion 同步服務運作中' });
}

// ===================== 編輯器手動測試 =====================
function testSetup() {
  const ctx = getContext_(true);
  Logger.log('✅ 已連上 Notion 資料庫：「' + ctx.dbTitle + '」，標題欄位：「' + ctx.titleProp + '」，欄位已檢查/建立完成。');
}

// ===================== 核心邏輯 =====================
function upsertSheet_(sheet, oldFormNumber) {
  if (!sheet || !sheet.formNumber) throw new Error('缺少表單資料');
  const ctx = getContext_();
  const properties = buildProperties_(sheet, ctx.titleProp);

  const existing = findPage_(ctx, oldFormNumber || sheet.formNumber)
    || (oldFormNumber && oldFormNumber !== sheet.formNumber ? findPage_(ctx, sheet.formNumber) : null);

  if (existing) {
    const page = notion_('patch', '/v1/pages/' + existing.id, { properties });
    return { ok: true, action: 'updated', url: page.url };
  }
  const page = notion_('post', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: ctx.dataSourceId },
    properties,
  });
  return { ok: true, action: 'created', url: page.url };
}

function buildProperties_(s, titleProp) {
  const text = v => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] });
  const sel = v => ({ select: v ? { name: String(v).replace(/,/g, '，').slice(0, 100) } : null });
  const date = v => ({ date: v ? { start: v } : null });
  const specs = Array.isArray(s.specimens) ? s.specimens : [];
  const rfidOf = id => (specs.find(sp => String(sp.id) === String(id)) || {}).rfid || '';

  // 取樣日期含時間，加上台灣時區
  let cast = String(s.castDate || '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cast)) cast += ':00+08:00';

  const p = {};
  p[titleProp] = { title: [{ text: { content: String(s.formNumber) } }] };
  p[FIELDS.castDate.name] = date(cast || null);
  p[FIELDS.projectName.name] = text(s.projectName);
  p[FIELDS.supplier.name] = sel(s.supplier);
  p[FIELDS.memo.name] = text(s.memo);
  p[FIELDS.strength.name] = sel(s.strength);
  p[FIELDS.test7Day.name] = date(s.test7Day);
  p[FIELDS.test28Day.name] = date(s.test28Day);
  p[FIELDS.count.name] = { number: specs.length };
  for (let i = 1; i <= 4; i++) p[FIELDS['rfid' + i].name] = text(rfidOf(i));
  return p;
}

function findPage_(ctx, formNumber) {
  if (!formNumber) return null;
  const res = notion_('post', '/v1/data_sources/' + ctx.dataSourceId + '/query', {
    filter: { property: ctx.titleProp, title: { equals: String(formNumber) } },
    page_size: 1,
  });
  return (res.results && res.results[0]) || null;
}

// 取得資料來源 ID、標題欄位名稱，並確保欄位存在（結果快取 6 小時）
function getContext_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const hit = cache.get('ctx');
    if (hit) return JSON.parse(hit);
  }
  const dbId = cleanId_(PropertiesService.getScriptProperties().getProperty('NOTION_DATABASE_ID'));
  if (!dbId) throw new Error('尚未設定 NOTION_DATABASE_ID');

  const db = notion_('get', '/v1/databases/' + dbId);
  const ds = (db.data_sources || [])[0];
  if (!ds) throw new Error('這個資料庫沒有資料來源，請確認 ID 是否為「資料庫」而不是一般頁面');
  const dbTitle = (db.title || []).map(t => t.plain_text).join('') || '(未命名資料庫)';

  const source = notion_('get', '/v1/data_sources/' + ds.id);
  const existing = source.properties || {};
  const titleProp = Object.keys(existing).find(k => existing[k].type === 'title');

  const missing = {};
  Object.keys(FIELDS).forEach(key => {
    const f = FIELDS[key];
    if (!existing[f.name]) missing[f.name] = f.schema;
  });
  if (Object.keys(missing).length) {
    notion_('patch', '/v1/data_sources/' + ds.id, { properties: missing });
  }

  const ctx = { dataSourceId: ds.id, titleProp, dbTitle };
  cache.put('ctx', JSON.stringify(ctx), 21600);
  return ctx;
}

function notion_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('尚未設定 NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com' + path, {
    method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token.trim(), 'Notion-Version': NOTION_VERSION },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText() || '{}');
  if (code >= 300) {
    if (code === 401) throw new Error('Notion 金鑰無效（NOTION_TOKEN）');
    if (code === 404) throw new Error('找不到 Notion 資料庫：請確認 ID 正確，並在資料庫右上角「⋯ → 連線」加入你的整合');
    throw new Error('Notion 錯誤 ' + code + '：' + (data.message || res.getContentText()));
  }
  return data;
}

function cleanId_(raw) {
  const m = String(raw || '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return m ? m[0] : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
