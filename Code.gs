/**
 * ジムの備品・在庫管理アプリ - Code.gs
 */

// ============================================================
// 定数
// ============================================================
var SHEET_STORES   = '店舗マスター';
var SHEET_ITEMS    = '商品マスター';
var SHEET_INVENTORY= '在庫データ';
var SHEET_DEFAULT  = 'デフォルト商品';
var SHEET_NOTIFY   = '通知設定';
var SHEET_CATS     = 'カテゴリマスター';

var HEADERS = {
  '店舗マスター':  {display:['店舗ID','店舗名'], keys:['store_id','store_name']},
  '商品マスター':  {display:['商品ID','店舗ID','カテゴリ','商品名','単位','下限在庫数','並び順','作成日'], keys:['item_id','store_id','category','name','unit','min_stock','sort_order','created_at']},
  '在庫データ':    {display:['商品ID','店舗ID','在庫数','更新日時'], keys:['item_id','store_id','quantity','updated_at']},
  'デフォルト商品': {display:['デフォルトID','カテゴリ','商品名','単位','下限在庫数','並び順'], keys:['default_id','category','name','unit','min_stock','sort_order']},
  '通知設定':      {display:['店舗ID','店舗名','メールアドレス','チャットURL'], keys:['store_id','store_name','notification_emails','google_chat_webhook']},
  'カテゴリマスター': {display:['カテゴリID','カテゴリ名','並び順'], keys:['category_id','name','sort_order']}
};

// ============================================================
// エントリポイント
// ============================================================
function doGet(e) {
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('ジム備品・在庫管理システム')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================
// シート取得 / ヘルパー
// ============================================================
function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (HEADERS[name]) {
      sheet.appendRow(HEADERS[name].display);
      var cols = HEADERS[name].display.length;
      sheet.getRange(1,1,1,cols).setFontWeight('bold').setBackground('#1e293b').setFontColor('#ffffff');
    }
  }
  return sheet;
}

function _getAllData(sheetName) {
  var sheet = getSheet(sheetName);
  if (sheet.getLastRow() <= 1) return [];
  var data = sheet.getDataRange().getValues();
  var keys = HEADERS[sheetName] ? HEADERS[sheetName].keys : data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    keys.forEach(function(k, i) { obj[k] = row[i]; });
    return obj;
  });
}

function _findRow(sheet, colIndex, value) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]) === String(value)) return i + 1;
  }
  return -1;
}

function _lock() {
  var lock = LockService.getScriptLock();
  lock.tryLock(15000);
  return lock;
}

function _uuid() { return Utilities.getUuid(); }

// ============================================================
// キャッシュ
// ============================================================
var CACHE_TTL = 300; // 5分

function _getCache(key) {
  try {
    var val = CacheService.getScriptCache().get(key);
    return val ? JSON.parse(val) : null;
  } catch(e) { return null; }
}

function _setCache(key, data) {
  try {
    var json = JSON.stringify(data);
    if (json.length < 100000) { // 100KB以下のみキャッシュ
      CacheService.getScriptCache().put(key, json, CACHE_TTL);
    }
  } catch(e) {}
}

function _clearCache() {
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll(['stores','items_all','inventory_all','notifications','defaults','categories']);
  } catch(e) {}
}

function _cachedGetAll(sheetName, cacheKey) {
  var cached = _getCache(cacheKey);
  if (cached) return cached;
  var data = _getAllData(sheetName);
  _setCache(cacheKey, data);
  return data;
}

// ============================================================
// DB初期化
// ============================================================
function initDatabase() {
  [SHEET_STORES, SHEET_ITEMS, SHEET_INVENTORY, SHEET_DEFAULT, SHEET_NOTIFY, SHEET_CATS]
    .forEach(function(n) { getSheet(n); });
  
  var catSheet = getSheet(SHEET_CATS);
  if (catSheet.getLastRow() <= 1) {
    var initialCats = [
      ['cat_1', '消耗品', 1],
      ['cat_2', 'プレゼント', 2],
      ['cat_3', '機材', 3],
      ['cat_4', '商品欄追加', 4]
    ];
    initialCats.forEach(function(r) { catSheet.appendRow(r); });
  }
  return {success: true};
}

