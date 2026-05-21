import { db } from './firebase-config.js';
import { 
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, onSnapshot, writeBatch
} from 'firebase/firestore';

// アプリケーション状態の管理
const S = {
  stores: [], items: [], inventory: [], notifications: [], defaultItems: [], editDefaultItems: [], categories: [],
  currentStoreId: null, currentCategory: '', currentScreen: 'staff',
  currentAdminTab: 'stores',
  // ローカル編集用
  editItems: [], itemsDirty: false,
  defaultsDirty: false,
  notifyDirty: false,
  editCategories: [], categoriesDirty: false,
  pendingChanges: {}, staffDirty: false,
  storeStockMap: {}
};
let CATS = [];

// ローダーとトースト表示ヘルパー
function showLoader(v) {
  const el = document.getElementById('loader');
  if (el) el.classList.toggle('hidden', !v);
}

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
  }, 2500);
}

// ============================================================
// 未保存チェック
// ============================================================
function isDirty() {
  return S.staffDirty || S.itemsDirty || S.defaultsDirty || S.notifyDirty || S.categoriesDirty;
}

function checkUnsaved() {
  if (!isDirty()) return true;
  const ok = confirm('保存されていない変更があります。\n保存せずに移動しますか？');
  if (ok) {
    resetEditStates();
    renderAll();
  }
  return ok;
}

function updateDirtyUI() {
  const m = {
    staffUnsaved: S.staffDirty,
    itemsUnsaved: S.itemsDirty,
    defaultsUnsaved: S.defaultsDirty,
    notifyUnsaved: S.notifyDirty,
    categoriesUnsaved: S.categoriesDirty
  };
  Object.keys(m).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = m[id] ? 'inline' : 'none';
  });
}

// ============================================================
// DB初期化とリアルタイムリスナーのセットアップ
// ============================================================
async function init() {
  showLoader(true);
  try {
    // データベースが空の場合の初期データ追加
    await checkAndInitializeDatabase();
    
    // 各コレクションのリアルタイム監視
    // 1. 店舗マスター
    onSnapshot(collection(db, 'stores'), (snapshot) => {
      S.stores = snapshot.docs.map(doc => ({ store_id: doc.id, store_name: doc.data().name }));
      
      // 初回ロード時、または選択中の店舗が削除された場合のデフォルト店舗設定
      if (S.stores.length > 0 && (!S.currentStoreId || !S.stores.some(st => st.store_id === S.currentStoreId))) {
        S.currentStoreId = S.stores[0].store_id;
      }
      renderAll();
    });

    // 2. カテゴリマスター
    onSnapshot(collection(db, 'categories'), (snapshot) => {
      S.categories = snapshot.docs.map(doc => ({ category_id: doc.id, name: doc.data().name, sort_order: doc.data().sort_order }))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      CATS = S.categories.map(c => c.name);
      
      if (CATS.length > 0 && !CATS.includes(S.currentCategory)) {
        S.currentCategory = CATS[0];
      }
      renderAll();
    });

    // 3. デフォルト商品
    onSnapshot(collection(db, 'default_items'), (snapshot) => {
      S.defaultItems = snapshot.docs.map(doc => ({ default_id: doc.id, ...doc.data() }))
        .sort((a, b) => {
          const ci = CATS.indexOf(a.category) - CATS.indexOf(b.category);
          return ci !== 0 ? ci : (a.sort_order || 0) - (b.sort_order || 0);
        });
      S.editDefaultItems = JSON.parse(JSON.stringify(S.defaultItems));
      renderAll();
    });

    // 4. 通知設定
    onSnapshot(collection(db, 'notifications'), (snapshot) => {
      S.notifications = snapshot.docs.map(doc => ({ store_id: doc.id, ...doc.data() }));
      renderAll();
    });

    // 5. 商品および在庫データ (Items コレクション全体を監視して店間比較をリアルタイム化)
    onSnapshot(collection(db, 'items'), (snapshot) => {
      const allItems = snapshot.docs.map(doc => ({ item_id: doc.id, ...doc.data() }));
      
      // 現在開いている店舗の商品のみを抽出
      S.items = allItems.filter(i => String(i.store_id) === String(S.currentStoreId))
        .sort((a, b) => {
          const ci = CATS.indexOf(a.category) - CATS.indexOf(b.category);
          return ci !== 0 ? ci : (a.sort_order || 0) - (b.sort_order || 0);
        });
      
      // 互換性維持のため S.inventory も更新
      S.inventory = S.items.map(item => ({
        item_id: item.item_id,
        store_id: item.store_id,
        quantity: Number(item.quantity) || 0,
        updated_at: item.updated_at
      }));

      // 現在開いている店舗以外も含めて、全店在庫比較マップを構築
      buildStoreStockMap(allItems);

      // 初回ロード用の店舗データ初期設定
      if (S.editItems.length === 0 || !S.itemsDirty) {
        S.editItems = JSON.parse(JSON.stringify(S.items));
      }
      
      renderAll();
      showLoader(false);
    }, (error) => {
      console.error(error);
      toast('データ監視エラー');
      showLoader(false);
    });

  } catch (e) {
    console.error('Initialization failed:', e);
    toast('初期化エラー');
    showLoader(false);
  }
}

// データベースの初期設定
async function checkAndInitializeDatabase() {
  const catSnapshot = await getDocs(collection(db, 'categories'));
  if (catSnapshot.empty) {
    console.log('Database is empty. Initializing master data...');
    const batch = writeBatch(db);
    
    // 1. カテゴリマスター初期設定
    const initialCats = [
      { name: '消耗品', sort_order: 1 },
      { name: 'プレゼント', sort_order: 2 },
      { name: '機材', sort_order: 3 },
      { name: '商品欄追加', sort_order: 4 }
    ];
    initialCats.forEach(cat => {
      const catRef = doc(collection(db, 'categories'));
      batch.set(catRef, cat);
    });
    
    // 2. デフォルト商品初期設定
    const initialDefaults = [
      { category: '消耗品', name: 'シャンプー', unit: '本', min_stock: 5, sort_order: 1 },
      { category: '消耗品', name: 'リンス', unit: '本', min_stock: 5, sort_order: 2 },
      { category: '消耗品', name: 'ボディソープ', unit: '本', min_stock: 5, sort_order: 3 },
      { category: 'プレゼント', name: '紹介特典タオル', unit: '枚', min_stock: 10, sort_order: 1 }
    ];
    initialDefaults.forEach(def => {
      const defRef = doc(collection(db, 'default_items'));
      batch.set(defRef, def);
    });
    
    await batch.commit();
    console.log('Database initialized successfully.');
  }
}

// 他の店舗の在庫状況を素早く引くためのマップ作成
function buildStoreStockMap(allItems) {
  S.storeStockMap = {};
  
  const storeMap = {};
  S.stores.forEach(s => {
    storeMap[String(s.store_id)] = s.store_name;
  });

  allItems.forEach(item => {
    const itemName = item.name;
    const storeId = String(item.store_id);
    const storeName = storeMap[storeId] || '不明店舗';
    const qty = Number(item.quantity) || 0;

    if (!S.storeStockMap[itemName]) {
      S.storeStockMap[itemName] = {};
    }
    S.storeStockMap[itemName][storeId] = {
      storeName: storeName,
      qty: qty
    };
  });
}

function resetEditStates() {
  S.editItems = JSON.parse(JSON.stringify(S.items));
  S.editCategories = JSON.parse(JSON.stringify(S.categories));
  S.editDefaultItems = JSON.parse(JSON.stringify(S.defaultItems));
  S.pendingChanges = {};
  S.staffDirty = false; S.itemsDirty = false; S.defaultsDirty = false; S.notifyDirty = false; S.categoriesDirty = false;
}

// 選択中の店舗変更時に再描画と監視トリガー
function switchStore() {
  if (!checkUnsaved()) return;
  S.currentStoreId = document.getElementById('storeSelect').value;
  
  // S.items を強制更新し、店舗に応じた編集状態をリセット
  onSnapshot(collection(db, 'items'), (snapshot) => {
    const allItems = snapshot.docs.map(doc => ({ item_id: doc.id, ...doc.data() }));
    S.items = allItems.filter(i => String(i.store_id) === String(S.currentStoreId))
      .sort((a, b) => {
        const ci = CATS.indexOf(a.category) - CATS.indexOf(b.category);
        return ci !== 0 ? ci : (a.sort_order || 0) - (b.sort_order || 0);
      });
    resetEditStates();
    renderAll();
  });
}

// ============================================================
// レンダリングロジック
// ============================================================
function renderAll() {
  renderStoreSelect();
  renderStaffCatTabs();
  renderStaffScreen();
  renderStaffChanges();
  renderAdminScreen();
  updateTransferOptions();
  updateDirtyUI();
}

function renderStoreSelect() {
  ['storeSelect', 'adminStoreSelect', 'notifyStoreJump'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const val = sel.value;
    sel.innerHTML = '';
    if (S.stores.length === 0) {
      sel.innerHTML = '<option value="">店舗なし</option>';
      return;
    }
    S.stores.forEach(st => {
      const o = document.createElement('option');
      o.value = st.store_id;
      o.textContent = st.store_name;
      sel.appendChild(o);
    });
    if (val && S.stores.some(st => st.store_id === val)) sel.value = val;
    else if (S.currentStoreId) sel.value = S.currentStoreId;
  });
}

function renderStaffCatTabs() {
  const container = document.getElementById('staffCatTabs');
  if (!container) return;
  container.innerHTML = '';
  
  S.categories.forEach(cat => {
    const tab = document.createElement('div');
    tab.className = 'cat-tab';
    if (cat.name === S.currentCategory) tab.classList.add('active');
    tab.dataset.cat = cat.name;
    
    let icon = '📁';
    if (cat.name.indexOf('消耗品') !== -1) icon = '🧴';
    else if (cat.name.indexOf('プレゼント') !== -1 || cat.name.indexOf('紹介') !== -1) icon = '🎁';
    else if (cat.name.indexOf('機材') !== -1) icon = '🏋️';
    else if (cat.name.indexOf('商品欄') !== -1) icon = '📋';
    
    tab.textContent = icon + ' ' + cat.name;
    tab.addEventListener('click', () => {
      switchCategory(cat.name);
    });
    container.appendChild(tab);
  });
}

function getOriginalQty(itemId) {
  const inv = S.inventory.find(v => String(v.item_id) === String(itemId));
  return inv ? Number(inv.quantity) || 0 : 0;
}

function getDisplayQty(itemId) {
  return S.pendingChanges[itemId] !== undefined ? S.pendingChanges[itemId] : getOriginalQty(itemId);
}