// ============================================================
// 店舗管理
// ============================================================
function getStores() { return _getAllData(SHEET_STORES); }

function addStore(storeName) {
  var lock = _lock();
  try {
    var storeId = _uuid();
    getSheet(SHEET_STORES).appendRow([storeId, storeName]);
    getSheet(SHEET_NOTIFY).appendRow([storeId, storeName, '', '']);
    _copyDefaultsToStore(storeId);
    _clearCache();
    return {success: true, storeId: storeId};
  } finally { lock.releaseLock(); }
}

function _copyDefaultsToStore(storeId) {
  var defaults = _getAllData(SHEET_DEFAULT);
  var itemSheet = getSheet(SHEET_ITEMS);
  var invSheet  = getSheet(SHEET_INVENTORY);
  defaults.forEach(function(d) {
    var itemId = _uuid();
    itemSheet.appendRow([itemId, storeId, d.category, d.name, d.unit, d.min_stock, d.sort_order, new Date().toISOString()]);
    invSheet.appendRow([itemId, storeId, 0, new Date().toISOString()]);
  });
}

function editStore(storeId, storeName) {
  var lock = _lock();
  try {
    var sheet = getSheet(SHEET_STORES);
    var row = _findRow(sheet, 0, storeId);
    if (row === -1) return {success: false, error: '店舗が見つかりません'};
    sheet.getRange(row, 2).setValue(storeName);
    var nSheet = getSheet(SHEET_NOTIFY);
    var nRow = _findRow(nSheet, 0, storeId);
    if (nRow !== -1) nSheet.getRange(nRow, 2).setValue(storeName);
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

function deleteStore(storeId) {
  var lock = _lock();
  try {
    // Stores
    var storeSheet = getSheet(SHEET_STORES);
    var storeData = storeSheet.getDataRange().getValues();
    var filteredStores = storeData.filter(function(row, idx) {
      return idx === 0 || String(row[0]) !== String(storeId);
    });
    storeSheet.clearContents();
    storeSheet.getRange(1, 1, filteredStores.length, filteredStores[0].length).setValues(filteredStores);

    // Notifications
    var notifySheet = getSheet(SHEET_NOTIFY);
    var notifyData = notifySheet.getDataRange().getValues();
    var filteredNotify = notifyData.filter(function(row, idx) {
      return idx === 0 || String(row[0]) !== String(storeId);
    });
    notifySheet.clearContents();
    notifySheet.getRange(1, 1, filteredNotify.length, filteredNotify[0].length).setValues(filteredNotify);

    // Items
    var itemSheet = getSheet(SHEET_ITEMS);
    var itemData = itemSheet.getDataRange().getValues();
    var filteredItems = itemData.filter(function(row, idx) {
      return idx === 0 || String(row[1]) !== String(storeId);
    });
    itemSheet.clearContents();
    itemSheet.getRange(1, 1, filteredItems.length, filteredItems[0].length).setValues(filteredItems);

    // Inventory
    var invSheet = getSheet(SHEET_INVENTORY);
    var invData = invSheet.getDataRange().getValues();
    var filteredInvs = invData.filter(function(row, idx) {
      return idx === 0 || String(row[1]) !== String(storeId);
    });
    invSheet.clearContents();
    invSheet.getRange(1, 1, filteredInvs.length, filteredInvs[0].length).setValues(filteredInvs);

    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

// ============================================================
// 商品マスター
// ============================================================
function getItemsByStore(storeId) {
  return _getAllData(SHEET_ITEMS)
    .filter(function(i) { return String(i.store_id) === String(storeId); })
    .sort(function(a, b) {
      var ci = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
      return ci !== 0 ? ci : (a.sort_order || 0) - (b.sort_order || 0);
    });
}

function saveItemsMaster(storeId, itemsList) {
  var lock = _lock();
  try {
    var itemSheet = getSheet(SHEET_ITEMS);
    var invSheet  = getSheet(SHEET_INVENTORY);
    
    var itemsData = itemSheet.getDataRange().getValues();
    var invData = invSheet.getDataRange().getValues();
    
    // この店舗以外のデータを退避
    var otherItems = itemsData.filter(function(row, idx) {
      return idx === 0 || String(row[1]) !== String(storeId);
    });
    var otherInvs = invData.filter(function(row, idx) {
      return idx === 0 || String(row[1]) !== String(storeId);
    });
    
    var nowStr = new Date().toISOString();
    var newItemsRows = [];
    var newInvsRows = [];
    
    // 既存の作成日を保持するためのマップ
    var origCreatedMap = {};
    itemsData.forEach(function(row) {
      if (String(row[1]) === String(storeId)) {
        origCreatedMap[String(row[0])] = row[7];
      }
    });
    // 既存の在庫数を保持するためのマップ
    var origQtyMap = {};
    invData.forEach(function(row) {
      if (String(row[1]) === String(storeId)) {
        origQtyMap[String(row[0])] = row[2];
      }
    });

    itemsList.forEach(function(item) {
      var itemId = item.item_id || _uuid();
      var created = origCreatedMap[itemId] || nowStr;
      newItemsRows.push([
        itemId,
        storeId,
        item.category,
        item.name,
        item.unit,
        Number(item.min_stock) || 0,
        Number(item.sort_order) || 1,
        created
      ]);
      
      var qty = origQtyMap[itemId] !== undefined ? origQtyMap[itemId] : 0;
      newInvsRows.push([
        itemId,
        storeId,
        qty,
        nowStr
      ]);
    });
    
    var finalItems = otherItems.concat(newItemsRows);
    var finalInvs = otherInvs.concat(newInvsRows);
    
    itemSheet.clearContents();
    itemSheet.getRange(1, 1, finalItems.length, finalItems[0].length).setValues(finalItems);
    
    invSheet.clearContents();
    invSheet.getRange(1, 1, finalInvs.length, finalInvs[0].length).setValues(finalInvs);
    
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

// ============================================================
// 在庫操作
// ============================================================
function getInventoryByStore(storeId) {
  return _getAllData(SHEET_INVENTORY).filter(function(i) { return String(i.store_id) === String(storeId); });
}

function saveInventoryBatch(storeId, changesList) {
  var lock = _lock();
  try {
    var invSheet = getSheet(SHEET_INVENTORY);
    var data = invSheet.getDataRange().getValues();
    
    // c.item_id -> quantity のマップを作る
    var changeMap = {};
    changesList.forEach(function(c) {
      changeMap[String(c.item_id)] = Math.max(0, Number(c.quantity) || 0);
    });
    
    var nowStr = new Date().toISOString();
    
    // 既存行の更新判定
    var updatedIds = {};
    for (var i = 1; i < data.length; i++) {
      var itemId = String(data[i][0]);
      if (changeMap[itemId] !== undefined) {
        data[i][2] = changeMap[itemId]; // 在庫数
        data[i][3] = nowStr; // 更新日時
        updatedIds[itemId] = true;
      }
    }
    
    // 新規追加分の処理（基本起こらないはずだがセーフティとして）
    changesList.forEach(function(c) {
      var itemId = String(c.item_id);
      if (!updatedIds[itemId]) {
        data.push([itemId, storeId, changeMap[itemId], nowStr]);
      }
    });
    
    // 一括上書き書き込み
    invSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    
    // 保存後に店舗全体の下限割れをまとめて通知
    _sendStoreAlertSummary(storeId);
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

// ============================================================
// 通知（店舗ごと）
// ============================================================
function getAllNotifications() {
  return _getAllData(SHEET_NOTIFY);
}

function saveStoreNotification(storeId, emails, webhook) {
  var lock = _lock();
  try {
    var sheet = getSheet(SHEET_NOTIFY);
    var data = sheet.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(storeId)) {
        rowIdx = i;
        break;
      }
    }
    
    if (rowIdx === -1) {
      var store = _getAllData(SHEET_STORES).find(function(s){ return String(s.store_id)===String(storeId); }) || {};
      sheet.appendRow([storeId, store.store_name||'', emails, webhook]);
    } else {
      sheet.getRange(rowIdx + 1, 3).setValue(emails);
      sheet.getRange(rowIdx + 1, 4).setValue(webhook);
    }
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

function saveAllNotifications(notifyList) {
  var lock = _lock();
  try {
    var sheet = getSheet(SHEET_NOTIFY);
    var data = sheet.getDataRange().getValues();
    
    var notifyMap = {};
    notifyList.forEach(function(n) {
      notifyMap[String(n.storeId)] = n;
    });
    
    for (var i = 1; i < data.length; i++) {
      var storeId = String(data[i][0]);
      if (notifyMap[storeId]) {
        data[i][2] = notifyMap[storeId].emails || '';
        data[i][3] = notifyMap[storeId].webhook || '';
      }
    }
    
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

function _sendStoreAlertSummary(storeId) {
  // 店舗全体の下限割れ商品を全件取得してまとめて通知
  var stores = _getAllData(SHEET_STORES);
  var store  = stores.find(function(s){ return String(s.store_id)===String(storeId); }) || {};
  var storeName = store.store_name || '不明店舗';

  var items     = _getAllData(SHEET_ITEMS).filter(function(i){ return String(i.store_id)===String(storeId); });
  var inventory = _getAllData(SHEET_INVENTORY).filter(function(i){ return String(i.store_id)===String(storeId); });
  var invMap = {};
  inventory.forEach(function(inv){ invMap[String(inv.item_id)] = Number(inv.quantity)||0; });

  // 下限割れリストを収集
  var alertItems = [];
  items.forEach(function(item) {
    var min = Number(item.min_stock);
    if (min <= 0) return;
    var qty = invMap[String(item.item_id)] !== undefined ? invMap[String(item.item_id)] : 0;
    if (qty < min) {
      alertItems.push({name: item.name, unit: item.unit, qty: qty, min: min});
    }
  });

  if (alertItems.length === 0) return; // 下限割れなし → 通知しない

  var notifs = _getAllData(SHEET_NOTIFY);
  var notif  = notifs.find(function(n){ return String(n.store_id)===String(storeId); }) || {};

  // --- Gmailは商品ごとに個別送信 ---
  var emails = (notif.notification_emails || '').split(',').map(function(e){ return e.trim(); }).filter(Boolean);
  if (emails.length > 0) {
    alertItems.forEach(function(a) {
      var subject = '【在庫アラート】' + storeName + ' - ' + a.name;
      var body = storeName + ' の在庫が下限を下回りました。\n\n商品名: ' + a.name +
                 '\n現在庫: ' + a.qty + a.unit + '\n下限設定: ' + a.min + a.unit +
                 '\n\n早めに補充をお願いします。';
      emails.forEach(function(email) {
        try { MailApp.sendEmail({to: email, subject: subject, body: body}); } catch(ex) {}
      });
    });
  }

  // --- Google Chat は全件まとめて1メッセージ ---
  var webhookUrl = notif.google_chat_webhook || '';
  if (webhookUrl) {
    var lines = ['⚠️ *【在庫アラート】' + storeName + '* ⚠️', ''];
    alertItems.forEach(function(a) {
      lines.push('📦 *' + a.name + '*  ' + a.qty + a.unit + '（下限: ' + a.min + a.unit + '）');
    });
    lines.push('');
    lines.push('_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd HH:mm') + ' 時点_');
    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'POST', contentType: 'application/json',
        payload: JSON.stringify({text: lines.join('\n')})
      });
    } catch(ex) {}
  }
}

function sendTestNotification(storeId) {
  try {
    var notifs = _getAllData(SHEET_NOTIFY);
    var notif  = notifs.find(function(n){ return String(n.store_id)===String(storeId); }) || {};
    var storeName = notif.store_name || 'テスト店舗';

    // Gmail
    var emails = (notif.notification_emails || '').split(',').map(function(e){ return e.trim(); }).filter(Boolean);
    emails.forEach(function(email) {
      try {
        MailApp.sendEmail({
          to: email,
          subject: '【テスト通知】' + storeName,
          body: 'ジム在庫管理システムの通知設定が正常に動作しています。\n\n店舗: ' + storeName
        });
      } catch(ex) {}
    });

    // Google Chat
    var webhookUrl = notif.google_chat_webhook || '';
    if (webhookUrl) {
      var msg = '✅ *【テスト通知】' + storeName + '*\nジム在庫管理システムの通知設定が正常に動作しています。';
      try {
        UrlFetchApp.fetch(webhookUrl, {
          method: 'POST', contentType: 'application/json',
          payload: JSON.stringify({text: msg})
        });
      } catch(ex) {}
    }
    return {success: true};
  } catch(e) {
    return {success: false, error: e.message};
  }
}


// ============================================================
// デフォルト商品管理
// ============================================================
function getDefaultItems() {
  return _getAllData(SHEET_DEFAULT).sort(function(a, b) {
    var ci = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    return ci !== 0 ? ci : (a.sort_order||0) - (b.sort_order||0);
  });
}

function saveDefaultsAndSync(itemsList) {
  var lock = _lock();
  try {
    var defSheet = getSheet(SHEET_DEFAULT);
    var currentData = defSheet.getDataRange().getValues();
    var currentIds = currentData.slice(1).map(function(r){ return r[0]; });
    
    var defRows = [currentData[0]]; // ヘッダー
    var newItems = [];
    
    itemsList.forEach(function(item) {
      var id = item.id || _uuid();
      var isNew = !item.id || currentIds.indexOf(item.id) === -1;
      defRows.push([
        id,
        item.category,
        item.name,
        item.unit,
        Number(item.min_stock) || 0,
        Number(item.sort_order) || 1
      ]);
      if (isNew) {
        newItems.push({
          category: item.category,
          name: item.name,
          unit: item.unit,
          min_stock: Number(item.min_stock) || 0,
          sort_order: Number(item.sort_order) || 1
        });
      }
    });
    
    // デフォルト商品を一括上書き
    defSheet.clearContents();
    defSheet.getRange(1, 1, defRows.length, defRows[0].length).setValues(defRows);
    
    // 新規アイテムを全店舗に追加
    if (newItems.length > 0) {
      var stores = _getAllData(SHEET_STORES);
      var itemSheet = getSheet(SHEET_ITEMS);
      var invSheet  = getSheet(SHEET_INVENTORY);
      
      var itemsData = itemSheet.getDataRange().getValues();
      var invData = invSheet.getDataRange().getValues();
      
      var nowStr = new Date().toISOString();
      
      stores.forEach(function(store) {
        newItems.forEach(function(ni) {
          var itemId = _uuid();
          itemsData.push([
            itemId,
            store.store_id,
            ni.category,
            ni.name,
            ni.unit,
            ni.min_stock,
            ni.sort_order,
            nowStr
          ]);
          invData.push([
            itemId,
            store.store_id,
            0,
            nowStr
          ]);
        });
      });
      
      itemSheet.clearContents();
      itemSheet.getRange(1, 1, itemsData.length, itemsData[0].length).setValues(itemsData);
      
      invSheet.clearContents();
      invSheet.getRange(1, 1, invData.length, invData[0].length).setValues(invData);
    }
    
    _clearCache();
    return {success: true, newCount: newItems.length};
  } finally { lock.releaseLock(); }
}

// ============================================================
// 全データ一括取得（キャッシュ層）
// ============================================================
// ============================================================
// 全データ一括取得（キャッシュ層）
// ============================================================
function loadAllData(storeId) {
  var stores     = _cachedGetAll(SHEET_STORES, 'stores');
  var allItems   = _cachedGetAll(SHEET_ITEMS,  'items_all');
  var allInv     = _cachedGetAll(SHEET_INVENTORY, 'inventory_all');
  var notifs     = _cachedGetAll(SHEET_NOTIFY, 'notifications');
  var categories = _cachedGetAll(SHEET_CATS, 'categories').sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });

  var catNames   = categories.map(function(c){ return c.name; });

  var defs       = _cachedGetAll(SHEET_DEFAULT,'defaults').sort(function(a,b){
    var ci = catNames.indexOf(a.category)-catNames.indexOf(b.category);
    return ci!==0?ci:(a.sort_order||0)-(b.sort_order||0);
  });

  // 店舗ID -> 店舗名のマップ
  var storeMap = {};
  stores.forEach(function(s) {
    storeMap[String(s.store_id)] = s.store_name;
  });

  // 商品ID -> 商品基本情報 (店舗間移動や個別表示用)
  var itemMap = {};
  allItems.forEach(function(item) {
    itemMap[String(item.item_id)] = {
      name: item.name,
      storeId: item.store_id,
      storeName: storeMap[String(item.store_id)] || '不明店舗'
    };
  });

  // 商品名 -> 各店舗の在庫数マップを生成
  var storeStockMap = {};
  allInv.forEach(function(inv) {
    var itemInfo = itemMap[String(inv.item_id)];
    if (itemInfo) {
      if (!storeStockMap[itemInfo.name]) {
        storeStockMap[itemInfo.name] = {};
      }
      storeStockMap[itemInfo.name][String(itemInfo.storeId)] = {
        storeName: itemInfo.storeName,
        qty: Number(inv.quantity) || 0
      };
    }
  });

  var items     = storeId ? allItems.filter(function(i){ return String(i.store_id)===String(storeId); })
    .sort(function(a,b){ var ci=catNames.indexOf(a.category)-catNames.indexOf(b.category); return ci!==0?ci:(a.sort_order||0)-(b.sort_order||0); }) : [];
  var inventory = storeId ? allInv.filter(function(i){ return String(i.store_id)===String(storeId); }) : [];

  return {
    stores: stores,
    items: items,
    inventory: inventory,
    notifications: notifs,
    defaultItems: defs,
    categories: categories,
    storeStockMap: storeStockMap
  };
}

// ============================================================
// カテゴリ管理
// ============================================================
function saveCategories(catList) {
  var lock = _lock();
  try {
    var sheet = getSheet(SHEET_CATS);
    var rows = [HEADERS[SHEET_CATS].display];
    catList.forEach(function(c, i) {
      rows.push([c.category_id || _uuid(), c.name, i + 1]);
    });
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    _clearCache();
    return {success: true};
  } finally { lock.releaseLock(); }
}

// ============================================================
// 在庫CSV出力
// ============================================================
function exportInventoryCSV() {
  try {
    var stores    = _getAllData(SHEET_STORES);
    var allItems  = _getAllData(SHEET_ITEMS);
    var allInv    = _getAllData(SHEET_INVENTORY);

    // storeId → store_name マップ
    var storeMap = {};
    stores.forEach(function(s) { storeMap[String(s.store_id)] = s.store_name; });

    // itemId → item (name, store_id) マップ
    var itemMap = {};
    allItems.forEach(function(i) { itemMap[String(i.item_id)] = i; });

    // 在庫データを「商品名, 店舗名, 在庫数」に変換
    var rows = [['商品名', '店舗名', '在庫数']]; // ヘッダー
    allInv.forEach(function(inv) {
      var item = itemMap[String(inv.item_id)];
      if (!item) return;
      var storeName = storeMap[String(inv.store_id)] || '不明店舗';
      rows.push([item.name, storeName, Number(inv.quantity) || 0]);
    });

    // CSV文字列を生成（ダブルクォートでエスケープ）
    var csvLines = rows.map(function(row) {
      return row.map(function(cell) {
        var s = String(cell);
        if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
          s = '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(',');
    });

    return { success: true, csv: csvLines.join('\n') };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// 店舗間移動
// ============================================================
// ============================================================
// 店舗間移動
// ============================================================
function transferStock(fromStoreId, toStoreId, itemName, quantity) {
  var lock = _lock();
  try {
    var qty = Number(quantity);
    if (qty <= 0) return {success: false, error: '数量は1以上にしてください'};
    if (String(fromStoreId) === String(toStoreId)) return {success: false, error: '移動元と移動先が同じ店舗です'};

    var itemSheet = getSheet(SHEET_ITEMS);
    var invSheet  = getSheet(SHEET_INVENTORY);
    
    var allItems = _getAllData(SHEET_ITEMS);
    var allInvs  = _getAllData(SHEET_INVENTORY);

    // 移動元の該当商品を探す
    var fromItem = allItems.find(function(i){ return String(i.store_id)===String(fromStoreId) && i.name===itemName; });
    if (!fromItem) return {success: false, error: '移動元の店舗に商品が存在しません'};

    // 移動先店舗に商品があるか確認。無ければ自動作成
    var toItem = allItems.find(function(i){ return String(i.store_id)===String(toStoreId) && i.name===itemName; });
    var itemsData = itemSheet.getDataRange().getValues();
    var invData = invSheet.getDataRange().getValues();
    var nowStr = new Date().toISOString();
    var itemsModified = false;

    if (!toItem) {
      // 商品マスターへ新規追加
      var newToItemId = _uuid();
      itemsData.push([
        newToItemId,
        toStoreId,
        fromItem.category,
        fromItem.name,
        fromItem.unit,
        Number(fromItem.min_stock) || 0,
        Number(fromItem.sort_order) || 1,
        nowStr
      ]);
      itemSheet.clearContents();
      itemSheet.getRange(1, 1, itemsData.length, itemsData[0].length).setValues(itemsData);
      itemsModified = true;
      
      // 在庫データへ空枠を追加
      invData.push([newToItemId, toStoreId, 0, nowStr]);
      
      // 仮オブジェクト生成
      toItem = { item_id: newToItemId };
    }

    // 移動元と移動先の在庫行インデックスを探す
    var fromRowIdx = -1;
    var toRowIdx = -1;

    for (var i = 1; i < invData.length; i++) {
      if (String(invData[i][0]) === String(fromItem.item_id)) fromRowIdx = i;
      if (String(invData[i][0]) === String(toItem.item_id)) toRowIdx = i;
    }

    var fromQty = fromRowIdx !== -1 ? Number(invData[fromRowIdx][2])||0 : 0;
    if (fromQty < qty) return {success: false, error: '移動元の在庫が不足しています（現在の在庫: ' + fromQty + fromItem.unit + '）'};

    // 移動元マイナス
    if (fromRowIdx !== -1) {
      invData[fromRowIdx][2] = Math.max(0, fromQty - qty);
      invData[fromRowIdx][3] = nowStr;
    }

    // 移動先プラス
    if (toRowIdx !== -1) {
      var currentToQty = Number(invData[toRowIdx][2])||0;
      invData[toRowIdx][2] = currentToQty + qty;
      invData[toRowIdx][3] = nowStr;
    } else {
      invData.push([toItem.item_id, toStoreId, qty, nowStr]);
    }

    invSheet.clearContents();
    invSheet.getRange(1, 1, invData.length, invData[0].length).setValues(invData);

    // アラートサマリー送信 (移動元店舗は在庫が減るためアラート通知が必要になる可能性があるが、移動先は在庫が増えるだけなので通知は絶対に不要)
    _sendStoreAlertSummary(fromStoreId);

    _clearCache();

    // 最新のデータをその場で生成して返す (クライアント側での再ロードによるサーバー往復オーバーヘッドを削減)
    // この時点でクリアキャッシュされたので、再度_cachedGetAllを行うと最新シートデータが取得できる
    var updatedAllItems = _cachedGetAll(SHEET_ITEMS, 'items_all');
    var updatedAllInv = _cachedGetAll(SHEET_INVENTORY, 'inventory_all');
    var stores = _cachedGetAll(SHEET_STORES, 'stores');
    var categories = _cachedGetAll(SHEET_CATS, 'categories').sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
    var catNames = categories.map(function(c){ return c.name; });

    var storeMap = {};
    stores.forEach(function(s) {
      storeMap[String(s.store_id)] = s.store_name;
    });

    var itemMap = {};
    updatedAllItems.forEach(function(item) {
      itemMap[String(item.item_id)] = {
        name: item.name,
        storeId: item.store_id,
        storeName: storeMap[String(item.store_id)] || '不明店舗'
      };
    });

    var storeStockMap = {};
    updatedAllInv.forEach(function(inv) {
      var itemInfo = itemMap[String(inv.item_id)];
      if (itemInfo) {
        if (!storeStockMap[itemInfo.name]) {
          storeStockMap[itemInfo.name] = {};
        }
        storeStockMap[itemInfo.name][String(itemInfo.storeId)] = {
          storeName: itemInfo.storeName,
          qty: Number(inv.quantity) || 0
        };
      }
    });

    // 現在開いている店舗(fromStoreIdなど、呼び出し元の店舗)に応じた商品一覧・在庫データを返す
    // クライアントで現在開いている店舗IDは、通常はfromStoreIdとは限らないため、
    // クライアント側からリロード要求を減らすために全店舗情報をそのまま返します。
    // フロント側で受け取った店舗IDに基づいてクライアント側でフィルタする形にすれば超高速化します。
    
    return {
      success: true,
      storeStockMap: storeStockMap,
      allInv: updatedAllInv,
      allItems: updatedAllItems
    };
  } finally { lock.releaseLock(); }
}