function renderStaffScreen() {
  const c = document.getElementById('itemsContainer');
  if (!c) return;
  c.innerHTML = '';
  const filtered = S.items.filter(i => i.category === S.currentCategory);
  if (filtered.length === 0) {
    c.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light)">商品がありません</div>';
    return;
  }
  const tbl = document.createElement('table');
  tbl.className = 'item-table';
  tbl.innerHTML = '<thead><tr><th>商品名</th><th>元の数</th><th>変更後</th><th>単位</th><th colspan="2">増減</th><th>直接入力</th></tr></thead>';
  const tbody = document.createElement('tbody');
  
  filtered.forEach(item => {
    const origQty = getOriginalQty(item.item_id);
    const newQty = getDisplayQty(item.item_id);
    const changed = S.pendingChanges[item.item_id] !== undefined;
    const min = Number(item.min_stock) || 0;
    const isAlert = min > 0 && newQty < min;
    
    // 店舗ごとの在庫テキスト
    const stockObj = S.storeStockMap && S.storeStockMap[item.name] ? S.storeStockMap[item.name] : {};
    const stockTexts = [];
    S.stores.forEach(st => {
      const sId = String(st.store_id);
      const sName = st.store_name;
      let qty = 0;
      if (stockObj[sId] !== undefined) {
        qty = stockObj[sId].qty;
      }
      
      if (sId === String(S.currentStoreId)) {
        const diff = newQty - origQty;
        qty = Math.max(0, qty + diff);
        stockTexts.push('<strong style="color:var(--primary)">' + sName + ':' + qty + '</strong>');
      } else {
        stockTexts.push(sName + ':' + qty);
      }
    });
    const storeStockHTML = '<span style="font-size:9px;color:var(--text-sub);font-weight:normal;display:block;white-space:normal;line-height:1.3;margin-top:2px">' +
      stockTexts.join(' / ') + '</span>';
    
    const tr = document.createElement('tr');
    if (isAlert) tr.className = 'alert';
    const newQtyCell = changed
      ? '<td class="td-qty" style="color:var(--primary);font-weight:700">' + newQty + '</td>'
      : '<td class="td-qty">-</td>';
      
    tr.innerHTML = '<td class="td-name">' + item.name + storeStockHTML + '</td>' +
      '<td class="td-qty" style="color:var(--text-sub)">' + origQty + '</td>' +
      newQtyCell +
      '<td class="td-unit">' + item.unit + '</td>' +
      '<td><button class="btn-inc plus" data-id="' + item.item_id + '">+1</button></td>' +
      '<td><button class="btn-inc minus" data-id="' + item.item_id + '">-1</button></td>' +
      '<td class="td-direct"><input type="number" min="0" data-id="' + item.item_id + '" placeholder="直入力" value="' + (changed ? newQty : '') + '"></td>';
      
    tr.querySelector('.btn-inc.plus').addEventListener('click', function () { changeLocal(this.dataset.id, 1); });
    tr.querySelector('.btn-inc.minus').addEventListener('click', function () { changeLocal(this.dataset.id, -1); });
    tr.querySelector('.td-direct input').addEventListener('change', function () {
      const id = this.dataset.id;
      const v = parseInt(this.value, 10);
      if (!isNaN(v) && v >= 0) {
        if (v === getOriginalQty(id)) {
          delete S.pendingChanges[id];
        } else {
          S.pendingChanges[id] = v;
        }
        S.staffDirty = Object.keys(S.pendingChanges).length > 0;
        renderStaffScreen(); renderStaffChanges(); updateDirtyUI();
      }
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); c.appendChild(tbl);
}

function changeLocal(itemId, delta) {
  const orig = getOriginalQty(itemId);
  const cur = getDisplayQty(itemId);
  const newVal = Math.max(0, cur + delta);
  if (newVal === orig) {
    delete S.pendingChanges[itemId];
  } else {
    S.pendingChanges[itemId] = newVal;
  }
  S.staffDirty = Object.keys(S.pendingChanges).length > 0;
  renderStaffScreen(); renderStaffChanges(); updateDirtyUI();
}

function renderStaffChanges() {
  const c = document.getElementById('staffChangesList');
  if (!c) return;
  const keys = Object.keys(S.pendingChanges);
  if (keys.length === 0) {
    c.innerHTML = '<span class="none">差分なし</span>';
    return;
  }
  let html = '';
  keys.forEach(id => {
    const item = S.items.find(i => String(i.item_id) === String(id));
    const orig = getOriginalQty(id);
    const nv = S.pendingChanges[id];
    if (item) html += '<span>' + item.name + ': ' + orig + ' → ' + nv + item.unit + '</span>';
  });
  c.innerHTML = html;
}

// 在庫の保存
async function saveStaffInventory() {
  if (!S.currentStoreId) { toast('店舗を選択'); return; }
  const keys = Object.keys(S.pendingChanges);
  if (keys.length === 0) { toast('変更がありません'); return; }
  
  showLoader(true);
  try {
    const batch = writeBatch(db);
    const nowStr = new Date().toISOString();
    
    keys.forEach(id => {
      batch.update(doc(db, 'items', id), {
        quantity: Math.max(0, Number(S.pendingChanges[id]) || 0),
        updated_at: nowStr
      });
    });
    
    await batch.commit();
    toast('在庫を保存しました');
    
    // 非同期で下限警告を通知
    sendStoreAlertSummary(S.currentStoreId);
    
    S.staffDirty = false;
    S.pendingChanges = {};
    updateDirtyUI();
  } catch (error) {
    console.error(error);
    toast('保存エラー');
  } finally {
    showLoader(false);
  }
}

function switchCategory(cat) {
  S.currentCategory = cat;
  document.querySelectorAll('.cat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.cat === cat);
  });
  renderStaffScreen();
}

// ============================================================
// アラート通知送信
// ============================================================
async function sendStoreAlertSummary(storeId) {
  try {
    // 店舗の通知先設定を取得
    const notifDoc = await getDoc(doc(db, 'notifications', storeId));
    if (!notifDoc.exists()) return;
    const notif = notifDoc.data();
    
    const webhookUrl = notif.google_chat_webhook || '';
    const emails = notif.notification_emails || '';
    if (!webhookUrl && !emails) return; // 通知先なし
    
    // 店舗内の全商品在庫を取得して下限割れを算出
    const storeName = notif.store_name || '不明店舗';
    const q = query(collection(db, 'items'), where('store_id', '==', storeId));
    const snapshot = await getDocs(q);
    
    const alertItems = [];
    snapshot.forEach(dDoc => {
      const item = dDoc.data();
      const min = Number(item.min_stock) || 0;
      const qty = Number(item.quantity) || 0;
      if (min > 0 && qty < min) {
        alertItems.push({
          name: item.name,
          unit: item.unit,
          qty: qty,
          min: min
        });
      }
    });
    
    if (alertItems.length === 0) return; // 警告なし
    
    // Vercel Serverless Function へ POST 送信
    const response = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeName,
        webhookUrl,
        emails,
        alertItems
      })
    });
    
    const res = await response.json();
    if (!res.success) {
      console.error('Notification failed:', res.error);
    }
  } catch (e) {
    console.error('Failed to send alerts:', e);
  }
}

async function sendTestNotification(storeId) {
  showLoader(true);
  try {
    const notifDoc = await getDoc(doc(db, 'notifications', storeId));
    if (!notifDoc.exists()) { toast('通知設定が見つかりません'); return; }
    const notif = notifDoc.data();
    
    const response = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeName: notif.store_name || 'テスト店舗',
        webhookUrl: notif.google_chat_webhook || '',
        emails: notif.notification_emails || '',
        isTest: true
      })
    });
    
    const result = await response.json();
    if (result.success) {
      toast('テスト通知を送信しました');
    } else {
      toast('テスト通知失敗: ' + result.error);
    }
  } catch (e) {
    console.error(e);
    toast('エラーが発生しました');
  } finally {
    showLoader(false);
  }
}

// ============================================================
// 店舗間在庫移動
// ============================================================
function updateTransferOptions() {
  const fromSel = document.getElementById('tfFromStore');
  const toSel = document.getElementById('tfToStore');
  if (!fromSel || !toSel) return;
  const fromVal = fromSel.value;
  const toVal = toSel.value;
  
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  
  S.stores.forEach(st => {
    const o1 = document.createElement('option'); o1.value = st.store_id; o1.textContent = st.store_name; fromSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = st.store_id; o2.textContent = st.store_name; toSel.appendChild(o2);
  });
  
  if (fromVal && S.stores.some(s => s.store_id === fromVal)) fromSel.value = fromVal;
  else if (S.currentStoreId) fromSel.value = S.currentStoreId;
  
  if (toVal && S.stores.some(s => s.store_id === toVal)) toSel.value = toVal;
  else if (S.stores.length > 1) toSel.value = S.stores[1].store_id;
  
  updateTransferItems();
}

function updateTransferItems() {
  const fromStoreId = document.getElementById('tfFromStore').value;
  const itemSel = document.getElementById('tfItem');
  if (!itemSel) return;
  itemSel.innerHTML = '<option value="">商品を選択</option>';
  if (!fromStoreId) return;
  
  const names = [];
  if (S.storeStockMap) {
    Object.keys(S.storeStockMap).forEach(itemName => {
      const storeStock = S.storeStockMap[itemName][String(fromStoreId)];
      if (storeStock && storeStock.qty > 0) {
        names.push({ name: itemName, qty: storeStock.qty });
      }
    });
  }
  
  names.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
    const o = document.createElement('option');
    o.value = item.name;
    o.textContent = item.name + ' (現在:' + item.qty + ')';
    itemSel.appendChild(o);
  });
}

async function executeTransfer() {
  const fromId = document.getElementById('tfFromStore').value;
  const toId = document.getElementById('tfToStore').value;
  const name = document.getElementById('tfItem').value;
  const qty = parseInt(document.getElementById('tfQty').value, 10);
  
  if (!fromId || !toId || !name || isNaN(qty) || qty <= 0) {
    toast('正しく入力してください');
    return;
  }
  if (fromId === toId) {
    toast('移動元と移動先が同じ店舗です');
    return;
  }
  
  showLoader(true);
  try {
    // 移動元商品のドキュメントを取得
    const fromQuery = query(collection(db, 'items'), where('store_id', '==', fromId), where('name', '==', name));
    const fromDocs = await getDocs(fromQuery);
    if (fromDocs.empty) { toast('移動元の商品データが見つかりません'); return; }
    
    const fromDoc = fromDocs.docs[0];
    const fromItem = fromDoc.data();
    const fromQty = Number(fromItem.quantity) || 0;
    
    if (fromQty < qty) {
      toast('移動元の在庫が不足しています（現在の在庫: ' + fromQty + fromItem.unit + '）');
      return;
    }
    
    const batch = writeBatch(db);
    const nowStr = new Date().toISOString();
    
    // 移動元の在庫を引く
    batch.update(fromDoc.ref, {
      quantity: fromQty - qty,
      updated_at: nowStr
    });
    
    // 移動先に対象商品がすでにあるか確認
    const toQuery = query(collection(db, 'items'), where('store_id', '==', toId), where('name', '==', name));
    const toDocs = await getDocs(toQuery);
    
    if (toDocs.empty) {
      // 無い場合はマスターを自動コピーして在庫移動
      const toRef = doc(collection(db, 'items'));
      batch.set(toRef, {
        store_id: toId,
        category: fromItem.category,
        name: fromItem.name,
        unit: fromItem.unit,
        min_stock: Number(fromItem.min_stock) || 0,
        sort_order: Number(fromItem.sort_order) || 1,
        created_at: nowStr,
        quantity: qty,
        updated_at: nowStr
      });
    } else {
      // 有る場合は加算
      const toDoc = toDocs.docs[0];
      const currentToQty = Number(toDoc.data().quantity) || 0;
      batch.update(toDoc.ref, {
        quantity: currentToQty + qty,
        updated_at: nowStr
      });
    }
    
    await batch.commit();
    toast('在庫を移動しました');
    
    // 移動元のアラートチェック
    sendStoreAlertSummary(fromId);
    
    // フォームリセット
    document.getElementById('tfQty').value = 1;
  } catch (e) {
    console.error(e);
    toast('移動に失敗しました');
  } finally {
    showLoader(false);
  }
}

// ============================================================
// 画面の切替と管理者機能
// ============================================================
function showAdmin() {
  if (!checkUnsaved()) return;
  S.currentScreen = 'admin';
  document.getElementById('staffScreen').style.display = 'none';
  document.getElementById('adminScreen').style.display = 'block';
  resetEditStates();
  renderAll();
}

function showStaff() {
  if (!checkUnsaved()) return;
  S.currentScreen = 'staff';
  document.getElementById('adminScreen').style.display = 'none';
  document.getElementById('staffScreen').style.display = 'block';
  resetEditStates();
  renderAll();
}

function switchAdminTab(tab) {
  if (!checkUnsaved()) return;
  S.currentAdminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.admin-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'panel_' + tab);
  });
}

function renderAdminScreen() {
  renderStoreList();
  renderCategoriesPanel();
  renderItemColumns();
  renderDefaultColumns();
  renderNotifyPanel();
  updateDirtyUI();
}

// 店舗管理
function renderStoreList() {
  const tbody = document.getElementById('storeTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  S.stores.forEach(st => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + st.store_name + '</td><td><button class="btn-sm btn-edit">編集</button> <button class="btn-sm btn-del">削除</button></td>';
    tr.querySelector('.btn-edit').addEventListener('click', () => { editStoreModal(st.store_id, st.store_name); });
    tr.querySelector('.btn-del').addEventListener('click', () => { deleteStore(st.store_id); });
    tbody.appendChild(tr);
  });
}

function addStoreModal() {
  openModal('店舗を追加', '<label>店舗名</label><input type="text" id="modalInput1" placeholder="例: 渋谷店">', async () => {
    const name = document.getElementById('modalInput1').value.trim();
    if (!name) { toast('店舗名を入力'); return; }
    closeModal();
    await addStore(name);
  });
}

async function addStore(storeName) {
  showLoader(true);
  try {
    const storeRef = await addDoc(collection(db, 'stores'), { name: storeName });
    const storeId = storeRef.id;
    
    // 通知ドキュメントの初期化
    await setDoc(doc(db, 'notifications', storeId), {
      store_id: storeId,
      store_name: storeName,
      notification_emails: '',
      google_chat_webhook: ''
    });
    
    // デフォルト商品を新規店舗へコピー
    const batch = writeBatch(db);
    S.defaultItems.forEach(d => {
      const newItemRef = doc(collection(db, 'items'));
      batch.set(newItemRef, {
        store_id: storeId,
        category: d.category,
        name: d.name,
        unit: d.unit,
        min_stock: Number(d.min_stock) || 0,
        sort_order: Number(d.sort_order) || 1,
        created_at: new Date().toISOString(),
        quantity: 0,
        updated_at: new Date().toISOString()
      });
    });
    
    await batch.commit();
    toast(storeName + 'を追加しました');
    S.currentStoreId = storeId;
  } catch (error) {
    console.error(error);
    toast('店舗追加エラー');
  } finally {
    showLoader(false);
  }
}

function editStoreModal(id, name) {
  openModal('店舗を編集', '<label>店舗名</label><input type="text" id="modalInput1" value="' + name + '">', async () => {
    const n = document.getElementById('modalInput1').value.trim();
    if (!n) { toast('店舗名を入力'); return; }
    closeModal();
    await editStore(id, n);
  });
}

async function editStore(id, name) {
  showLoader(true);
  try {
    await updateDoc(doc(db, 'stores', id), { name });
    await updateDoc(doc(db, 'notifications', id), { store_name: name });
    toast('店舗名を更新しました');
  } catch (error) {
    console.error(error);
    toast('更新エラー');
  } finally {
    showLoader(false);
  }
}

// カテゴリ管理
function renderCategoriesPanel() {
  const c = document.getElementById('categoryListContainer');
  if (!c) return;
  c.innerHTML = '';
  if (S.editCategories.length === 0) {
    c.innerHTML = '<div style="color:var(--text-light);padding:10px">カテゴリが登録されていません</div>';
    return;
  }
  S.editCategories.forEach((cat, idx) => {
    const div = document.createElement('div');
    div.className = 'cat-item';
    div.style.padding = '8px 10px';
    div.style.border = '1px solid var(--border)';
    div.style.borderRadius = 'var(--radius-sm)';
    div.style.background = '#fff';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '8px';
    
    div.innerHTML = '<div class="cat-item-order">' +
      '<button class="btn-order btn-up" style="font-size:10px">▲</button>' +
      '<button class="btn-order btn-down" style="font-size:10px">▼</button></div>' +
      '<div class="cat-item-info" style="flex:1"><input type="text" value="' + cat.name + '" style="padding:6px;width:100%;border:1px solid var(--border);border-radius:4px;font-size:13px" class="cat-name-input" data-idx="' + idx + '"></div>' +
      '<div class="cat-item-actions"><button class="btn-sm btn-del">削除</button></div>';
      
    div.querySelector('.btn-up').addEventListener('click', () => { moveCategory(idx, -1); });
    div.querySelector('.btn-down').addEventListener('click', () => { moveCategory(idx, 1); });
    div.querySelector('.btn-del').addEventListener('click', () => { deleteCategoryLocal(idx); });
    div.querySelector('.cat-name-input').addEventListener('change', function () {
      S.editCategories[idx].name = this.value.trim();
      S.categoriesDirty = true;
      updateDirtyUI();
    });
    c.appendChild(div);
  });
}

function moveCategory(idx, dir) {
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= S.editCategories.length) return;
  const tmp = S.editCategories[idx];
  S.editCategories[idx] = S.editCategories[swapIdx];
  S.editCategories[swapIdx] = tmp;
  S.categoriesDirty = true;
  renderCategoriesPanel();
  updateDirtyUI();
}

function addCategoryLocal() {
  openModal('カテゴリを追加', '<label>カテゴリ名</label><input type="text" id="modalInput1" placeholder="例: プレゼント">', () => {
    const name = document.getElementById('modalInput1').value.trim();
    if (!name) { toast('カテゴリ名を入力してください'); return; }
    if (S.editCategories.some(c => c.name === name)) { toast('既に存在するカテゴリ名です'); return; }
    
    S.editCategories.push({
      category_id: null,
      name: name,
      sort_order: S.editCategories.length + 1
    });
    S.categoriesDirty = true;
    closeModal();
    renderCategoriesPanel();
    updateDirtyUI();
  });
}

function deleteCategoryLocal(idx) {
  const name = S.editCategories[idx].name;
  if (!confirm('カテゴリ「' + name + '」を削除しますか？\n※このカテゴリに属する商品は削除されませんが、表示するカテゴリが未設定になります。')) return;
  S.editCategories.splice(idx, 1);
  S.categoriesDirty = true;
  renderCategoriesPanel();
  updateDirtyUI();
}

async function saveCategoriesUI() {
  if (S.editCategories.length === 0) { toast('最低1つのカテゴリが必要です'); return; }
  if (S.editCategories.some(c => !c.name)) { toast('カテゴリ名が空の項目があります'); return; }
  
  showLoader(true);
  try {
    const batch = writeBatch(db);
    
    // 既存カテゴリを一括削除
    const currentCats = await getDocs(collection(db, 'categories'));
    currentCats.forEach(doc => batch.delete(doc.ref));
    
    // 新しいカテゴリを追加
    S.editCategories.forEach((c, i) => {
      const ref = doc(collection(db, 'categories'));
      batch.set(ref, {
        name: c.name,
        sort_order: i + 1
      });
    });
    
    await batch.commit();
    toast('カテゴリを保存しました');
    S.categoriesDirty = false;
    updateDirtyUI();
  } catch (error) {
    console.error(error);
    toast('カテゴリ保存エラー');
  } finally {
    showLoader(false);
  }
}

// 商品マスター（店舗ごと）
function renderItemColumns() {
  const container = document.getElementById('itemCatColumns');
  if (!container) return;
  container.innerHTML = '';
  
  S.categories.forEach(catObj => {
    const cat = catObj.name;
    const col = document.createElement('div');
    col.className = 'cat-column';
    
    const header = document.createElement('div');
    header.className = 'cat-column-header';
    header.style.background = '#1e293b';
    header.style.color = '#fff';
    header.style.padding = '8px 12px';
    header.style.fontWeight = '600';
    header.style.fontSize = '13px';
    header.textContent = cat;
    col.appendChild(header);
    
    const body = document.createElement('div');
    body.className = 'cat-column-body';
    body.id = 'itemCol_' + cat;
    
    const catItems = S.editItems.filter(i => i.category === cat).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    catItems.forEach(item => {
      const div = document.createElement('div'); div.className = 'cat-item';
      div.innerHTML = '<div class="cat-item-order">' +
        '<button class="btn-order btn-up" title="上へ">▲</button>' +
        '<button class="btn-order btn-down" title="下へ">▼</button></div>' +
        '<div class="cat-item-info"><div class="cat-item-name">' + item.name + '</div><div class="cat-item-meta">' + item.unit + ' / 下限:' + item.min_stock + '</div></div>' +
        '<div class="cat-item-actions"><button class="btn-sm btn-edit">編集</button><button class="btn-sm btn-del">削除</button></div>';
        
      div.querySelector('.btn-up').addEventListener('click', () => { moveItem(S.editItems, item, cat, -1); });
      div.querySelector('.btn-down').addEventListener('click', () => { moveItem(S.editItems, item, cat, 1); });
      div.querySelector('.btn-edit').addEventListener('click', () => { editItemLocal(item); });
      div.querySelector('.btn-del').addEventListener('click', () => { deleteItemLocal(item); });
      body.appendChild(div);
    });
    
    const btn = document.createElement('button'); btn.className = 'btn-add'; btn.style.width = '100%'; btn.style.marginTop = '8px'; btn.textContent = '＋ 追加';
    btn.addEventListener('click', () => { addItemLocal(cat); }); body.appendChild(btn);
    
    col.appendChild(body);
    container.appendChild(col);
  });
}

function moveItem(arr, item, cat, dir) {
  const catItems = arr.filter(i => i.category === cat).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const idx = catItems.indexOf(item); if (idx < 0) return;
  const swapIdx = idx + dir; if (swapIdx < 0 || swapIdx >= catItems.length) return;
  
  const tmp = item.sort_order;
  item.sort_order = catItems[swapIdx].sort_order;
  catItems[swapIdx].sort_order = tmp;
  
  if (S.currentAdminTab === 'items') {
    S.itemsDirty = true;
    renderItemColumns();
  } else {
    S.defaultsDirty = true;
    renderDefaultColumns();
  }
  updateDirtyUI();
}

function adminStoreChange() {
  if (!checkUnsaved()) return;
  S.currentStoreId = document.getElementById('adminStoreSelect').value;
  document.getElementById('storeSelect').value = S.currentStoreId;
  
  // S.items を再取得
  onSnapshot(collection(db, 'items'), (snapshot) => {
    const allItems = snapshot.docs.map(doc => ({ item_id: doc.id, ...doc.data() }));
    S.items = allItems.filter(i => String(i.store_id) === String(S.currentStoreId))
      .sort((a, b) => {
        const ci = CATS.indexOf(a.category) - CATS.indexOf(b.category);
        return ci !== 0 ? ci : (a.sort_order || 0) - (b.sort_order || 0);
      });
    resetEditStates();
    renderAll();
  });
}

function addItemLocal(cat) {
  if (!S.currentStoreId) { toast('店舗を選択'); return; }
  openModal(cat + 'を追加', '<label>商品名</label><input type="text" id="modalInput1"><label>単位</label><input type="text" id="modalInput2" placeholder="例: パック"><label>下限在庫数</label><input type="number" id="modalInput3" min="0" value="0">', () => {
    const n = document.getElementById('modalInput1').value.trim(), u = document.getElementById('modalInput2').value.trim(), m = parseInt(document.getElementById('modalInput3').value) || 0;
    if (!n || !u) { toast('入力してください'); return; }
    const items = S.editItems.filter(i => i.category === cat);
    const so = items.length > 0 ? Math.max(...items.map(i => i.sort_order || 0)) + 1 : 1;
    
    S.editItems.push({ item_id: null, store_id: S.currentStoreId, category: cat, name: n, unit: u, min_stock: m, sort_order: so });
    S.itemsDirty = true; closeModal(); renderItemColumns(); updateDirtyUI();
  });
}

function editItemLocal(item) {
  openModal('商品を編集', '<label>商品名</label><input type="text" id="modalInput1" value="' + item.name + '"><label>単位</label><input type="text" id="modalInput2" value="' + item.unit + '"><label>下限在庫数</label><input type="number" id="modalInput3" min="0" value="' + item.min_stock + '">', () => {
    const n = document.getElementById('modalInput1').value.trim(), u = document.getElementById('modalInput2').value.trim(), m = parseInt(document.getElementById('modalInput3').value) || 0;
    if (!n || !u) { toast('入力してください'); return; }
    item.name = n; item.unit = u; item.min_stock = m; S.itemsDirty = true; closeModal(); renderItemColumns(); updateDirtyUI();
  });
}

function deleteItemLocal(item) {
  if (!confirm(item.name + 'を削除しますか？')) return;
  S.editItems = S.editItems.filter(i => i !== item);
  S.itemsDirty = true; renderItemColumns(); updateDirtyUI();
}

async function saveItems() {
  if (!S.currentStoreId) { toast('店舗を選択'); return; }
  showLoader(true);
  try {
    const storeId = S.currentStoreId;
    
    // 既存のFirestoreドキュメントID一覧を取得
    const q = query(collection(db, 'items'), where('store_id', '==', storeId));
    const currentDocs = await getDocs(q);
    const keptIds = S.editItems.filter(i => i.item_id).map(i => i.item_id);
    
    const batch = writeBatch(db);
    const nowStr = new Date().toISOString();
    
    // 1. 削除された商品をFirestoreから削除
    currentDocs.docs.forEach(doc => {
      if (!keptIds.includes(doc.id)) {
        batch.delete(doc.ref);
      }
    });
    
    // 2. 新規追加・更新を反映
    S.editItems.forEach(item => {
      if (item.item_id) {
        batch.update(doc(db, 'items', item.item_id), {
          category: item.category,
          name: item.name,
          unit: item.unit,
          min_stock: Number(item.min_stock) || 0,
          sort_order: Number(item.sort_order) || 1
        });
      } else {
        const newRef = doc(collection(db, 'items'));
        batch.set(newRef, {
          store_id: storeId,
          category: item.category,
          name: item.name,
          unit: item.unit,
          min_stock: Number(item.min_stock) || 0,
          sort_order: Number(item.sort_order) || 1,
          created_at: nowStr,
          quantity: 0,
          updated_at: nowStr
        });
      }
    });
    
    await batch.commit();
    toast('商品マスターを保存しました');
    S.itemsDirty = false;
    updateDirtyUI();
  } catch (error) {
    console.error(error);
    toast('保存エラー');
  } finally {
    showLoader(false);
  }
}

// デフォルト商品管理
function renderDefaultColumns() {
  const container = document.getElementById('defCatColumns');
  if (!container) return;
  container.innerHTML = '';
  
  S.categories.forEach(catObj => {
    const cat = catObj.name;
    const col = document.createElement('div');
    col.className = 'cat-column';
    
    const header = document.createElement('div');
    header.className = 'cat-column-header';
    header.style.background = '#1e293b';
    header.style.color = '#fff';
    header.style.padding = '8px 12px';
    header.style.fontWeight = '600';
    header.style.fontSize = '13px';
    header.textContent = cat;
    col.appendChild(header);
    
    const body = document.createElement('div');
    body.className = 'cat-column-body';
    body.id = 'defCol_' + cat;
    
    const catItems = S.editDefaultItems.filter(i => i.category === cat).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    catItems.forEach(item => {
      const div = document.createElement('div'); div.className = 'cat-item';
      div.innerHTML = '<div class="cat-item-order">' +
        '<button class="btn-order btn-up" title="上へ">▲</button>' +
        '<button class="btn-order btn-down" title="下へ">▼</button></div>' +
        '<div class="cat-item-info"><div class="cat-item-name">' + item.name + '</div><div class="cat-item-meta">' + item.unit + ' / 下限:' + item.min_stock + '</div></div>' +
        '<div class="cat-item-actions"><button class="btn-sm btn-edit">編集</button><button class="btn-sm btn-del">削除</button></div>';
        
      div.querySelector('.btn-up').addEventListener('click', () => { moveItem(S.editDefaultItems, item, cat, -1); });
      div.querySelector('.btn-down').addEventListener('click', () => { moveItem(S.editDefaultItems, item, cat, 1); });
      div.querySelector('.btn-edit').addEventListener('click', () => { editDefaultLocal(item); });
      div.querySelector('.btn-del').addEventListener('click', () => { deleteDefaultLocal(item); });
      body.appendChild(div);
    });
    
    const btn = document.createElement('button'); btn.className = 'btn-add'; btn.style.width = '100%'; btn.style.marginTop = '8px'; btn.textContent = '＋ 追加';
    btn.addEventListener('click', () => { addDefaultLocal(cat); }); body.appendChild(btn);
    
    col.appendChild(body);
    container.appendChild(col);
  });
}

function addDefaultLocal(cat) {
  openModal('デフォルト' + cat + 'を追加', '<label>商品名</label><input type="text" id="modalInput1"><label>単位</label><input type="text" id="modalInput2"><label>下限在庫数</label><input type="number" id="modalInput3" min="0" value="0">', () => {
    const n = document.getElementById('modalInput1').value.trim(), u = document.getElementById('modalInput2').value.trim(), m = parseInt(document.getElementById('modalInput3').value) || 0;
    if (!n || !u) { toast('入力してください'); return; }
    const items = S.editDefaultItems.filter(i => i.category === cat);
    const so = items.length > 0 ? Math.max(...items.map(i => i.sort_order || 0)) + 1 : 1;
    
    S.editDefaultItems.push({ default_id: null, category: cat, name: n, unit: u, min_stock: m, sort_order: so });
    S.defaultsDirty = true; closeModal(); renderDefaultColumns(); updateDirtyUI();
  });
}

function editDefaultLocal(item) {
  openModal('デフォルト商品を編集', '<label>商品名</label><input type="text" id="modalInput1" value="' + item.name + '"><label>単位</label><input type="text" id="modalInput2" value="' + item.unit + '"><label>下限在庫数</label><input type="number" id="modalInput3" min="0" value="' + item.min_stock + '">', () => {
    const n = document.getElementById('modalInput1').value.trim(), u = document.getElementById('modalInput2').value.trim(), m = parseInt(document.getElementById('modalInput3').value) || 0;
    if (!n || !u) { toast('入力してください'); return; }
    item.name = n; item.unit = u; item.min_stock = m; S.defaultsDirty = true; closeModal(); renderDefaultColumns(); updateDirtyUI();
  });
}

function deleteDefaultLocal(item) {
  if (!confirm(item.name + 'を削除？')) return;
  S.editDefaultItems = S.editDefaultItems.filter(d => d !== item);
  S.defaultsDirty = true; renderDefaultColumns(); updateDirtyUI();
}

async function saveDefaults() {
  showLoader(true);
  try {
    const batch = writeBatch(db);
    const nowStr = new Date().toISOString();
    
    // 現在のFirestore上のデフォルトIDを取得
    const currentDefs = await getDocs(collection(db, 'default_items'));
    const keptDefIds = S.editDefaultItems.filter(d => d.default_id).map(d => d.default_id);
    
    // 1. 削除処理
    currentDefs.docs.forEach(doc => {
      if (!keptDefIds.includes(doc.id)) {
        batch.delete(doc.ref);
      }
    });
    
    const newDefaults = [];
    
    // 2. 新規および更新
    S.editDefaultItems.forEach(item => {
      if (item.default_id) {
        batch.update(doc(db, 'default_items', item.default_id), {
          category: item.category,
          name: item.name,
          unit: item.unit,
          min_stock: Number(item.min_stock) || 0,
          sort_order: Number(item.sort_order) || 1
        });
      } else {
        const newRef = doc(collection(db, 'default_items'));
        const dData = {
          category: item.category,
          name: item.name,
          unit: item.unit,
          min_stock: Number(item.min_stock) || 0,
          sort_order: Number(item.sort_order) || 1
        };
        batch.set(newRef, dData);
        newDefaults.push(dData);
      }
    });
    
    // 新規追加されたデフォルト商品は、全店舗に初期在庫0で自動追加同期
    if (newDefaults.length > 0 && S.stores.length > 0) {
      S.stores.forEach(store => {
        newDefaults.forEach(nd => {
          const itemRef = doc(collection(db, 'items'));
          batch.set(itemRef, {
            store_id: store.store_id,
            category: nd.category,
            name: nd.name,
            unit: nd.unit,
            min_stock: nd.min_stock,
            sort_order: nd.sort_order,
            created_at: nowStr,
            quantity: 0,
            updated_at: nowStr
          });
        });
      });
    }
    
    await batch.commit();
    const msg = 'デフォルト商品を保存しました' + (newDefaults.length > 0 ? `（${newDefaults.length}件を全店舗に追加）` : '');
    toast(msg);
    S.defaultsDirty = false;
    updateDirtyUI();
  } catch (error) {
    console.error(error);
    toast('保存エラー');
  } finally {
    showLoader(false);
  }
}

// 通知設定
function renderNotifyPanel() {
  const c = document.getElementById('notifyContainer'); if (!c) return;
  c.innerHTML = '';
  S.stores.forEach(store => {
    const notif = S.notifications.find(n => String(n.store_id) === String(store.store_id)) || { notification_emails: '', google_chat_webhook: '' };
    const card = document.createElement('div'); card.className = 'notify-card'; card.id = 'notify_' + store.store_id;
    card.innerHTML = '<h4>🏢 ' + store.store_name + '</h4>' +
      '<label>📧 メールアドレス（カンマ区切りで複数設定可能）</label>' +
      '<textarea data-store="' + store.store_id + '" data-field="emails" placeholder="例: test1@example.com, test2@example.com">' + (notif.notification_emails || '') + '</textarea>' +
      '<label>💬 Google Chat Webhook URL</label>' +
      '<input type="url" data-store="' + store.store_id + '" data-field="webhook" value="' + (notif.google_chat_webhook || '') + '" placeholder="https://chat.googleapis.com/v1/spaces/...">' +
      '<button class="btn-sm btn-edit" style="margin-top:10px" onclick="sendTestNotification(\'' + store.store_id + '\')">🧪 テスト通知を送信</button>';
      
    card.querySelectorAll('input,textarea').forEach(el => {
      el.addEventListener('input', () => {
        S.notifyDirty = true;
        updateDirtyUI();
      });
    });
    c.appendChild(card);
  });
}

function notifyStoreJump() {
  const el = document.getElementById('notify_' + document.getElementById('notifyStoreJump').value);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveNotify() {
  showLoader(true);
  try {
    const batch = writeBatch(db);
    S.stores.forEach(store => {
      const e = document.querySelector('[data-store="' + store.store_id + '"][data-field="emails"]');
      const w = document.querySelector('[data-store="' + store.store_id + '"][data-field="webhook"]');
      
      batch.update(doc(db, 'notifications', store.store_id), {
        notification_emails: e ? e.value.trim() : '',
        google_chat_webhook: w ? w.value.trim() : ''
      });
    });
    
    await batch.commit();
    toast('通知設定を保存しました');
    S.notifyDirty = false;
    updateDirtyUI();
  } catch (error) {
    console.error(error);
    toast('保存エラー');
  } finally {
    showLoader(false);
  }
}

// ============================================================
// 在庫CSV出力 (ブラウザ完結型へアップグレード)
// ============================================================
function downloadInventoryCSV() {
  const btn = document.getElementById('btnExportCsv');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中...'; }
  
  try {
    const storeMap = {};
    S.stores.forEach(s => { storeMap[String(s.store_id)] = s.store_name; });
    
    const rows = [['商品名', '店舗名', '在庫数']];
    
    Object.keys(S.storeStockMap).forEach(itemName => {
      const stocks = S.storeStockMap[itemName];
      S.stores.forEach(store => {
        const storeId = String(store.store_id);
        const storeName = store.store_name;
        const qty = stocks[storeId] ? Number(stocks[storeId].qty) || 0 : 0;
        rows.push([itemName, storeName, qty]);
      });
    });
    
    const csvLines = rows.map(row => {
      return row.map(cell => {
        let s = String(cell);
        if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
          s = '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(',');
    });
    
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = n => ('0' + n).slice(-2);
    const fileName = '在庫一覧_' +
      now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '_' +
      pad(now.getHours()) + pad(now.getMinutes()) + '.csv';
    
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('CSVをダウンロードしました');
  } catch (e) {
    console.error(e);
    toast('CSV出力に失敗しました');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '📥 在庫CSV出力'; }
  }
}

// モーダル管理ヘルパー
function openModal(title, bodyHTML, onOk) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').classList.add('show');
  window._modalOk = onOk;
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  window._modalOk = null;
}

function modalOk() {
  if (window._modalOk) window._modalOk();
}

// HTMLから直接呼ばれるイベント用に関数を window オブジェクトへバインド
window.showAdmin = showAdmin;
window.showStaff = showStaff;
window.switchStore = switchStore;
window.saveStaffInventory = saveStaffInventory;
window.executeTransfer = executeTransfer;
window.updateTransferItems = updateTransferItems;
window.switchAdminTab = switchAdminTab;
window.addStoreModal = addStoreModal;
window.saveCategoriesUI = saveCategoriesUI;
window.addCategoryLocal = addCategoryLocal;
window.saveItems = saveItems;
window.adminStoreChange = adminStoreChange;
window.saveDefaults = saveDefaults;
window.saveNotify = saveNotify;
window.notifyStoreJump = notifyStoreJump;
window.downloadInventoryCSV = downloadInventoryCSV;
window.closeModal = closeModal;
window.modalOk = modalOk;
window.sendTestNotification = sendTestNotification;

// 起動開始
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '保存されていない変更があります。';
  }
});
