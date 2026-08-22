// 虹カフェ アプリ  ── 2026/08/09 改修版（改修①）
//  1. 残高不足のときは注文ボタンを押せないようにした（見た目だけでなく処理でも停止）
//  2. 暗証番号の重複を登録・変更のときに弾くようにした（他人のチケットが開くのを防止）
//  3. スタッフが注文をキャンセルしたとき、使った特典・VIPプレゼントを元に戻すようにした
//  4. POSで決済するとき、未処理のアプリ注文があれば二重決済の警告を出すようにした
//  5. 通信量の削減：同期の間隔を3秒→8秒、ホーム画面と非表示タブでは同期しない
//     （画面に戻った瞬間に必ず取り直すので、古いデータのまま操作されることはない）
//  6. 会員が0人のときの新規登録で会員番号がおかしくなる不具合を修正
//  ※ データを消す・作り変える変更は一切していません。
//
// ── 2026/08/10 改修② 通信量の追加削減 ──────────────────
//  7. 定期同期で注文を「新しい方から60件」だけ取得し、手元の全件に差分反映する方式に変更
//     （全件取得は起動時のみ。履歴は欠けない。他端末での完了・キャンセル・新規注文も反映される）
//     1端末あたりの通信量の目安：68MB/日 → 27MB/日
//  ※ こちらもデータベースへの書き込み方は一切変えていません。
//
// ── 2026/08/10 改修③ 完了注文のアーカイブ対応 ──────────────
//  8. 会計履歴の画面で `cafe_v4_orders_archive`（過去の完了注文の置き場）も読むようにした。
//     アーカイブがまだ無くても動く。移行中に同じ注文が両方にあっても重複表示しない。
import { useState, useEffect, useRef } from "react";
import { flushSync } from "react-dom";

// ══════════════════════════════════════════
//  🔥 Firebase 設定（REST API + 匿名認証トークン）
// ══════════════════════════════════════════
const FIREBASE_API_KEY = "AIzaSyC58_CHa0RS0PtjnrotgrTt8Jc67tlDpWM";
const DB_BASE = "https://nizicafe-card-default-rtdb.asia-southeast1.firebasedatabase.app";

// 匿名ログインの「会員証（IDトークン）」を取得・保持する。
// Firebase の認証 REST API を直接呼ぶので、SDK のビルド差異に左右されず確実に動く。
let _authToken = null;       // 現在のトークン
let _authTokenExp = 0;       // 有効期限（ミリ秒）
let _authPromise = null;     // 取得中の重複呼び出しを防ぐ

async function fetchNewToken() {
  // 匿名サインアップでトークンを新規取得
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error("auth failed");
  const data = await res.json();
  _authToken = data.idToken;
  // expiresIn は秒。安全のため少し早め（60秒手前）に期限切れ扱いにする
  const ttl = (parseInt(data.expiresIn, 10) || 3600) * 1000;
  _authTokenExp = Date.now() + ttl - 60000;
  return _authToken;
}

async function getAuthToken() {
  try {
    // まだ有効なトークンがあれば使い回す
    if (_authToken && Date.now() < _authTokenExp) return _authToken;
    // 取得中なら、その結果を待つ（同時に何度も取りに行かない）
    if (_authPromise) return await _authPromise;
    _authPromise = fetchNewToken().finally(() => { _authPromise = null; });
    return await _authPromise;
  } catch {
    return null;
  }
}

// アプリ起動時に先にトークンを取りに行っておく（書き込み時に待たないように）
getAuthToken();

// ══════════════════════════════════════════
//  サーバー（/api）経由のログイン
// ══════════════════════════════════════════
// パスワードの照合を、ブラウザではなくサーバーの中で行う。
// ここが動くようになると、スタッフのパスワードをブラウザに配る必要がなくなる。
// 発行されたログイン証（トークン）は、この後の段階で読み書きにも使う。
// スタッフ／マネージャーのログイン証。ここに入っていると dbGet/dbSet がサーバー経由になる。
// お客様のログイン証はここには入れない（お客様は自分専用の窓口だけを使うため）。
let _apiToken = null;
const setApiToken = (t) => { _apiToken = t; };

const apiLogin = async (role, body) => {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, ...body }),
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    // 401（パスワード違い）は「そのまま伝える」。それ以外はサーバー側の不調とみなす。
    const err = new Error(json.error || "ログインに失敗しました");
    err.rejected = res.status === 401 || res.status === 400;
    throw err;
  }
  return json;   // ログイン証をどこに保持するかは、呼び出し側が決める
};

// サーバー経由でデータを読み書きする。
// サーバー側で「その人が触ってよい範囲か」を確認してから Firebase に届く。
// token を省略するとスタッフのログイン証を使う。お客様は自分の証を明示的に渡す。
const apiData = async (op, payload, token) => {
  const res = await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token || _apiToken}` },
    body: JSON.stringify({ op, ...payload }),
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(json.error || "通信に失敗しました");
    err.status = res.status;
    throw err;
  }
  return json;
};

// ログイン証は12時間で切れる。切れたまま操作を続けると、
// 「保存に失敗しました」とだけ出て理由が分からないので、はっきり伝えて入り直してもらう。
let _expiredNotified = false;
const notifyExpired = () => {
  _apiToken = null;
  if (_expiredNotified) return;
  _expiredNotified = true;
  try { alert("ログインの有効期限が切れました。\n「← ホームへ」から、もう一度ログインしてください。"); } catch {}
  setTimeout(() => { _expiredNotified = false; }, 10000);
};

const dbSet = async (key, val) => {
  // スタッフがログイン済みならサーバー経由で保存する。
  if (_apiToken) {
    try { await apiData("set", { key, value: val }); return true; }
    catch (e) {
      if (e.status === 401) { notifyExpired(); return false; }
      console.warn("サーバー経由の保存に失敗したため、直接保存に切り替えます", key, e);
    }
  }
  // 保存は最大3回まで自動リトライ。最後まで失敗したら画面に通知する。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getAuthToken();
      const url = `${DB_BASE}/${key}.json${token ? `?auth=${token}` : ""}`;
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(val) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return true;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 600)); continue; }
      console.error("保存に失敗しました", key, e);
      try { alert("保存に失敗しました。通信状況を確認して、もう一度お試しください。"); } catch {}
      return false;
    }
  }
};

// お金の出入りを、消えない別の場所に記録しておくための書き込み。
// 会員データの history は60件で古いものが切り捨てられるため、
// チャージ・チャージ取消・残高の手修正だけは、こちらにも1件ずつ積んでおく。
// POST を使うと Firebase が勝手にキーを振ってくれるので、
// 既存の全件を読み書きする必要がなく、通信量もほとんど増えない。
const dbPush = async (key, val) => {
  // 入出金の台帳への追記も、ログイン済みならサーバー経由（誰が記録したかも残る）
  if (_apiToken) {
    try { await apiData("push", { key, value: val }); return; }
    catch (e) { console.warn("サーバー経由の追記に失敗したため、直接追記に切り替えます", key, e); }
  }
  try {
    const token = await getAuthToken();
    const url = `${DB_BASE}/${key}.json${token ? `?auth=${token}` : ""}`;
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(val) });
  } catch (e) {
    // ここが失敗しても、本来の残高の記録（history）は別途保存されるので、画面は止めない
    console.error("入出金ログの記録に失敗しました", e);
  }
};

// チャージ・取消・残高手修正を、消えない台帳に残す
const logMoney = (entry) => dbPush("cafe_v4_money_log", {
  ...entry,
  at: new Date().toLocaleString("ja-JP"),
  atISO: new Date().toISOString(),
});

// ══════════════════════════════════════════
//  売上を「消えない台帳」に1件ずつ残す
// ══════════════════════════════════════════
// これまで売上の記録は、会員データの中の history にしか残っていなかった。
// history は1人あたり60件までで、古いものから捨てられる。
// つまり、よく来てくださるお客様ほど、過去の会計記録が先に消えていた。
// （会計履歴タブも日次レポートも、その history を見ていた）
//
// ここでは会計のたびに、独立した台帳へ1件ずつ積んでいく。
// 追記なので他の記録を巻き込まず、通信量もほとんど増えない。
// date は会員データの history と同じ書き方にしてある（同じ会計を二重に数えないため）。
const logSale = (entry) => dbPush("cafe_v4_sales_log", {
  ...entry,
  day: new Date().toLocaleDateString("ja-JP"),
  atISO: new Date().toISOString(),
});

// 台帳から新しい方だけを取り出す（全部読むと通信量が増えていくため）
const SALES_LOG_QUERY = `orderBy=%22%24key%22&limitToLast=500`;

// 会員1人ぶんだけをサーバーに保存する。
// 成功したら true、できなかったら false（呼び出し側が従来の方法に切り替える）。
const saveOneCustomer = async (c) => {
  if (!_apiToken || !c || !c.id) return false;
  try {
    await apiData("patchCustomer", { value: { id: c.id, fields: c } });
    return true;
  } catch (e) {
    if (e.status === 401) { notifyExpired(); return false; }
    console.warn("1人ぶんの保存に失敗したため、一覧まるごとの保存に切り替えます", e);
    return false;
  }
};

const dbGet = async (key, query) => {
  // スタッフがログイン済みならサーバー経由で取得する（不調なら直接取得に切り替える）
  if (_apiToken) {
    try { return (await apiData("get", { key, query })).value; }
    catch (e) {
      if (e.status === 401) { notifyExpired(); return null; }
      console.warn("サーバー経由の取得に失敗したため、直接取得に切り替えます", key, e);
    }
  }
  try {
    const token = await getAuthToken();
    const params = [];
    if (token) params.push(`auth=${token}`);
    if (query) params.push(query);
    const url = `${DB_BASE}/${key}.json${params.length ? `?${params.join("&")}` : ""}`;
    const r = await fetch(url);
    // 失敗した応答（例：権限なしのときの {"error":"Permission denied"}）を
    // データとして受け取ってしまわないよう、必ず null にする。
    if (!r.ok) return null;
    const v = await r.json();
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.error === "string") return null;
    return v;
  } catch {
    return null;
  }
};

// ══════════════════════════════════════════
//  注文の「新しい方だけ」を取りに行うための仕組み（通信量の削減）
// ══════════════════════════════════════════
// 注文は配列の先頭が最新。定期同期のたびに全件（gzipで約10KB）を取りに行くと
// 1端末あたり月2GB前後になるため、定期同期では新しい方から ORDER_WINDOW 件だけを取得し、
// 手元の全件リストに差分として反映する。窓の外にある過去の注文は手元のものを残すので、
// 履歴が欠けることはない。全件は起動時の読み込みで取得している。
const ORDER_WINDOW = 60;
const ORDER_WINDOW_QUERY = `orderBy=%22%24key%22&limitToFirst=${ORDER_WINDOW}`;

// Firebase は配列として保存していても、途中のキーが欠けるとオブジェクトで返すことがある。
// どちらで返ってきても「新しい順の配列」に揃える。
function toOrderArray(v) {
  if (Array.isArray(v)) return v.filter(o => o && o.orderId);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort((a, b) => Number(a) - Number(b))
      .map(k => v[k])
      .filter(o => o && o.orderId);
  }
  return null;
}

// 手元の全件（prevFull）に、サーバから来た新しい方 ORDER_WINDOW 件（win）を反映する。
//  ・両方にある注文  → サーバ側の内容で更新（他端末での完了・キャンセルが反映される）
//  ・サーバにだけある → 他端末で作られた新しい注文なので先頭に追加
//  ・窓の中にいたはずなのに手元にしか無い → 他端末で削除されたとみなして取り除く
//    （窓に何件の新規が入ったかを差し引いて「窓が確実に届いている範囲」だけを対象にするので、
//     新規注文で押し出された過去の注文を誤って消すことはない）
// 何か想定外のことが起きても、必ず「手元のリストをそのまま返す」に倒れるようにしてある。
// （この関数は setOrders の更新関数の中で動くため、ここで例外を投げると画面が落ちてしまう）
function mergeOrderWindow(prevFull, win) {
  try {
    const winList = toOrderArray(win);
    if (!winList) return prevFull;                 // 取得失敗時は手元をそのまま維持
    const prevList = toOrderArray(prevFull) || [];
    if (prevList.length === 0) return winList;

    const prevIds = new Set(prevList.map(o => o.orderId));
    const addedCount = winList.filter(o => !prevIds.has(o.orderId)).length;
    const coverage = Math.max(0, winList.length - addedCount - 1);

    const winById = new Map(winList.map(o => [o.orderId, o]));
    const kept = [];
    prevList.forEach((o, i) => {
      const fresh = winById.get(o.orderId);
      if (fresh) { kept.push(fresh); winById.delete(o.orderId); return; }
      if (i < coverage) return;                    // 窓の中に無い＝他端末で削除された
      kept.push(o);                                // 窓の外の過去分はそのまま残す
    });
    const added = winList.filter(o => winById.has(o.orderId));
    return added.concat(kept);
  } catch (e) {
    console.error("注文の差分反映に失敗したため、手元のデータを維持します", e);
    return prevFull;
  }
}
// ══════════════════════════════════════════
// 売上集計（その日の合計を加算。日付が変わったらリセット）
const recordSale = async (amount, isCash) => {
  try {
    const today = new Date().toLocaleDateString("sv-SE");
    const cur = await dbGet("cafe_v4_payment_today");
    const base = (cur && cur.date === today) ? cur : { date: today, totalSales: 0, cashSales: 0 };
    await dbSet("cafe_v4_payment_today", {
      date: today,
      totalSales: (base.totalSales || 0) + (amount || 0),
      cashSales: (base.cashSales || 0) + (isCash ? (amount || 0) : 0),
      at: new Date().toLocaleString("ja-JP"),
    });
  } catch {}
};

//  設定
// ══════════════════════════════════════════
const DEFAULT_MANAGER_ACCOUNTS = [
  { id:"mg1", name:"マネージャー", password:"5678", linkedCustomerId:null },
]; // マネージャーアカウント初期値

const DEFAULT_STAFF_ACCOUNTS = [
  { id:"st1", name:"山田 花子", password:"1234" },
  { id:"st2", name:"田中 一郎", password:"2345" },
];

// 暗証番号の重複チェック（自分自身は除く）
// 同じ暗証番号の会員が2人いると、お客様画面で別人のチケットが開いてしまうため必ず弾く
function findPinOwner(pin, customers, selfId) {
  const v = String(pin ?? "").trim();
  if (!v) return null;
  return (customers || []).find(c => c && c.id !== selfId && String(c.pin ?? "").trim() === v) || null;
}

// 店長/マネージャーが会員の暗証番号(PIN)だけを変更する小モーダル
function PinChangeModal({ customer, customers, onSave, onClose }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    const v = (pin||"").trim();
    if (!/^\d{4}$/.test(v)) { setErr("暗証番号は4桁の数字で入力してください"); return; }
    const owner = findPinOwner(v, customers, customer.id);
    if (owner) { setErr(`この暗証番号は「${owner.name}」さんが使用中です。別の番号にしてください`); return; }
    onSave(v);
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(61,54,48,0.35)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}} onClick={onClose}>
      <div style={{background:"var(--card,#ffffff)",border:"1px solid #d3a94f55",borderRadius:16,padding:"20px",width:"100%",maxWidth:340}} onClick={e=>e.stopPropagation()}>
        <div style={{fontWeight:700,color:"var(--gold,#b07c1e)",fontSize:"1rem",marginBottom:4}}>🔑 暗証番号の変更</div>
        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginBottom:14}}>{customer.name} さんの新しい暗証番号（4桁）を入力してください。</div>
        <input value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} inputMode="numeric" maxLength={4} placeholder="0000" autoFocus style={{width:"100%",boxSizing:"border-box",background:"var(--card,#ffffff)",border:"1px solid #ddd3c6",borderRadius:12,color:"var(--ink,#3d3630)",fontSize:"1.4rem",letterSpacing:"0.3em",textAlign:"center",padding:"12px"}}/>
        {err && <div style={{color:"#c94a45",fontSize:"0.85rem",marginTop:8}}>{err}</div>}
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <button onClick={onClose} style={{flex:1,background:"var(--panel2,#f6f1ea)",border:"none",borderRadius:12,color:"var(--ink2,#8a7f76)",padding:"12px",fontWeight:600,cursor:"pointer"}}>キャンセル</button>
          <button onClick={submit} style={{flex:1,background:"linear-gradient(135deg,#e8b96a,#d9a441)",border:"none",borderRadius:12,color:"var(--ink,#3d3630)",padding:"12px",fontWeight:700,cursor:"pointer"}}>変更する</button>
        </div>
      </div>
    </div>
  );
}

// benefit.type:
//   "monthly"   → 毎月1回リセット、スタッフが「使用」ボタンで消費
//   "always_discount" → 毎回自動割引（amount: 固定額 or "half"）
const RANKS = [
  { name:"ブロンズ",    min:2,  color:"#a2622a", gem:"🟫", bg:"linear-gradient(135deg,#f6e6d8,#eed3bb)", glow:"#cd7f32",
    benefit:{ type:"monthly",          desc:"トッピング1回無料",       icon:"🧁" } },
  // ※ シルバー・プラチナ・チタンの3つは、以前ほぼ同じ薄い灰色だった。
  //    バッジもバーも背景に溶けて読めなかったので、それぞれ濃さと色味を分けてある。
  { name:"シルバー",    min:5,  color:"#6c727e", gem:"⬜", bg:"linear-gradient(135deg,#dfe3ea,#c9cfda)", glow:"#a8b0bd",
    benefit:{ type:"monthly",          desc:"トッピング2回無料",       icon:"🧁🧁" } },
  { name:"ゴールド",    min:7,  color:"#a9791a", gem:"🟨", bg:"linear-gradient(135deg,#fbf0d6,#f5e2b0)", glow:"#ffd700",
    benefit:{ type:"monthly",          desc:"トッピング3回無料",       icon:"🧁🧁🧁" } },
  { name:"プラチナ",    min:10, color:"#8a6f52", gem:"🔘", bg:"linear-gradient(135deg,#f0e8dc,#e2d6c4)", glow:"#cbb89f",
    benefit:{ type:"monthly",          desc:"コーヒー1杯無料",         icon:"☕" } },
  { name:"チタン",      min:13, color:"#4f6b7a", gem:"🩶", bg:"linear-gradient(135deg,#dce7ee,#c2d3de)", glow:"#8ba4b3",
    benefit:{ type:"monthly",          desc:"指定ドリンク1杯無料",     icon:"🥤" } },
  { name:"サファイア",  min:16, color:"#3b7fb8", gem:"🔷", bg:"linear-gradient(135deg,#e4eefb,#cddff5)", glow:"#4fa3e8",
    benefit:{ type:"monthly",          desc:"好きなドリンク1杯無料",   icon:"🍹" } },
  { name:"ルビー",      min:20, color:"#c21354", gem:"🟥", bg:"linear-gradient(135deg,#fbecf2,#f7dbe6)", glow:"#e0115f",
    benefit:{ type:"always_discount",  desc:"毎回50円引き",            icon:"💸", amount:50 } },
  { name:"エメラルド",  min:35, color:"#3e9a5c", gem:"🟩", bg:"linear-gradient(135deg,#e3f3e8,#c9e7d3)", glow:"#50c878",
    benefit:{ type:"always_discount",  desc:"毎回100円引き",           icon:"💸", amount:100 } },
  { name:"ダイヤモンド",min:50, color:"#3b8fa8", gem:"💎", bg:"linear-gradient(135deg,#e6f3f7,#cfe8f0)", glow:"#b9f2ff",
    benefit:{ type:"always_discount",  desc:"毎回半額",                icon:"⭐", amount:"half" } },
];

const NO_RANK = {
  name:"ランクなし", min:0, color:"var(--ink3,#9a8f85)", gem:"−",
  bg:"linear-gradient(135deg,#f4f1ec,#e8e2da)", glow:"#444",
  benefit:{ type:"none", desc:"ランクなし", icon:"−" },
};

function getRank(p) {
  if (p < 2) return NO_RANK;
  let r = RANKS[0];
  for (const x of RANKS) if (p >= x.min) r = x;
  return r;
}
// 昨年・今年の高い方のランクを返す
function getEffectiveRank(customer) {
  const r1 = getRank(customer.rankBasis ?? 0);
  const r2 = getRank(customer.currentYearPurchases ?? 0);
  const i1 = RANKS.findIndex(r => r.name === r1.name);
  const i2 = RANKS.findIndex(r => r.name === r2.name);
  return i2 > i1 ? r2 : r1;
}
function nextRank(p)   { for(const x of RANKS) if(p<x.min) return x; return null; }
function currentMonth(){ return new Date().toISOString().slice(0,7); } // "2026-05"

// トッピング最大選択数（ランク別）
function getToppingMax(rank) {
  if (!rank) return 0;
  return rank.name==="ブロンズ"?1 : rank.name==="シルバー"?2 : rank.name==="ゴールド"?3 : 0;
}
// 今月の残りトッピング使用可能数
function getToppingAvailable(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return 0;
  if (customer.toppingRemainingMonth !== currentMonth()) return max;
  return customer.toppingRemaining ?? max;
}
// 非トッピング特典が使用済みか
function isBenefitUsed(customer) {
  return customer.benefitUsedMonth === currentMonth();
}
// トッピング特典が完全使用済みか（0回になった）
function isToppingFullyUsed(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return false;
  if (customer.toppingRemainingMonth !== currentMonth()) return false;
  return (customer.toppingRemaining ?? max) === 0;
}

// always_discount の割引額を計算
function calcDiscount(rank, total) {
  if (rank.benefit.type !== "always_discount") return 0;
  if (rank.benefit.amount === "half") return Math.floor(total / 2);
  return Math.min(rank.benefit.amount, total);
}

// currentYearPurchases: 今年の購入回数（1/1にリセット）
// rankBasis: ランク判定に使う値（前年の購入回数、1/1に更新）
// dataYear: currentYearPurchasesが属する年
const THIS_YEAR = new Date().getFullYear();
const SAMPLE = [
  { id:"1001", name:"田中 美咲", pin:"1234", balance:4000, currentYearPurchases:10, rankBasis:10, dataYear:THIS_YEAR, joined:"2024-11-01", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-2, purchases:6,  rankName:"ゴールド",    rankGem:"🟨", rankColor:"#ffd700" },
      { year:THIS_YEAR-1, purchases:10, rankName:"プラチナ",    rankGem:"🔘", rankColor:"#e0dcd8" },
    ]},
  { id:"1002", name:"佐藤 健太", pin:"5678", balance:2000, currentYearPurchases:5,  rankBasis:5,  dataYear:THIS_YEAR, joined:"2025-02-14", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-1, purchases:3, rankName:"ブロンズ", rankGem:"🟫", rankColor:"#cd7f32" },
    ]},
  { id:"1003", name:"鈴木 花子", pin:"9999", balance:0, currentYearPurchases:52, rankBasis:52, dataYear:THIS_YEAR, joined:"2024-05-20", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-3, purchases:20, rankName:"ルビー",       rankGem:"🟥", rankColor:"#e0115f" },
      { year:THIS_YEAR-2, purchases:38, rankName:"エメラルド",   rankGem:"🟩", rankColor:"#50c878" },
      { year:THIS_YEAR-1, purchases:52, rankName:"ダイヤモンド", rankGem:"💎", rankColor:"#b9f2ff" },
    ]},
];

function checkYearRollover(c) {
  const year = new Date().getFullYear();
  if (c.currentYearPurchases === undefined) {
    // 旧データ移行
    return { ...c, pin: c.pin||c.phone||"0000", currentYearPurchases: c.purchases||0, rankBasis: c.purchases||0, dataYear: year, yearlyStats: c.yearlyStats||[] };
  }
  if ((c.dataYear || year) < year) {
    const prevYear      = c.dataYear || year - 1;
    const prevPurchases = c.currentYearPurchases;
    const prevRank      = getRank(prevPurchases);
    const newStat       = { year: prevYear, purchases: prevPurchases, rankName: prevRank.name, rankGem: prevRank.gem, rankColor: prevRank.color };
    const existingStats = (c.yearlyStats || []).filter(s => s.year !== prevYear);
    return {
      ...c,
      rankBasis:            prevPurchases,
      currentYearPurchases: 0,
      dataYear:             year,
      benefitUsedMonth:     null,
      toppingRemaining:     null,
      toppingRemainingMonth: null,
      yearlyStats:          [newStat, ...existingStats].sort((a,b)=>b.year-a.year).slice(0,10),
      history: [{
        type:"year_reset", prevPurchases,
        newRank: getRank(prevPurchases).name,
        performer:"システム", date: new Date().toLocaleString("ja-JP"),
      }, ...(c.history||[])].slice(0, 60),
    };
  }
  return { ...c, yearlyStats: c.yearlyStats||[] };
}

const DEFAULT_MENU = [
  { id:"m1",  category:"コーヒー",   name:"エスプレッソ",     price:400, emoji:"☕" },
  { id:"m2",  category:"コーヒー",   name:"カフェラテ",       price:550, emoji:"🥛" },
  { id:"m3",  category:"コーヒー",   name:"カプチーノ",       price:550, emoji:"☁️" },
  { id:"m4",  category:"コーヒー",   name:"アメリカーノ",     price:480, emoji:"🫖" },
  { id:"m14", category:"コーヒー",   name:"アイスコーヒー",   price:480, emoji:"🧊" },
  { id:"m15", category:"コーヒー",   name:"ホットコーヒー",   price:450, emoji:"☕" },
  { id:"m5",  category:"ドリンク",   name:"紅茶",             price:450, emoji:"🍵" },
  { id:"m6",  category:"ドリンク",   name:"オレンジジュース", price:500, emoji:"🍊" },
  { id:"m16", category:"ドリンク",   name:"ソーダ",           price:430, emoji:"🫧" },
  { id:"m17", category:"トッピング", name:"チョコソース",     price:100, emoji:"🍫" },
  { id:"m18", category:"トッピング", name:"キャラメルソース", price:100, emoji:"🍯" },
  { id:"m7",  category:"フード",     name:"クロワッサン",     price:380, emoji:"🥐" },
  { id:"m8",  category:"フード",     name:"チーズケーキ",     price:650, emoji:"🍰" },
  { id:"m9",  category:"フード",     name:"サンドイッチ",     price:750, emoji:"🥪" },
  { id:"m10", category:"フード",     name:"スコーン",         price:420, emoji:"🫓" },
];

// ══════════════════════════════════════════
//  ROOT
// ══════════════════════════════════════════
export default function App() {
  const [screen,         setScreen]         = useState("home");
  const [customers,      setCustomers]      = useState([]);
  // ※ 見本データ（DEFAULT_MENU / 山田花子 など）を初期値にしない。
  //    読み込みに失敗したとき、実在しないメニューやスタッフがそのまま画面に出て、
  //    本物だと思って操作してしまう事故を防ぐため。
  //    取得できていない状態では、後述の saveMenu などが保存を断るようにしてある。
  const [menu,           setMenu]           = useState([]);
  const [orders,         setOrders]         = useState([]);
  const [staffAccounts,  setStaffAccounts]  = useState([]);
  const [managerAccounts, setManagerAccounts]= useState([]);
  const [designatedDrink,setDesignatedDrink]= useState(null);
  const [vipGiftDrink,   setVipGiftDrink]   = useState(null);
  const [staffRole,      setStaffRole]      = useState(null);
  const [staffName,      setStaffName]      = useState("");
  const [staffIsChief,   setStaffIsChief]   = useState(false);
  const [loaded,         setLoaded]         = useState(false);

  // 直近に保存した時刻を覚えておく（この直後の同期で上書きを防ぐ）
  const lastSaveAt = useRef(0);
  // 今どの画面にいるかを同期処理から参照するための控え（通信量を抑えるために使う）
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // サーバーからちゃんと取得できた項目の控え。
  // 取得できていないものを保存すると、DB の中身を空で上書きしてしまうので、
  // ここが false の間は保存を断る（データを丸ごと失う事故の防止）。
  const gotFromServer = useRef({ menu:false, staff:false, manager:false });

  // データの読み込みと定期同期。
  // ※ staffRole を依存に入れているのは重要。
  //    データベースを直接読めない設定にしたため、ログイン前の読み込みは全部失敗する。
  //    ログインして初めてサーバー経由で取れるようになるので、
  //    ログインした時点でもう一度まとめて読み直す必要がある。
  //    （これが無いと、メニューやスタッフ一覧が初期設定の見本データのままになる）
  useEffect(() => {
    let mounted = true;

    const loadAll = async () => {
      try {
        const [cust, menu_, ord, dd, vip, staff, mga] = await Promise.all([
          dbGet("cafe_v4_customers"),
          dbGet("cafe_v4_menu"),
          dbGet("cafe_v4_orders"),
          dbGet("cafe_v4_designated_drink"),
          dbGet("cafe_v4_vip_gift_drink"),
          dbGet("cafe_v4_staff_accounts"),
          dbGet("cafe_v4_manager_accounts"),
        ]);
        if (!mounted) return;
        // 取得できなかったときに見本データを表示しない。
        // （データベースを直接読めない設定にしたあとも、見本の会員が出てこないようにするため）
        const raw = Array.isArray(cust) ? cust : [];
        const migrated = raw.map(checkYearRollover);
        setCustomers(migrated);
        // 読み込み失敗時（cust が無い）は DB に一切書き込まない（見本データでの上書き事故を防止）
        if (Array.isArray(cust)) {
          const changed = migrated.some((c,i)=>raw[i]&&c.dataYear!==raw[i].dataYear);
          if (changed) dbSet("cafe_v4_customers", migrated);
        }
        // 配列で来たときだけ差し替える。おかしな値が入ると画面が壊れるため。
        if (Array.isArray(menu_) && menu_.length) { setMenu(menu_); gotFromServer.current.menu = true; }
        if (Array.isArray(ord))   setOrders(ord);
        if (dd  && typeof dd  === "object") setDesignatedDrink(dd);
        if (vip && typeof vip === "object") setVipGiftDrink(vip);
        if (Array.isArray(staff) && staff.length) { setStaffAccounts(staff); gotFromServer.current.staff = true; }
        if (Array.isArray(mga)   && mga.length)   { setManagerAccounts(mga); gotFromServer.current.manager = true; }
      } catch (e) { console.warn("初回の読み込みに失敗しました", e); }
      if (mounted) setLoaded(true);
    };

    loadAll();

    // ── 定期同期 ──────────────────────────────
    // 通信量を抑えるため、次の場合は取りに行かない：
    //   ・画面がホームのとき（データを表示していない）
    //   ・タブが裏に回っている / 画面を閉じているとき
    //   ・直近5秒以内に自分が保存したとき（書き込み中の上書きを防ぐ）
    // 表に戻ってきた瞬間には必ず1回取り直すので、古いデータのまま操作することはない。
    const syncNow = async () => {
      if (!mounted) return;
      if (Date.now() - lastSaveAt.current < 5000) return;
      try {
        const [cust, ordWin] = await Promise.all([
          dbGet("cafe_v4_customers"),
          // 注文は新しい方から ORDER_WINDOW 件だけ取得する（全件取得より通信量が小さい）
          dbGet("cafe_v4_orders", ORDER_WINDOW_QUERY),
        ]);
        if (!mounted) return;
        // 取得中に保存が走っていたら、その結果は古い可能性があるので捨てる
        if (Date.now() - lastSaveAt.current < 5000) return;
        if (cust) setCustomers(cust.map(checkYearRollover));
        if (ordWin) setOrders(prev => mergeOrderWindow(prev, ordWin));
      } catch {}
    };

    // この定期同期が要るのは POS 画面だけ。
    // お客様のチケット画面は自分専用の窓口で別に取り直しているので、ここでは何もしない。
    const shouldSync = () => screenRef.current === "pos" && !document.hidden;

    const timer = setInterval(() => { if (shouldSync()) syncNow(); }, 8000);

    // 画面に戻ってきたら即座に最新を取り直す
    const onVisible = () => { if (shouldSync()) syncNow(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [staffRole]);

  const saveC = async (list) => {
    lastSaveAt.current = Date.now();
    setCustomers(list); // 画面はすぐ更新（従来どおり）

    // ── 変わったのが1人だけなら、その1人ぶんだけを送る ──────────
    // 会計・チャージはどれも「1人の残高と履歴を変える」だけの操作。
    // それなのに今までは、会員21人ぶんの一覧をまるごと送り直していた。
    // 一覧を読んでから書き戻すまでの数秒のあいだに別の端末が会計をすると、
    // その会計が消えてしまう（実際に過去、記録が失われている）。
    //
    // 1人ぶんだけを送れば、読み込みから書き戻しまでをサーバーの中で
    // 一続きに行えるので、すれ違いが起きる余地がほぼ無くなる。
    // 通信量も21分の1になる。
    // うまくいかなかったときは、今までのやり方に自動で切り替える。
    const prevList = customers;
    const prevById = new Map(prevList.map(c => c && [c.id, c]).filter(Boolean));
    const sameMembers =
      prevList.length === list.length && list.every(c => c && prevById.has(c.id));
    const changed = sameMembers ? list.filter(c => prevById.get(c.id) !== c) : [];
    if (changed.length === 1 && await saveOneCustomer(changed[0])) return;

    try {
      const prev = customers;
      const latest = await dbGet("cafe_v4_customers");
      if (!Array.isArray(latest)) { dbSet("cafe_v4_customers", list); return; }
      const byId = {}; list.forEach(c => { if (c && c.id) byId[c.id] = c; });
      const prevById = {}; prev.forEach(c => { if (c && c.id) prevById[c.id] = c; });
      const listIds = new Set(list.map(c => c && c.id));
      const removed = new Set(prev.filter(c => c && c.id && !listIds.has(c.id)).map(c => c.id));
      const result = []; const used = new Set();
      latest.forEach(c => {
        const id = c.id;
        if (removed.has(id)) return; // 自分が消した会員は除外
        if (byId[id]) {
          const callerV = byId[id], prevV = prevById[id];
          const changed = !prevV || JSON.stringify(callerV) !== JSON.stringify(prevV);
          result.push(changed ? callerV : c); // 自分が変えた分だけ反映、未変更は最新を維持
          used.add(id);
        } else {
          result.push(c); // 他端末の会員は消さずに残す
        }
      });
      list.forEach(c => { if (c && c.id && !used.has(c.id)) { result.push(c); used.add(c.id); } });
      setCustomers(result);
      dbSet("cafe_v4_customers", result);
    } catch (e) {
      dbSet("cafe_v4_customers", list); // 失敗時は従来動作にフォールバック
    }
  };
  const saveMenu        = (list) => {
    if (!gotFromServer.current.menu) return notLoadedYet("メニュー");
    lastSaveAt.current = Date.now(); setMenu(list);             dbSet("cafe_v4_menu",             list);
  };
  const saveOrders = async (list) => {
    lastSaveAt.current = Date.now();
    setOrders(list); // 画面はすぐ更新（従来どおり）

    // ── まずサーバー側での合流を試す ─────────────────
    // 下にある「読んで・混ぜて・書く」をブラウザでやると、
    // 読みと書きのあいだに別の端末の変更が入ったとき、それを消してしまう。
    // サーバーの中で同じことを一続きにやれば、その隙間がほぼ無くなる。
    // 失敗したときは、今までのやり方（下の処理）に自動で切り替える。
    if (_apiToken) {
      try {
        const prevIds = (orders || []).map(o => o && o.orderId).filter(Boolean);
        const r = await apiData("setOrdersMerged", { value: { list, prevIds } });
        if (r && Array.isArray(r.value)) setOrders(r.value);
        return;
      } catch (e) {
        if (e.status === 401) { notifyExpired(); return; }
        console.warn("サーバーでの合流保存に失敗したため、従来の方法で保存します", e);
      }
    }

    try {
      const prev = orders;
      const latest = await dbGet("cafe_v4_orders");
      if (!Array.isArray(latest)) { dbSet("cafe_v4_orders", list); return; }
      const byId = {}; list.forEach(o => { if (o && o.orderId) byId[o.orderId] = o; });
      const prevById = {}; prev.forEach(o => { if (o && o.orderId) prevById[o.orderId] = o; });
      const listIds = new Set(list.map(o => o && o.orderId));
      const removed = new Set(prev.filter(o => o && o.orderId && !listIds.has(o.orderId)).map(o => o.orderId));
      const result = []; const used = new Set();
      latest.forEach(o => {
        if (!o || !o.orderId) return;
        const id = o.orderId;
        if (removed.has(id)) return; // 自分が消した注文は除外
        if (byId[id]) {
          const callerV = byId[id], prevV = prevById[id];
          const changed = !prevV || JSON.stringify(callerV) !== JSON.stringify(prevV);
          result.push(changed ? callerV : o); // 自分が変えた分だけ反映、未変更は最新を維持
          used.add(id);
        } else {
          result.push(o); // 他端末の注文は消さずに残す
        }
      });
      // DBに無い注文を足し戻すのは「この端末で今つくった注文」だけにする。
      // ずっと手元にあった完了済みの注文がDBに無い場合は、アーカイブに移されたか
      // 他の端末で消されたということなので、足し戻してはいけない。
      // （足し戻すと、アーカイブした過去の注文が全部書き戻されてしまい、
      //   さらに配列の先頭が古い注文になって、定期同期が新しい注文を見つけられなくなる）
      // 未処理の注文はアーカイブされないので、取りこぼし防止のため足し戻す。
      const prevOrderIds = new Set(prev.map(o => o && o.orderId));
      list.forEach(o => {
        if (!o || !o.orderId || used.has(o.orderId)) return;
        if (!prevOrderIds.has(o.orderId) || o.status === "pending") {
          result.unshift(o);
          used.add(o.orderId);
        }
      });
      setOrders(result);
      dbSet("cafe_v4_orders", result);
    } catch (e) {
      dbSet("cafe_v4_orders", list); // 失敗時は従来動作にフォールバック
    }
  };
  // 読み込めていないものは保存させない。
  // （空っぽの状態で保存すると、DB にある本物のメニューやスタッフが消えてしまう）
  const notLoadedYet = (what) => {
    alert(`${what}をまだ読み込めていないため、保存できません。\n通信状況を確認して、画面を開き直してください。`);
    return false;
  };

  const saveDesignatedDrink = (item)=> { lastSaveAt.current = Date.now(); setDesignatedDrink(item); dbSet("cafe_v4_designated_drink", item); };
  const saveVipGiftDrink    = (item)=> { lastSaveAt.current = Date.now(); setVipGiftDrink(item);    dbSet("cafe_v4_vip_gift_drink",   item); };
  const saveManagerAccounts = (list)=> {
    if (!gotFromServer.current.manager) return notLoadedYet("マネージャー一覧");
    lastSaveAt.current = Date.now(); setManagerAccounts(list); dbSet("cafe_v4_manager_accounts", list);
  };
  const saveStaffAccounts   = (list)=> {
    if (!gotFromServer.current.staff) return notLoadedYet("スタッフ一覧");
    lastSaveAt.current = Date.now(); setStaffAccounts(list);   dbSet("cafe_v4_staff_accounts",   list);
  };

  // ── 画面の切り替えを「ふわっと」つなぐ（View Transitions API）──
  // 2024年に主要ブラウザへ入った新しい仕組み。前の画面と次の画面を
  // ブラウザ自身がなめらかにクロスフェードしてくれる。
  // 対応していない端末では、今までどおり瞬時に切り替わる（壊れない）。
  const changeScreen = (s) => {
    if (document.startViewTransition) {
      document.startViewTransition(() => { flushSync(() => setScreen(s)); });
    } else {
      setScreen(s);
    }
  };

  // 50回に1回だけ、読み込みの虹リングが🍩になる（気づいた人だけのお楽しみ）
  const [donutLuck] = useState(() => Math.random() < 0.02);
  // キーボードで↑↑↓↓←→←→BAと打つと…（ゲーム好きへのご褒美）
  useKonami();

  if (!loaded) return (
    <div style={S.loading}>
      {donutLuck
        ? <div className="spinner-donut" aria-hidden="true">🍩</div>
        : <div className="spinner" aria-hidden="true"/>}
      読み込み中...
    </div>
  );

  return (
    <div className="approot" style={S.root}>
      <style>{CSS}</style>
      {screen==="home"     && <Home setScreen={changeScreen} setStaffRole={setStaffRole}/>}
      {screen==="customer" && <CustomerView customers={customers} menu={menu} orders={orders} saveOrders={saveOrders} saveC={saveC} designatedDrink={designatedDrink} staffAccounts={staffAccounts} managerAccounts={managerAccounts} vipGiftDrink={vipGiftDrink} setScreen={changeScreen}/>}
      {screen==="login"    && <StaffLogin setScreen={changeScreen} setStaffRole={setStaffRole} setStaffName={setStaffName} setStaffIsChief={setStaffIsChief} staffAccounts={staffAccounts} managerAccounts={managerAccounts}/>}
      {screen==="pos"      && <POS customers={customers} menu={menu} orders={orders} staffRole={staffRole} staffName={staffName} staffIsChief={staffIsChief} staffAccounts={staffAccounts} saveStaffAccounts={saveStaffAccounts} managerAccounts={managerAccounts} saveManagerAccounts={saveManagerAccounts} saveC={saveC} saveMenu={saveMenu} saveOrders={saveOrders} designatedDrink={designatedDrink} saveDesignatedDrink={saveDesignatedDrink} vipGiftDrink={vipGiftDrink} saveVipGiftDrink={saveVipGiftDrink} setScreen={changeScreen}/>}
    </div>
  );
}


// ══════════════════════════════════════════
//  夜モードのスイッチ
// ══════════════════════════════════════════
// この部品を置いた画面にいる間だけ、アプリ全体が「夜のネオンガラス」配色になる。
// 仕組みは、色をぜんぶ CSS変数（--ink や --card）経由にしておき、
// body に night クラスが付いたときだけ夜の値に差し替える、というもの。
// 画面を離れると自動で元に戻るので、スタッフ用POSは今までの明るい画面のまま。
function NightMode() {
  useEffect(() => {
    document.body.classList.add("night");
    // 時間帯で夜空の色味が少し変わる：夕方はピンク寄り、深夜は青寄り。
    // 毎晩同じではない空。気づかなくても、なんとなく雰囲気が変わる。
    const h = new Date().getHours();
    let hue = (h >= 17 && h <= 20) ? "-25deg" : (h >= 2 && h <= 5) ? "35deg" : "0deg";
    // きせかえ（🎨）で選んだ色があれば、そちらを優先する
    try {
      const saved = localStorage.getItem("niji_theme");
      if (saved !== null && NIGHT_THEMES[Number(saved)]) hue = NIGHT_THEMES[Number(saved)].h;
    } catch {}
    document.body.style.setProperty("--nh", hue);
    return () => document.body.classList.remove("night");
  }, []);
  return null;
}

// ══════════════════════════════════════════
//  HOME
// ══════════════════════════════════════════
// あいさつは時間帯で変わり、🌙は今夜の本当の月の形になる。
// 朝は「おはよう」、深夜は「そろそろおやすみ」。アプリがこちらの時間を知っている感じ。
function pickTagline() {
  const h = new Date().getHours();
  const moon = moonEmoji();
  const pool =
    h >= 5 && h <= 10 ? ["おはようございます ☀️","朝の一杯、いかが？","今日もいい日に 🌈"] :
    h >= 11 && h <= 16 ? ["こんにちは！","甘いの？ すっきり系？","きょうも、いつもの一杯を"] :
    h >= 2 && h <= 4  ? [`そろそろおやすみ ${moon}`,"夜ふかしさん、いらっしゃい"] :
    [`こんばんは、ようこそ ${moon}`,`夜カフェ、はじまるよ ${moon}`,"今日もおつかれさま！","おかえりなさい 🌈"];
  return pool[Math.floor(Math.random() * pool.length)];
}

function Home({ setScreen }) {
  const [tagline] = useState(pickTagline);
  const season = seasonBits();

  // 流れ星。1分に1回あるかないか。気づいた人は今日いいことがある。
  // ……そして、ごくまれに（7%）流星群になる。
  const [shoot, setShoot] = useState(null);
  const [shower, setShower] = useState(null);
  useEffect(() => {
    const t = setInterval(() => {
      const r = Math.random();
      if (r < 0.07) {
        setShower(Date.now());
        setTimeout(() => setShower(null), 3500);
      } else if (r < 0.4) {
        setShoot({ id: Date.now(), top: 5 + Math.random() * 35, left: 30 + Math.random() * 55 });
        setTimeout(() => setShoot(null), 1300);
      }
    }, 30000);
    return () => clearInterval(t);
  }, []);

  // 雷。ごくまれに（45秒ごとに5%）夜空が2回光る
  const [bolt, setBolt] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (Math.random() < 0.05) {
        setBolt(Date.now());
        setTimeout(() => setBolt(0), 700);
        try { navigator.vibrate && navigator.vibrate([40, 80, 60]); } catch {}
      }
    }, 45000);
    return () => clearInterval(t);
  }, []);

  // ロゴを4秒以内に10連打すると、花火大会が始まる
  const logoTaps = useRef({ n: 0, t: 0 });
  const [fireworks, setFireworks] = useState(null);
  const countLogoTap = () => {
    const now = Date.now();
    if (now - logoTaps.current.t > 4000) logoTaps.current.n = 0;
    logoTaps.current.t = now;
    if (++logoTaps.current.n >= 10) {
      logoTaps.current.n = 0;
      setFireworks(Date.now());
      setTimeout(() => setFireworks(null), 3600);
      try { localStorage.setItem("niji_ach_fw", "1"); } catch {}   // 実績「花火師」解放
      try { navigator.vibrate && navigator.vibrate([20, 50, 20, 50, 20, 50, 60]); } catch {}
    }
  };

  // ネオン看板を押すと、点灯ショーをもう一度最初から
  const [neonKey, setNeonKey] = useState(0);

  // あいさつ文を1.5秒以内に3回押すと、6秒だけディスコになる
  const discoTaps = useRef({ n: 0, t: 0 });
  const tapTagline = () => {
    const now = Date.now();
    if (now - discoTaps.current.t > 1500) discoTaps.current.n = 0;
    discoTaps.current.t = now;
    if (++discoTaps.current.n >= 3) {
      discoTaps.current.n = 0;
      document.body.classList.add("disco");
      setTimeout(() => document.body.classList.remove("disco"), 6000);
      try { localStorage.setItem("niji_ach_disco", "1"); } catch {}   // 実績「ディスコ王」解放
    }
  };

  // 何もない所を押すと、虹の波紋がふわっと広がる
  const [ripples, setRipples] = useState([]);
  const makeRipple = (e) => {
    if (e.target.closest("button")) return;
    const id = Date.now() + Math.random();
    setRipples((r) => [...r.slice(-4), { id, x: e.clientX, y: e.clientY }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 950);
  };

  // ロゴを3秒長押しすると出てくる、隠しメッセージ
  const [secret, setSecret] = useState(false);
  const pressT = useRef(null);
  const pressStart = () => { pressT.current = setTimeout(() => {
    setSecret(true); setTimeout(() => setSecret(false), 3000);
  }, 3000); };
  const pressEnd = () => clearTimeout(pressT.current);

  // 虹の6色の点を、左から順に全部押せたら…（知っている人だけの花火）
  const [dotStep, setDotStep] = useState(0);
  const [wave, setWave] = useState(0);
  const tapDot = (i) => {
    if (i === dotStep) {
      if (i === 5) {
        setDotStep(0); setWave(Date.now()); setTimeout(() => setWave(0), 1700);
        try { localStorage.setItem("niji_ach_dots", "1"); } catch {}   // 実績「虹の点コンプ」解放
      }
      else setDotStep(i + 1);
    } else setDotStep(i === 0 ? 1 : 0);
  };

  // パソコンだけ：カーソルの後ろに星屑の尾がつく
  const [dust, setDust] = useState([]);
  useEffect(() => {
    if (!window.matchMedia || !window.matchMedia("(pointer:fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = 0;
    const onMove = (e) => {
      const now = Date.now();
      if (now - last < 70) return;
      last = now;
      const id = now + Math.random();
      setDust((d) => [...d.slice(-14), { id, x: e.clientX, y: e.clientY }]);
      setTimeout(() => setDust((d) => d.filter((p) => p.id !== id)), 700);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div style={S.homeOuter} onPointerDown={makeRipple}>
      <NightMode/>

      {/* 満月の夜だけ、大きな月がのぼっている（本物の月齢と連動） */}
      {moonEmoji() === "🌕" && <div className="big-moon" aria-hidden="true">🌕</div>}

      {/* 雷（ごくまれ） */}
      {bolt !== 0 && <div key={bolt} className="lightning" aria-hidden="true"/>}

      {/* 流星群（もっとまれ） */}
      {shower && [...Array(8)].map((_, i) => (
        <span key={shower + "-" + i} className="shooting-star" style={{
          top: `${3 + (i * 11) % 40}%`, left: `${25 + (i * 17) % 70}%`,
          animationDelay: `${i * 0.35}s`}}/>
      ))}

      {/* 花火大会（ロゴ10連打のご褒美） */}
      {fireworks && [...Array(6)].map((_, b) => (
        <div key={fireworks + "-" + b} className="fw" style={{
          left: `${15 + (b * 31) % 70}%`, top: `${12 + (b * 23) % 45}%`,
          animationDelay: `${b * 0.45}s`}}>
          {[...Array(10)].map((_, i) => (
            <span key={i} className="fw-p" style={{
              "--fa": `${i * 36}deg`,
              background: ["#ff6ec7","#ffd166","#74f7a1","#4deeea","#b28dff"][i % 5],
              animationDelay: `${b * 0.45}s`}}/>
          ))}
        </div>
      ))}

      {/* 虹の波紋（何もない所を押した場所から広がる） */}
      {ripples.map((p) => (
        <span key={p.id} className="ripple" style={{left: p.x, top: p.y}}/>
      ))}

      {/* 星空。位置は計算式で散らしてある（毎回同じ配置なのでチラつかない）。
          13番目だけは本物の✨で、押すとはじける */}
      {[...Array(26)].map((_, i) => (
        i === 13
          ? <TapBurst key={"s"+i} emojis={["✨","💫","⭐"]}
              style={{position:"absolute", left:`${(i * 41 + 7) % 100}%`, top:`${(i * 29 + 3) % 90}%`, fontSize:"0.8rem", zIndex:2}}>
              <span className="star-real">✨</span>
            </TapBurst>
          : <span key={"s"+i} className="star" style={{
              left:`${(i * 41 + 7) % 100}%`, top:`${(i * 29 + 3) % 90}%`,
              width:`${2 + (i % 3)}px`, height:`${2 + (i % 3)}px`,
              animationDelay:`${(i % 7) * 0.45}s`}}/>
      ))}

      {/* 流れ星 */}
      {shoot && <span key={shoot.id} className="shooting-star" style={{top:`${shoot.top}%`, left:`${shoot.left}%`}}/>}

      {/* 季節の飾り（12月は雪、秋は🍁、春は🌸。日付で勝手に切り替わる） */}
      {season && season.bits.map((b, i) => (
        <span key={"f"+i} className="fall-bit" style={{
          left:`${5 + i * 17}%`, fontSize:`${0.9 + (i % 3) * 0.25}rem`,
          animationDuration:`${9 + (i % 4) * 3}s`, animationDelay:`${i * 1.8}s`}}>{b}</span>
      ))}

      {/* 虹色の波（6色の点を順番に全部押せた人だけが見られる）＋大きな🌈 */}
      {wave !== 0 && (
        <div key={wave} aria-hidden="true">
          <div className="rainbow-wave"/>
          <div className="rainbow-big">🌈</div>
        </div>
      )}

      {/* 星屑の尾（パソコンのみ） */}
      {dust.map((p) => (
        <span key={p.id} className="stardust" style={{left:p.x, top:p.y}}>✦</span>
      ))}

      {/* ぷかぷか浮かんで夜空へのぼっていく、夜カフェの住人たち */}
      {["☕","🧋","⭐","🌙","🍩","🍓"].map((e, i) => (
        <span key={e} className="float-emoji" style={{
          left:`${6 + i * 16}%`,
          animationDuration:`${15 + (i % 3) * 6}s`,
          animationDelay:`${i * 2.5}s`}}>{e}</span>
      ))}
      {/* 背景の虹グラデーション装飾。それぞれ違う周期でゆっくり漂う */}
      <div className="aurora" style={S.homeBgCircle1}/>
      <div className="aurora" style={{...S.homeBgCircle2, animationDelay:"-3.5s"}}/>
      <div className="aurora" style={{...S.homeBgCircle3, animationDelay:"-7s"}}/>

      <div style={S.homeWrap}>
        {/* ロゴ。押すと絵文字がはじける。3秒長押しで隠しメッセージ。10連打で花火大会 */}
        <div onPointerDown={pressStart} onPointerUp={pressEnd} onPointerLeave={pressEnd} onClick={countLogoTap}>
          <TapBurst emojis={["☕","⭐","🧋","🌈","💜","🍩"]}>
            <div style={S.rainbowLogoWrap}>
              <div style={S.rainbowLogoInner}>
                <span style={{fontSize:52}}>🌈</span>
              </div>
              <div style={S.rainbowGlow}/>
            </div>
          </TapBurst>
        </div>
        {secret && <div className="secret-toast">虹カフェ v4 — いつもありがとう 🌈</div>}

        {/* ブランド名 ＝ ネオン看板。
            開いた瞬間、文字が「パチ…パチ…ポワッ」と1文字ずつ順に点灯する。
            3文字目の「フ」だけ、ときどき電気の切れかけみたいに瞬く（本物の看板の癖）。 */}
        <div style={{position:"relative",marginTop:6}}>
          {/* 看板を押すと、点灯ショーがもう一度最初から始まる */}
          <h1 key={neonKey} className="neon-sign" style={{...S.brandRainbow,cursor:"pointer"}}
            onClick={()=>setNeonKey(k=>k+1)}>
            {"虹カフェ".split("").map((ch, i) => (
              <span key={i} className={"neon-ch" + (i === 2 ? " neon-flicker" : "")}
                style={{"--nc":["#ff6ec7","#4deeea","#ffd166","#b28dff"][i % 4],
                  animationDelay:`${0.3 + i * 0.22}s`, display:"inline-block"}}>
                {ch}
              </span>
            ))}
          </h1>
          <div style={S.brandUnderline}/>
        </div>

        {/* あいさつ文を3回連打すると…（ディスコタイム） */}
        <p style={{...S.taglineRainbow,cursor:"pointer"}} onClick={tapTagline}>{tagline}</p>

        {/* ボタン */}
        <div style={S.homeBtns}>
          <button className="btn-rainbow" onClick={()=>setScreen("customer")}>
            <span style={{fontSize:"1.15rem"}}>🎫</span>
            <span>チケットを確認する</span>
          </button>
          <button className="btn-crystal" onClick={()=>setScreen("login")}>
            <span style={{fontSize:"1rem"}}>🔑</span>
            <span>スタッフ入口</span>
          </button>
        </div>

        {/* 虹の点。順番に小さくはねる。
            そして——左から順に6個ぜんぶ押せた人には、いいことがある */}
        <div style={S.decoRow}>
          {["#e8759b","#e8944a","#d9a821","#5fa878","#5b93c9","#8a7cc4"].map((c,i)=>(
            <span key={i} className="dot-wave" onClick={()=>tapDot(i)}
              style={{width:9,height:9,borderRadius:"50%",background:c,display:"inline-block",
                cursor:"pointer", padding:0,
                boxShadow: i < dotStep ? `0 0 8px ${c}` : "none",
                animationDelay:`${i*0.18}s`}}/>
          ))}
        </div>

        {/* お正月（1/1〜1/3）だけの一言 */}
        {isNewYear() && <div className="newyear">あけましておめでとう 🎉</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  ホログラムの会員カード
// ══════════════════════════════════════════
// 指やマウスでなでると、カードが3Dに傾いて、
// トレーディングカードのような虹色の光沢が指を追いかける。
// 触っていないときは完全に静止しているので、目障りにはならない。
// 「視差効果を減らす」設定の端末では何もしない。
function HoloCard({ className, style, children }) {
  const ref = useRef(null);
  // ダブルタップでカードがくるっと一回転する（トレカを裏返す癖のある人へ）
  const [flip, setFlip] = useState(false);
  const doFlip = () => {
    if (flip) return;
    setFlip(true);
    setTimeout(() => setFlip(false), 900);
    try { navigator.vibrate && navigator.vibrate(12); } catch {}
  };
  useEffect(() => {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      el.style.setProperty("--ry", ((px - 0.5) * 14).toFixed(2) + "deg");
      el.style.setProperty("--rx", ((0.5 - py) * 10).toFixed(2) + "deg");
      el.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      el.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      el.classList.add("holo-on");
    };
    const reset = () => {
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.classList.remove("holo-on");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", reset);
    el.addEventListener("pointerup", reset);
    el.addEventListener("pointercancel", reset);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", reset);
      el.removeEventListener("pointerup", reset);
      el.removeEventListener("pointercancel", reset);
    };
  }, []);
  return (
    <div ref={ref} className={"tilt " + (flip ? "flip " : "") + (className || "")} style={style}
      onDoubleClick={doFlip}>
      {children}
      <div className="holo-layer" aria-hidden="true"/>
    </div>
  );
}

// ══════════════════════════════════════════
//  隠れた遊び心のための小道具たち
// ══════════════════════════════════════════
// 今夜の月の形。2000年1月6日の新月を起点に、月の満ち欠け周期（29.53日）で計算する。
// あいさつ文の🌙が、実際の空の月と同じ形になる。気づいた人だけが得をする。
function moonEmoji() {
  const days = (Date.now() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const phase = ((days / 29.53059) % 1 + 1) % 1;
  return ["🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘"][Math.floor(phase * 8) % 8];
}

// 季節の飾り。日付だけで自動で切り替わる（誰も設定しなくていい）
function seasonBits() {
  const d = new Date(), m = d.getMonth() + 1, day = d.getDate();
  if (m === 12 && day <= 25) return { bits:["❄","❄","❅","❄","❆","❄"], name:"snow" };
  if ((m === 10 && day >= 15) || m === 11) return { bits:["🍁","🍂","🍁","🍂","🍁","🍂"], name:"autumn" };
  if ((m === 3 && day >= 25) || (m === 4 && day <= 15)) return { bits:["🌸","🌸","🌸","💮","🌸","🌸"], name:"sakura" };
  return null;
}
const isNewYear = () => { const d = new Date(); return d.getMonth() === 0 && d.getDate() <= 3; };

// 「ぽっ」という小さな効果音。音源ファイル無しで、その場で音を作る。
// 初期はオフ。注文画面の🔕ボタンでオンにできる（端末のマナーモードには従う）。
let _audioCtx = null;
function popSound() {
  try {
    if (localStorage.getItem("niji_snd") !== "on") return;
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(620, _audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(180, _audioCtx.currentTime + 0.09);
    g.gain.setValueAtTime(0.12, _audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.1);
    o.connect(g); g.connect(_audioCtx.destination);
    o.start(); o.stop(_audioCtx.currentTime + 0.11);
  } catch {}
}

// コナミコマンド（↑↑↓↓←→←→BA）。成功すると10秒だけ世界が虹色に回る。
function useKonami() {
  useEffect(() => {
    const SEQ = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
    let i = 0;
    const onKey = (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      i = (k === SEQ[i]) ? i + 1 : (k === SEQ[0] ? 1 : 0);
      if (i === SEQ.length) {
        i = 0;
        document.body.classList.add("rainbow-mode");
        setTimeout(() => document.body.classList.remove("rainbow-mode"), 10000);
        try { localStorage.setItem("niji_ach_konami", "1"); } catch {}   // 実績「謎のコマンド」解放
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ══════════════════════════════════════════
//  タップすると絵文字がはじける小さな花火
// ══════════════════════════════════════════
// ロゴやランクの宝石を押すと、絵文字が放射状にはじけて消える。
// 何の役にも立たないが、押したくなる。そういうおもちゃ。
function TapBurst({ emojis, children, className, style }) {
  const [bursts, setBursts] = useState([]);
  const fire = () => {
    const id = Date.now() + Math.random();
    setBursts((b) => [...b, id]);
    setTimeout(() => setBursts((b) => b.filter((x) => x !== id)), 900);
    try { navigator.vibrate && navigator.vibrate(8); } catch {}
  };
  return (
    <span className={className} style={{position:"relative",display:"inline-block",cursor:"pointer",...style}} onClick={fire}>
      {children}
      {bursts.map((id) => (
        <span key={id} className="burst" aria-hidden="true">
          {emojis.map((e, i) => (
            <span key={i} className="burst-p"
              style={{"--a":`${i * (360 / emojis.length)}deg`, animationDelay:`${i * 0.02}s`}}>{e}</span>
          ))}
        </span>
      ))}
    </span>
  );
}

// ══════════════════════════════════════════
//  ド派手な演出の部品たち
// ══════════════════════════════════════════
// ログイン成功の瞬間、虹のカーテンが画面を横切って「ようこそ」と迎える
function WelcomeSweep({ found }) {
  const [show, setShow] = useState(0);
  const lastId = useRef(null);
  useEffect(() => {
    if (!found || found.id === lastId.current) return;
    lastId.current = found.id;
    setShow(Date.now());
    const t = setTimeout(() => setShow(0), 2000);
    return () => clearTimeout(t);
  }, [found && found.id]);
  if (!show) return null;
  return (
    <div key={show} aria-hidden="true">
      <div className="rainbow-wave"/>
      <div className="welcome-toast">ようこそ、{found.name}さん 🌈</div>
    </div>
  );
}

// ランクが上がっていたら、全画面でお祝いする。
// 「前に見たときのランク」を端末に覚えておき、上がった瞬間に一度だけ発動する。
function RankUpShow({ found, rank }) {
  const [show, setShow] = useState(null);
  useEffect(() => {
    if (!found || !rank || rank.name === "ランクなし") return;
    try {
      const key = "niji_rank_" + found.id;
      const prev = localStorage.getItem(key);
      const prevIdx = RANKS.findIndex((r) => r.name === prev);
      const nowIdx = RANKS.findIndex((r) => r.name === rank.name);
      if (prev && nowIdx > prevIdx) {
        setShow({ id: Date.now(), gem: rank.gem, name: rank.name, color: rank.color });
        setTimeout(() => setShow(null), 3400);
        try { navigator.vibrate && navigator.vibrate([30, 60, 30, 60, 80]); } catch {}
      }
      localStorage.setItem(key, rank.name);
    } catch {}
  }, [found && found.id, rank && rank.name]);
  if (!show) return null;
  return (
    <div key={show.id} className="rankup-ov" aria-hidden="true">
      {[...Array(14)].map((_, i) => (
        <span key={i} className="rankup-gem" style={{
          left: `${(i * 37 + 11) % 100}%`,
          animationDelay: `${(i % 7) * 0.22}s`,
          animationDuration: `${2 + (i % 3) * 0.5}s`}}>{show.gem}</span>
      ))}
      <div className="rankup-box">
        <div className="rankup-big pop">{show.gem}</div>
        <div className="rankup-txt" style={{color: show.color}}>ランクアップ！</div>
        <div className="rankup-name">{show.name} になりました</div>
      </div>
    </div>
  );
}

// カードの中に、キラキラ（や🪙）が静かに降り続ける
function SparkleRain({ emoji }) {
  return (
    <span aria-hidden="true">
      {[...Array(6)].map((_, i) => (
        <span key={i} className="srain-p" style={{
          left: `${8 + i * 15}%`,
          animationDelay: `${i * 0.7}s`,
          animationDuration: `${3 + (i % 3)}s`}}>{emoji}</span>
      ))}
    </span>
  );
}

// ══════════════════════════════════════════
//  見て遊べるおもちゃたち（隠しではなく、堂々と置いてある）
// ══════════════════════════════════════════
// 🎡 おまかせシャッフル。高速で入れ替わり、だんだん減速して、1杯に決まる
function DrinkRoulette({ menu, onPick }) {
  const [spin, setSpin] = useState(null);   // { item, done }
  const timer = useRef(null);
  const start = () => {
    if (!menu.length) return;
    clearTimeout(timer.current);
    let speed = 55, elapsed = 0;
    const tick = () => {
      const item = menu[Math.floor(Math.random() * menu.length)];
      elapsed += speed;
      speed = Math.min(280, speed * 1.14);   // だんだんゆっくりに
      if (elapsed < 2600) {
        setSpin({ item, done: false });
        timer.current = setTimeout(tick, speed);
      } else {
        setSpin({ item, done: true });
        try { navigator.vibrate && navigator.vibrate([15, 40, 30]); } catch {}
      }
    };
    tick();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="toy-panel">
      {!spin ? (
        <button className="toy-btn" onClick={start}>🎡 迷ったらおまかせシャッフル</button>
      ) : (
        <div style={{textAlign:"center"}}>
          <div className={"roulette-item" + (spin.done ? " pop" : "")}>
            <span style={{fontSize:"2rem"}}>{spin.item.emoji}</span>
            <div style={{fontWeight:700,marginTop:2}}>{spin.item.name}</div>
            <div style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{spin.item.price}</div>
          </div>
          {spin.done && (
            <div style={{display:"flex",gap:8,marginTop:10,justifyContent:"center"}}>
              <button className="toy-btn" style={{flex:"none"}} onClick={()=>{ onPick(spin.item); setSpin(null); }}>これにする！</button>
              <button className="toy-btn toy-dim" style={{flex:"none"}} onClick={start}>もう一回</button>
              <button className="toy-btn toy-dim" style={{flex:"none"}} onClick={()=>setSpin(null)}>やめる</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 📖 今日の一節。聖書 新改訳2017 から、その日の一節を全員に同じものとして届ける。
// 日付から決まるので、お店のみんなが同じ「今日のみことば」を見る。
// ※ 本文はのあさんの聖書（新改訳2017）で必ず校正すること。
//    引用は新日本聖書刊行会の規定（250節以内・著作権表記つき）の範囲内。
const VERSES = [
  { t: "主は私の羊飼い。私は乏しいことがありません。", r: "詩篇 23:1" },
  { t: "すべて疲れた人、重荷を負っている人はわたしのもとに来なさい。わたしがあなたがたを休ませてあげます。", r: "マタイの福音書 11:28" },
  { t: "いつも喜んでいなさい。絶えず祈りなさい。すべてのことにおいて感謝しなさい。", r: "テサロニケ人への手紙 第一 5:16–18" },
  { t: "恐れるな。わたしはあなたとともにいる。たじろぐな。わたしがあなたの神だから。", r: "イザヤ書 41:10" },
  { t: "神は われらの避け所 また力。苦しむとき そこにある強き助け。", r: "詩篇 46:1" },
  { t: "私を強くしてくださる方によって、私はどんなことでもできるのです。", r: "ピリピ人への手紙 4:13" },
  { t: "これは主が設けられた日。この日を楽しみ喜ぼう。", r: "詩篇 118:24" },
  { t: "あなたのみことばは 私の足のともしび 私の道の光です。", r: "詩篇 119:105" },
  { t: "主の恵みは尽きることがない。そのあわれみは絶えることがない。それは朝ごとに新しい。", r: "哀歌 3:22–23" },
  { t: "何をするにも、人にではなく、主に対してするように、心から行いなさい。", r: "コロサイ人への手紙 3:23" },
  { t: "主があなたを祝福し、あなたを守られますように。", r: "民数記 6:24" },
  { t: "わたしは世の光です。わたしに従う者は、決して闇の中を歩むことがなく、いのちの光を持ちます。", r: "ヨハネの福音書 8:12" },
];
function TodayVerse() {
  const [open, setOpen] = useState(false);
  // 日付だけから決める＝この日に開いた全員が同じ一節を受け取る
  const seed = new Date().toLocaleDateString("ja-JP")
    .split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const v = VERSES[seed % VERSES.length];
  return (
    <div className="toy-panel" style={{textAlign:"center"}}>
      {!open ? (
        <button className="toy-btn" onClick={()=>{ setOpen(true); try{navigator.vibrate&&navigator.vibrate(10);}catch{} }}>
          📖 今日の一節
        </button>
      ) : (
        <div className="pop">
          <div style={{fontSize:"1.6rem",marginBottom:8}}>📖</div>
          <div style={{fontWeight:700,lineHeight:1.8,marginBottom:8}}>{v.t}</div>
          <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginBottom:8}}>— {v.r}</div>
          <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.68rem",marginTop:8}}>
            聖書 新改訳2017 ©2017 新日本聖書刊行会
          </div>
        </div>
      )}
    </div>
  );
}

// 🏆 実績バッジ棚。来店の記録から自動で解放されるものと、
// 隠しギミック（花火・ディスコ・虹の点・コナミ）を見つけると解放されるものがある。
// まだの物は「？？？」。集めたくなるやつ。
function BadgeShelf({ found, orders }) {
  const ls = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
  const mine = (orders || []).filter((o) => o && String(o.customerId) === String(found.id));
  const cups = Math.max(mine.length, (found.history || []).filter((h) => h && h.type === "use").length);
  const hourOf = (s) => parseInt(String(s || "").split(" ")[1]) || 12;
  const defs = [
    { e:"☕", n:"はじめての一杯", ok: cups >= 1 },
    { e:"🔟", n:"10杯クラブ",     ok: cups >= 10 },
    { e:"🌟", n:"常連さん",       ok: (found.currentYearPurchases || 0) >= 5 },
    { e:"💎", n:"ランク持ち",     ok: (found.rankBasis || 0) >= 2 },
    { e:"🌙", n:"夜カフェ勢",     ok: mine.some((o) => hourOf(o.createdAt) >= 21) },
    { e:"🌅", n:"朝活マスター",   ok: mine.some((o) => hourOf(o.createdAt) <= 10) },
    { e:"🎆", n:"花火師",         ok: ls("niji_ach_fw") },
    { e:"🪩", n:"ディスコ王",     ok: ls("niji_ach_disco") },
    { e:"🌈", n:"虹の点コンプ",   ok: ls("niji_ach_dots") },
    { e:"🎮", n:"謎のコマンド",   ok: ls("niji_ach_konami") },
  ];
  const got = defs.filter((d) => d.ok).length;
  return (
    <div className="toy-panel">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
        <span style={{fontWeight:700}}>🏆 実績バッジ</span>
        <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.8rem"}}>{got} / {defs.length}</span>
      </div>
      <div className="badge-grid">
        {defs.map((d, i) => (
          <div key={i} className={"badge" + (d.ok ? " badge-on" : "")}>
            <span style={{fontSize:"1.3rem"}}>{d.ok ? d.e : "❔"}</span>
            <span className="badge-name">{d.ok ? d.n : "？？？"}</span>
          </div>
        ))}
      </div>
      {got < defs.length &&
        <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.72rem",marginTop:8}}>
          ❔はアプリのどこかに隠れている遊びを見つけると解放されます
        </div>}
    </div>
  );
}

// 🐈 看板猫。カードの隅に住んでいて、なでると返事をする
function NekoMascot() {
  const [say, setSay] = useState(null);
  const WORDS = ["にゃ〜","いらっしゃい🌈","今日も来てくれた！","☕ いる？","ごゆっくり〜","✨✨","なでた？"];
  const tap = (e) => {
    e.stopPropagation();
    setSay({ t: WORDS[Math.floor(Math.random() * WORDS.length)], id: Date.now() });
    try { navigator.vibrate && navigator.vibrate(8); } catch {}
    setTimeout(() => setSay(null), 1600);
  };
  return (
    <span className="neko" onClick={tap} role="button" aria-label="看板猫">
      🐈‍⬛
      {say && <span key={say.id} className="neko-say">{say.t}</span>}
    </span>
  );
}

// 🎨 きせかえ。夜空の色味を4種類から選べる（端末に記憶される）
const NIGHT_THEMES = [
  { n: "よる",     h: "0deg"   },
  { n: "ゆうやけ", h: "-45deg" },
  { n: "うみ",     h: "70deg"  },
  { n: "もり",     h: "150deg" },
];
function ThemeButton() {
  const [i, setI] = useState(() => { try { return Number(localStorage.getItem("niji_theme") || 0) % NIGHT_THEMES.length; } catch { return 0; } });
  const next = () => {
    const j = (i + 1) % NIGHT_THEMES.length;
    setI(j);
    try { localStorage.setItem("niji_theme", String(j)); } catch {}
    document.body.style.setProperty("--nh", NIGHT_THEMES[j].h);
  };
  return <button className="theme-btn" onClick={next}>🎨 {NIGHT_THEMES[i].n}</button>;
}

// 気分で選ぶ。「さっぱり」を押すとそれっぽい一杯だけが並ぶ
const MOODS = [
  ["さっぱり", "🍋", /美酢|お酢|ザクロ|マスカット|グレープ|パイナップル|アセロラ|シトラス|アサイー|ライチ|カシス|リンゴ|メロン|ブドウ|あまおう|ピーチ/],
  ["あまい",   "🍓", /ミルク|練乳|アイスクリーム|かき氷|ヘーゼルナッツ/],
  ["ほっと",   "☕", /ホット|しょうが/],
  ["ひんやり", "🧊", /アイス|かき氷/],
];
function MoodPicker({ menu, onAdd }) {
  const [sel, setSel] = useState(null);
  const items = sel ? menu.filter((m) => sel[2].test(m.name) || sel[2].test(m.category)) : [];
  return (
    <div style={{marginBottom:10}}>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {MOODS.map((m) => (
          <button key={m[0]} className={"mood-chip" + (sel === m ? " mood-on" : "")}
            onClick={() => setSel(sel === m ? null : m)}>
            {m[1]} {m[0]}
          </button>
        ))}
      </div>
      {sel && (
        <div className="toy-panel" style={{marginTop:8}}>
          <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.8rem",marginBottom:8}}>
            {sel[1]} 「{sel[0]}」な気分のあなたへ（{items.length}品）
          </div>
          {items.length === 0
            ? <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem"}}>いまは該当なし……ごめんね</div>
            : <div className="menu-grid-auto">
                {items.map((item) => (
                  <button key={item.id} className="menu-item" onClick={() => onAdd(item)}>
                    <span className="m-emoji" style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                    <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink,#3d3630)",lineHeight:1.25,marginTop:3,textAlign:"center"}}>{item.name}</span>
                    <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                  </button>
                ))}
              </div>}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  数字がカラカラと巻き上がる表示
// ══════════════════════════════════════════
// チケットを開いた瞬間、残高が0からすっと伸びる。
// 「ちゃんと残っている」ことが目で伝わる、小さなご褒美の演出。
// 端末の「視差効果を減らす」設定がオンなら、すぐ最終値を出す。
function CountUp({ value }) {
  const [shown, setShown] = useState(value);
  const prev = useRef(null);
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = prev.current === null ? 0 : prev.current;
    prev.current = value;
    if (reduce || from === value) { setShown(value); return; }
    const t0 = performance.now(), dur = 750;
    let raf;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);   // 最後にゆっくり止まる
      setShown(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{Number(shown).toLocaleString()}</>;
}

// ══════════════════════════════════════════
//  CUSTOMER VIEW
// ══════════════════════════════════════════
function CustomerView({ customers: allCustomers, menu: menuProp, orders: allOrders,
                        saveOrders: saveOrdersProp, saveC: saveCProp, designatedDrink: ddProp,
                        staffAccounts: staffProp, managerAccounts: mgrProp,
                        vipGiftDrink: vipProp, setScreen }) {
  const [input,        setInput]        = useState("");
  const [found,        setFound]        = useState(null);
  const [err,          setErr]          = useState("");
  const [cvTab,        setCvTab]        = useState("ticket");
  const [cart,         setCart]         = useState([]);
  const [ordered,      setOrdered]      = useState(false);
  // 注文完了のメッセージは毎回変わる（同じ言葉より、ちょっと嬉しい）
  const [okMsg,        setOkMsg]        = useState("注文を受け付けました！");
  const [okIcon,       setOkIcon]       = useState("✅");   // 20回に1回だけ🎉や⭐になる
  const [okExtra,      setOkExtra]      = useState("");     // 「今日の一杯目！」などのお祝い
  const [okEmojis,     setOkEmojis]     = useState(null);   // 紙吹雪の代わりに降る、頼んだ物の絵文字
  const [errN,         setErrN]         = useState(0);      // 暗証番号を間違えた回数（入力欄がぷるぷるする用）
  const [cleared,      setCleared]      = useState(0);      // カートを空にした直後の「また選んでね〜」
  // 残高の数字を2秒以内に5回連打すると🪙がはじける（隠し）
  const coinTaps = useRef({ n:0, t:0 });
  const [coinBurst, setCoinBurst] = useState(0);
  const tapBalance = () => {
    const now = Date.now();
    if (now - coinTaps.current.t > 2000) coinTaps.current.n = 0;
    coinTaps.current.t = now;
    if (++coinTaps.current.n >= 5) {
      coinTaps.current.n = 0;
      setCoinBurst(now);
      setTimeout(() => setCoinBurst(0), 900);
    }
  };
  // 前回より残高が増えていたら「+¥◯◯」がふわっと浮かぶ（チャージ直後のお祝い）
  const prevBal = useRef(null);
  const [delta, setDelta] = useState(null);
  useEffect(() => {
    if (!found) { prevBal.current = null; return; }
    const b = found.balance;
    if (prevBal.current !== null && b > prevBal.current) {
      setDelta({ v: b - prevBal.current, id: Date.now() });
      setTimeout(() => setDelta(null), 1800);
    }
    prevBal.current = b;
  }, [found && found.balance]);
  // 60秒さわらないと、カードのそばに💤が浮かぶ（居眠り）
  const [sleepy, setSleepy] = useState(false);
  const lastActive = useRef(Date.now());
  useEffect(() => {
    const wake = () => { lastActive.current = Date.now(); setSleepy(false); };
    const timer = setInterval(() => {
      if (Date.now() - lastActive.current > 60000) setSleepy(true);
    }, 5000);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("scroll", wake, true);
    return () => { clearInterval(timer); window.removeEventListener("pointerdown", wake); window.removeEventListener("scroll", wake, true); };
  }, []);
  // 注文が準備中のあいだ、ブラウザのタブ名も一緒に待ってくれる
  useEffect(() => {
    document.title = myPendingOrder ? "☕ 準備中… | 虹カフェ" : "虹カフェ";
    return () => { document.title = "虹カフェ"; };
  });
  const [benefitItems, setBenefitItems] = useState([]); // 無料特典アイテム
  const [benefitUsed,  setBenefitUsed]  = useState(false); // この注文で特典使用
  const [busy,         setBusy]         = useState(false);

  // ── サーバーから受け取った「自分の分だけ」のデータ ──────────────
  // これがあるときは、他の会員のデータを一切持たずに画面が動く。
  // サーバーが不調なときは null のままになり、今までどおりの動作に戻る。
  const [boot, setBoot] = useState(null);
  const custToken = useRef(null);   // お客様のログイン証
  const [showRanks, setShowRanks] = useState(false);

  const reset = () => { setCvTab("ticket"); setCart([]); setOrdered(false); setBenefitItems([]); setBenefitUsed(false); };

  const search = async () => {
    if (busy) return;
    setErr(""); setBusy(true);
    const v = input.trim();
    try {
      // 暗証番号の照合はサーバーの中で行う（全会員の暗証番号をブラウザに配らない）
      const r = await apiLogin("customer", { pin: v });
      custToken.current = r.token;
      const b = (await apiData("bootstrap", {}, r.token)).value;
      setBoot(b); setFound(b.customer); reset();
      setBusy(false);
      return;
    } catch (e) {
      if (e.rejected) { setErr("暗証番号が一致しませんでした。もう一回！"); setErrN(n=>n+1); setBusy(false); return; }
      // サーバーに繋がらないときは、お店が止まらないよう今までの方法で探す
      console.warn("サーバーに繋がらないため、従来の方法で確認します", e);
    }
    const c = (allCustomers || []).find(c => c && c.pin === v);
    if (c) { setBoot(null); custToken.current = null; setFound(c); reset(); }
    else { setErr("暗証番号が一致しませんでした。もう一回！"); setErrN(n=>n+1); }
    setBusy(false);
  };

  // ── サーバー経由の書き込み（自分の分だけ） ────────────────────
  const refresh = async () => {
    if (!custToken.current) return;
    try {
      const b = (await apiData("bootstrap", {}, custToken.current)).value;
      setBoot(b); setFound(b.customer);
    } catch (e) {
      // ログイン証が切れたら、暗証番号の入力からやり直してもらう
      if (e.status === 401) {
        custToken.current = null; setBoot(null); setFound(null);
        setErr("時間が経ったため、もう一度暗証番号を入力してください");
        return;
      }
      console.warn("最新の取得に失敗しました", e);
    }
  };

  // 特典の使用状況だけを更新する（残高や暗証番号はサーバー側で弾かれる）
  const saveMyBenefit = async (list) => {
    const me = (list || []).find(c => c && boot && c.id === boot.customer.id);
    if (!me) return;
    const value = {};
    ["benefitUsedMonth","toppingRemaining","toppingRemainingMonth","vipGiftUsedMonth"]
      .forEach(f => { if (f in me) value[f] = me[f] ?? null; });
    try {
      const r = await apiData("setMyBenefit", { value }, custToken.current);
      setBoot(b => b ? { ...b, customer: r.value } : b);
      setFound(r.value);
    } catch (e) {
      console.error("特典の更新に失敗しました", e);
      alert("更新に失敗しました。もう一度お試しください。");
      refresh();
    }
  };

  // 注文の作成・取り消し。増えていれば作成、減っていれば取り消しとして扱う。
  const saveMyOrders = async (list) => {
    const prev = (boot && boot.myOrders) || [];
    const prevIds = new Set(prev.map(o => o && o.orderId));
    const listIds = new Set((list || []).map(o => o && o.orderId));
    const added   = (list || []).filter(o => o && o.orderId && !prevIds.has(o.orderId));
    const removed = prev.filter(o => o && o.orderId && !listIds.has(o.orderId));
    try {
      if (added.length > 0) {
        // 新しい注文を出す。同じ種類の未処理注文はサーバー側で置き換わる。
        for (const o of added) await apiData("placeMyOrder", { value: o }, custToken.current);
      } else {
        for (const o of removed) await apiData("cancelMyOrder", { value: { orderId: o.orderId } }, custToken.current);
      }
      await refresh();
    } catch (e) {
      console.error("注文の保存に失敗しました", e);
      alert("注文の保存に失敗しました。通信状況を確認して、もう一度お試しください。");
      refresh();
    }
  };

  // 画面を開いている間は定期的に最新の状態を取り直す（注文の完了や残高の変化を反映）
  useEffect(() => {
    if (!boot) return;
    let alive = true;
    const tick = () => { if (!document.hidden && alive) refresh(); };
    const timer = setInterval(tick, 8000);
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false; clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [boot ? boot.customer.id : null]);

  // ── boot があれば「自分の分だけ」を、無ければ今までどおりの全体を使う ──
  const customers       = boot ? [boot.customer] : allCustomers;
  const orders          = boot ? (boot.myOrders || []) : allOrders;
  const menu            = boot ? (boot.menu || menuProp) : menuProp;
  const designatedDrink = boot ? boot.designatedDrink : ddProp;
  const vipGiftDrink    = boot ? boot.vipGiftDrink : vipProp;
  // スタッフ割引は「自分に紐づいた分」だけをサーバーから受け取る（スタッフ一覧は受け取らない）
  const staffAccounts   = boot
    ? (boot.staffDiscountRate != null
        ? [{ id:"_linked", name: boot.staffLinkedName, discountRate: boot.staffDiscountRate, linkedCustomerId: boot.customer.id }]
        : [])
    : staffProp;
  const managerAccounts = boot ? [] : mgrProp;
  const saveC           = boot ? saveMyBenefit : saveCProp;
  const saveOrders      = boot ? saveMyOrders  : saveOrdersProp;

  const rank         = found ? getEffectiveRank(found) : null;
  const next         = found ? nextRank(found.currentYearPurchases ?? 0) : null;
  const used         = found ? isBenefitUsed(found) : false;
  const isAlways     = rank?.benefit.type === "always_discount";
  const isMonthly    = rank?.benefit.type === "monthly";
  const toppingMax   = rank ? getToppingMax(rank) : 0;
  const isToppingRank = toppingMax > 0;
  // トッピング: 残り使用回数
  const availableTopping = (found && isToppingRank) ? getToppingAvailable(found, rank) : 0;
  const toppingFullyUsed = (found && isToppingRank) ? isToppingFullyUsed(found, rank) : false;
  // 特典が使えるか
  const showBenefit = isMonthly && (isToppingRank ? !toppingFullyUsed : !used);
  const cyp          = found ? (found.currentYearPurchases ?? 0) : 0;
  const nextYearRank = found ? getRank(cyp) : null;
  const pct = found && next
    ? Math.min(100, ((cyp - getRank(cyp).min) / (next.min - getRank(cyp).min)) * 100)
    : 100;

  // VIPプレゼントの注文は「🎁 プレゼント」タブが別に管理しているので、
  // 通常の注文の未処理判定からは外す。混ぜると、通常注文をしたときに
  // プレゼントの注文が巻き添えで消え、しかも受け取り済みの表示だけが残ってしまう。
  const myPendingOrder = found ? orders.find(o=>o.customerId===found.id && o.status==="pending" && !o.isVipGift) : null;
  // スタッフ・マネージャーリンク確認
  const linkedStaff = found
    ? (staffAccounts.find(s=>s.linkedCustomerId===found.id) || (managerAccounts||[]).find(s=>s.linkedCustomerId===found.id))
    : null;
  const isStaffAccount = !!linkedStaff;
  const categories = [...new Set(menu.map(m=>m.category))];
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  // スタッフ割引：常に全品10%オフ
  const discountRate  = linkedStaff ? (linkedStaff.discountRate ?? 10) : 0;
  const staffDiscount = isStaffAccount ? Math.floor(subtotal * discountRate / 100) : 0;
  const discount = rank ? calcDiscount(rank, subtotal) : 0;
  const isSpecial = !!found?.isSpecial;
  const total    = isSpecial ? 0 : Math.max(0, subtotal - discount - staffDiscount);

  const addToCart = (item) => setCart(prev=>{
    const ex=prev.find(c=>c.id===item.id);
    return ex ? prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c) : [...prev,{...item,qty:1}];
  });
  const removeOne = (id) => setCart(prev=>{
    const ex=prev.find(c=>c.id===id);
    if(!ex) return prev;
    return ex.qty===1 ? prev.filter(c=>c.id!==id) : prev.map(c=>c.id===id?{...c,qty:c.qty-1}:c);
  });

  const placeOrder = () => {
    if ((cart.length===0 && benefitItems.length===0) || !found) return;
    // 残高が足りないときは注文を受け付けない（ボタンの見た目だけでなく処理でも止める）
    if (total > found.balance) { alert("残高が不足しています。スタッフにチャージをお申し付けください。"); return; }
    const order = {
      orderId: `ord_${Date.now()}`,
      customerId: found.id, customerName: found.name,
      rankName: rank.name, rankColor: rank.color, rankGem: rank.gem,
      items: cart, benefitItems,
      subtotal, discount, staffDiscount: isSpecial ? 0 : staffDiscount, total,
      usedBenefit: benefitUsed,
      usedToppingCount: benefitItems.length,
      isSpecial: isSpecial || false,
      staffLinked: linkedStaff ? linkedStaff.name : null,
      status: "pending",
      createdAt: new Date().toLocaleString("ja-JP"),
    };
    // 通常の注文を出すとき、置き換えるのは同じ人の「通常の」未処理注文だけ。
    // VIPプレゼントの注文は消さない。
    saveOrders([order, ...orders.filter(o=>!(o.customerId===found.id && o.status==="pending" && !o.isVipGift))]);

    // 書き込みの土台は同期済みの最新を使う（開きっぱなしの画面の古い残高で上書きしないため）
    let updated = { ...(customers.find(c=>c.id===found.id) || found) };
    if (benefitUsed) {
      if (isToppingRank) {
        const newRemaining = availableTopping - benefitItems.length;
        updated = { ...updated, toppingRemaining: newRemaining, toppingRemainingMonth: currentMonth() };
      } else {
        updated = { ...updated, benefitUsedMonth: currentMonth() };
      }
      saveC(customers.map(c=>c.id===found.id ? updated : c));
      setFound(updated);
    }
    const OK = ["注文を受け付けました！","うけたまわりました〜！","ありがとうございます♪","ただいまお作りします！","ナイスチョイス！✨"];
    setOkMsg(OK[Math.floor(Math.random() * OK.length)]);
    // ✅は20回に1回だけ🎉か⭐になる（当たり）
    setOkIcon(Math.random() < 0.05 ? (Math.random() < 0.5 ? "🎉" : "⭐") : "✅");
    // 紙吹雪の代わりに、頼んだドリンクの絵文字が降ってくる
    setOkEmojis([...cart.map(c => c.emoji), ...benefitItems.map(b => b.emoji)].filter(Boolean));
    // 節目のお祝い：10杯ごと／その日の最初の注文
    const mine = (orders || []).filter(o => o && String(o.customerId) === String(found.id));
    const nth = mine.length + 1;
    const todayKey = new Date().toLocaleDateString("ja-JP");
    const firstToday = !mine.some(o => String(o.createdAt || "").indexOf(todayKey + " ") === 0);
    setOkExtra(nth % 10 === 0 ? `☕ これで${nth}杯目のご注文！` : firstToday ? "今日の一杯目！" : "");
    setCart([]); setBenefitItems([]); setBenefitUsed(false); setOrdered(true);
    // 対応している端末（主にAndroid）では、注文完了を指先にも「トン・トン」と伝える
    try { navigator.vibrate && navigator.vibrate([16, 70, 24]); } catch {}
  };

  const cancelOrder = () => {
    if (!myPendingOrder) return;
    let updated = { ...(customers.find(c=>c.id===found.id) || found) };
    if (myPendingOrder.usedBenefit) {
      if (isToppingRank) {
        // 月が変わっていたら満数に戻っている扱い（先月の残りを土台にしない）
        const base = (found.toppingRemainingMonth === currentMonth()) ? (found.toppingRemaining ?? toppingMax) : toppingMax;
        const restored = base + (myPendingOrder.usedToppingCount || 0);
        updated = { ...updated, toppingRemaining: Math.min(restored, toppingMax), toppingRemainingMonth: currentMonth() };
      } else {
        updated = { ...updated, benefitUsedMonth: null };
      }
      saveC(customers.map(c=>c.id===found.id ? updated : c));
      setFound(updated);
    }
    saveOrders(orders.filter(o=>o.orderId!==myPendingOrder.orderId));
    setOrdered(false);
  };

  return (
    <div style={S.page}>
      <NightMode/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button className="back-btn" onClick={()=>{setScreen("home");setFound(null);setInput("");}}>← 戻る</button>
        {/* きせかえ：夜空の色を4種類から選べる */}
        <ThemeButton/>
      </div>
      <h2 style={S.title}>チケット確認</h2>

      {!found ? (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <p style={S.hint}>暗証番号を入力してください</p>
          {/* 間違えると入力欄がぷるぷる震える（クラスを交互に付け替えて毎回震わせる） */}
          <input style={S.input} type="password" placeholder="暗証番号" value={input}
            className={errN ? `wobble-${errN % 2}` : ""}
            onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()}/>
          {err && <p style={S.err}>{err}</p>}
          <button className="btn-gold" onClick={search}>確認する</button>
        </div>
      ) : (
        <div>
          <div style={{display:"flex",background:"var(--panel2,#f2ece4)",borderRadius:12,padding:4,marginBottom:14,gap:4}}>
            {[
              ["ticket","🎫 チケット"],
              ["order","🛒 注文する"],
              // 🎁はときどきもぞもぞ動く（中身が気になっているらしい）
              ...(found.isVIP ? [["present", <span key="p"><span className="wiggle">🎁</span> プレゼント</span>]] : []),
            ].map(([k,l])=>(
              <button key={k} className={`tab-btn ${cvTab===k?"active":""}`} onClick={()=>setCvTab(k)}
                style={{position:"relative"}}>
                {l}
                {k==="order" && myPendingOrder && (
                  <span style={{position:"absolute",top:4,right:6,background:"#e8467f",borderRadius:"50%",width:7,height:7,display:"block"}}/>
                )}
              </button>
            ))}
          </div>

          {/* 入場の虹カーテンと、ランクアップの祝祭（条件が揃った時だけ出る） */}
          <WelcomeSweep found={found}/>
          {cvTab==="ticket" && (
            <div>
              <RankUpShow found={found} rank={rank}/>
              {/* カードは白地にして、ランクの色は上端の帯・バッジ・バーだけに使う。
                  以前はカード全体をランク色のグラデーションで塗っていたため、
                  シルバーやプラチナの人には画面全体が灰色一色になり、
                  一番大事な残高まで薄い灰色で「使えなくなったカード」のように見えていた。 */}
              <HoloCard className="ticket-card card-in" style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#ece4d9)",
                boxShadow:`0 6px 22px ${rank.glow}22`,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,right:0,height:5,background:rank.bg}}/>
                {/* 開いた瞬間、光の帯がカードを一度だけ横切る */}
                <div className="card-sheen" aria-hidden="true"/>
                {/* カードの隅に住んでいる看板猫。なでると返事をする */}
                <NekoMascot/>
                {/* 残高1万円以上は✨が、777は🪙が、カードの中で静かに降り続ける */}
                {found.balance >= 10000 && <SparkleRain emoji="✨"/>}
                {String(found.balance).includes("777") && <SparkleRain emoji="🪙"/>}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,marginTop:4,flexWrap:"wrap"}}>
                  <span style={{fontSize:"1.15rem",fontWeight:700,color:"var(--ink,#3d3630)"}}>{found.name}</span>
                  <span style={{...S.rankBadge,color:rank.color,borderColor:rank.color+"55",background:rank.color+"14",marginBottom:0}}>
                    {/* 宝石を押すとキラキラがはじける */}
                    <TapBurst emojis={["✨","💖","⭐","✨"]}>
                      <span className="gem-pulse">{rank.gem}</span>
                    </TapBurst> {rank.name}
                  </span>
                </div>
                {/* 残高はランクに関係なく、いつも一番はっきり読める濃さにする。
                    この画面を開く理由がこれなので、色よりも読みやすさを優先する。
                    隠し：5回連打で🪙／ゾロ目や777だとお祝いが付く */}
                <div style={{marginBottom:16,position:"relative"}}>
                  <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginBottom:2}}>
                    のこり
                    {sleepy && <span className="sleepy" aria-hidden="true">💤</span>}
                  </div>
                  <div onClick={tapBalance}
                    style={{color:"var(--ink-strong,#2f2925)",fontSize:"2.6rem",fontWeight:800,letterSpacing:"-0.02em",lineHeight:1.05,fontVariantNumeric:"tabular-nums"}}>
                    ¥<CountUp value={found.balance}/>
                    {delta && <span key={delta.id} className="delta-up">+¥{delta.v.toLocaleString()}</span>}
                    {String(found.balance).includes("777") &&
                      <span className="chip-pop">777！✨</span>}
                    {found.balance >= 111 && /^(\d)\1+$/.test(String(found.balance)) && !String(found.balance).includes("777") &&
                      <span className="chip-pop">ゾロ目！✨</span>}
                    {coinBurst !== 0 && (
                      <span key={coinBurst} className="burst" aria-hidden="true">
                        {["🪙","🪙","🪙","🪙","🪙","🪙","🪙","🪙"].map((e,i)=>(
                          <span key={i} className="burst-p" style={{"--a":`${i*45}deg`}}>{e}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  {found.balance === 0 &&
                    <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.8rem",marginTop:4}}>また来てね ☕</div>}
                </div>
                <div style={{...S.benefitBox,borderColor:rank.color+"55",background:rank.color+"11"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{color:rank.color,fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>
                        {isAlways?"✨ 自動特典":"🎁 今月の特典"}
                      </div>
                      <div style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"0.95rem"}}>{rank.benefit.icon} {rank.benefit.desc}</div>
                    </div>
                    {isAlways?<div style={S.benefitTagAlways}>毎回適用</div>
                      :used?<div style={S.benefitTagUsed}>使用済み</div>
                      :<div style={{...S.benefitTagAvail,borderColor:rank.color,color:rank.color}}>未使用</div>}
                  </div>
                  {!isAlways&&<div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:8}}>
                    {used?"来月またご利用いただけます":"スタッフにお申し付けください"}
                  </div>}
                </div>
                {/* 回数と次のランクを1つにまとめた。
                    以前は「今年の購入回数」「来年のランク予測」「あと何回」「バー」が
                    バラバラに4段あって、読むのに手間がかかっていた。
                    来年の予測は今この場では要らない情報なので落とした。 */}
                <div style={S.divider}/>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
                  <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>今年 {cyp}回</span>
                  {next
                    ? <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>あと{next.min-cyp}回で <span style={{color:next.color,fontWeight:700}}>{next.gem}{next.name}</span></span>
                    : <span style={{color:rank.color,fontSize:"0.85rem",fontWeight:700}}>最高ランクです</span>}
                </div>
                {/* ランクアップまであと1回のときだけ、バーが虹色に脈打つ（もうすぐの高鳴り） */}
                {next && <div style={S.bar}>
                  <div className={`bar-fill${next.min - cyp === 1 ? " bar-rainbow" : ""}`}
                    style={{width:`${pct}%`,background:rank.color}}/>
                </div>}
              </HoloCard>
              {/* ランク一覧は9行あり、毎回見る情報ではない。
                  常に開いていると本題（残高と特典）が画面外に押し出されるので、
                  必要なときだけ開く形にした。 */}
              <button onClick={()=>setShowRanks(v=>!v)}
                style={{width:"100%",marginTop:14,background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:16,
                  padding:"14px 16px",cursor:"pointer",fontFamily:"inherit",display:"flex",
                  justifyContent:"space-between",alignItems:"center",color:"var(--ink2,#8a7f76)",fontSize:"0.95rem"}}>
                <span>ランクと特典を見る</span>
                <span style={{color:"var(--ink4,#a79b90)"}}>{showRanks?"閉じる ▲":"▼"}</span>
              </button>
              {showRanks && (
              <div style={{marginTop:8,background:"var(--card,#ffffff)",borderRadius:16,padding:"14px 16px"}}>
                {RANKS.map(r=>{
                  const unlocked=found.rankBasis>=r.min, isCur=r.name===rank.name;
                  return (
                    <div key={r.name} style={{...S.rankRow,opacity:unlocked?1:0.35,background:isCur?rank.color+"18":"transparent",borderRadius:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                        <span style={{fontSize:"0.95rem"}}>{r.gem}</span>
                        <div>
                          <span style={{color:r.color,fontWeight:700,fontSize:"0.85rem"}}>{r.name}</span>
                          <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginLeft:6}}>{r.min}回〜</span>
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>{r.benefit.icon} {r.benefit.desc}</span>
                        {r.benefit.type==="always_discount"&&<span style={{color:r.color,fontSize:"0.75rem",marginLeft:4,fontWeight:700}}>毎回</span>}
                      </div>
                      {isCur&&<div style={{...S.curDot,background:rank.color}}/>}
                    </div>
                  );
                })}
              </div>
              )}
              {/* 今日の一節（聖書 新改訳2017）と、実績バッジの棚 */}
              <TodayVerse/>
              <BadgeShelf found={found} orders={orders}/>
              <RankingBoard customers={customers} myId={found.id}/>
              {/* めったに使わない操作なので、一番下で控えめに */}
              <button className="btn-quiet" style={{marginTop:10}} onClick={()=>{setFound(null);setInput("");}}>別の番号を確認する</button>
            </div>
          )}

          {cvTab==="present" && found.isVIP && (
            <VipPresentTab
              found={found}
              vipGiftDrink={vipGiftDrink}
              orders={orders}
              saveOrders={saveOrders}
              saveC={saveC}
              customers={customers}
            />
          )}
          {cvTab==="order" && (
            <div>
              {myPendingOrder ? (
                <div style={{background:"#e9f5ec",border:"1px solid #c9e2ce",borderRadius:16,padding:16}}>
                  <div style={{color:"#3e9a5c",fontWeight:700,fontSize:"0.95rem",marginBottom:10}}>✅ 注文受付済み — スタッフが準備中です</div>
                  {myPendingOrder.items.map((item,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
                      <span style={{color:"var(--ink2,#8a7f76)"}}>{item.emoji} {item.name} × {item.qty}</span>
                      <span style={{color:"var(--gold,#b07c1e)"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                    </div>
                  ))}
                  {(myPendingOrder.benefitItems||[]).map((item,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
                      <span style={{color:"var(--ink2,#8a7f76)"}}>{item.emoji} {item.name}</span>
                      <span style={{color:"#3e9a5c",fontSize:"0.85rem"}}>🎁 無料</span>
                    </div>
                  ))}
                  <div style={{borderTop:"1px solid #c9e2ce",paddingTop:8,marginTop:6,display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>合計</span>
                    <span style={{color:"#3e9a5c",fontWeight:800}}>¥{myPendingOrder.total.toLocaleString()}</span>
                  </div>
                  <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:6}}>{myPendingOrder.createdAt} に注文</div>
                  <button className="btn-danger" style={{marginTop:12,padding:"9px"}} onClick={cancelOrder}>注文をキャンセル</button>
                </div>
              ) : ordered ? (
                <div style={{textAlign:"center",padding:"32px 16px"}}>
                  {/* 紙吹雪——ではなく、いま頼んだドリンクの絵文字が降ってくる */}
                  <div className="confetti-box" aria-hidden="true">
                    {okEmojis && okEmojis.length ? [...Array(12)].map((_,i)=>(
                      <span key={i} className="confetti-e" style={{left:`${6+i*8}%`,
                        animationDelay:`${(i%5)*0.1}s`,animationDuration:`${1.2+(i%4)*0.22}s`}}>
                        {okEmojis[i % okEmojis.length]}
                      </span>
                    )) : ["#e8759b","#e8944a","#d9a821","#5fa878","#5b93c9","#8a7cc4",
                      "#e8759b","#5fa878","#5b93c9","#d9a821","#8a7cc4","#e8944a"].map((c,i)=>(
                      <i key={i} style={{left:`${6+i*8}%`,background:c,
                        animationDelay:`${(i%5)*0.1}s`,animationDuration:`${1.2+(i%4)*0.22}s`}}/>
                    ))}
                  </div>
                  {/* ✅の後ろから光線が放射され、「今日の一杯目」は両脇から大砲も撃つ */}
                  <div style={{position:"relative",display:"inline-block"}}>
                    <div className="rays" aria-hidden="true"/>
                    <div className="pop" style={{fontSize:"3rem",marginBottom:12,position:"relative"}}>{okIcon}</div>
                  </div>
                  {okExtra === "今日の一杯目！" && (
                    <div aria-hidden="true">
                      {[...Array(7)].map((_,i)=>(
                        <span key={"l"+i} className="cannon cannon-l" style={{animationDelay:`${i*0.07}s`,"--cx":`${40+i*22}px`,"--cy":`${-90-(i%4)*30}px`}}>
                          {(okEmojis&&okEmojis[i%okEmojis.length])||"🎉"}
                        </span>
                      ))}
                      {[...Array(7)].map((_,i)=>(
                        <span key={"r"+i} className="cannon cannon-r" style={{animationDelay:`${i*0.07}s`,"--cx":`${-40-i*22}px`,"--cy":`${-90-(i%4)*30}px`}}>
                          {(okEmojis&&okEmojis[i%okEmojis.length])||"🎉"}
                        </span>
                      ))}
                    </div>
                  )}
                  {okExtra && <div className="chip-pop" style={{position:"static",display:"inline-block",marginBottom:8}}>{okExtra}</div>}
                  <div style={{color:"#3e9a5c",fontWeight:700,fontSize:"1.15rem",marginBottom:6}}>{okMsg}</div>
                  <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>スタッフが準備します。しばらくお待ちください。</div>
                  <button className="btn-ghost" style={{marginTop:20}} onClick={()=>setOrdered(false)}>続けて注文する</button>
                </div>
              ) : (
                <div>
                  {/* ── スペシャル無料バナー ── */}
                  {isSpecial && (
                    <div style={{background:"linear-gradient(135deg,#f5eafa,#eddcf5)",border:"1px solid #c98ada55",borderRadius:12,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:"1.15rem"}}>💜</span>
                      <div>
                        <div style={{color:"#9c3fb5",fontWeight:800,fontSize:"0.95rem"}}>スペシャル — 全品無料</div>
                        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem"}}>全ての注文が¥0になります</div>
                      </div>
                    </div>
                  )}

                  {/* ── スタッフ割引バナー ── */}
                  {isStaffAccount && (
                    <div style={{background:"#e9f5ec",border:"1px solid #7cc39444",borderRadius:12,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:"1rem"}}>🟢</span>
                      <div>
                        <div style={{color:"#3e9a5c",fontWeight:700,fontSize:"0.85rem"}}>スタッフ割引 {discountRate}%OFF</div>
                        {/* ここは「10%」と決め打ちで書かれていたため、
                            割引率が15%の人には上下で違う数字が並んで見えていた。 */}
                        <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>全商品が自動で{discountRate}%オフになります</div>
                      </div>
                    </div>
                  )}

                  {/* ── 月次特典セクション（未使用/残あり時のみ表示） ── */}
                  {showBenefit && (
                    <BenefitOrderSection
                      rank={rank}
                      menu={menu}
                      benefitUsed={benefitUsed}
                      benefitItems={benefitItems}
                      setBenefitItems={setBenefitItems}
                      setBenefitUsed={setBenefitUsed}
                      designatedDrink={designatedDrink}
                      availableTopping={availableTopping}
                    />
                  )}

                  {/* 気分で選ぶチップと、迷ったとき用のシャッフル（見て遊べるおもちゃ） */}
                  <MoodPicker menu={menu} onAdd={(it)=>{ addToCart(it); popSound(); }}/>
                  <DrinkRoulette menu={menu} onPick={(it)=>{ addToCart(it); popSound(); }}/>

                  {/* カートを空にした直後だけ、ひとこと */}
                  {cleared !== 0 && <div key={cleared} className="cleared-note">また選んでね〜</div>}

                  {/* ── メニュー（カテゴリタブ） ── */}
                  <OrderMenuTabs
                    menu={menu}
                    cart={cart}
                    addToCart={addToCart}
                    removeOne={removeOne}
                  />

                  {/* ── カート ──
                      画面の下に貼り付いて、常に見えるようにしてある。
                      以前はメニュー33品の下にあったため、1品選ぶたびに
                      合計を見るために一番下までスクロールする必要があった。
                      選んだ品数が多いときは、この中だけがスクロールする。 */}
                  {(cart.length>0 || benefitItems.length>0) &&(
                    <div className="glass rise" style={{position:"sticky",bottom:8,zIndex:20,marginTop:8,
                      border:"1px solid var(--line,#e7ded3)",borderRadius:16,padding:"12px 14px",
                      boxShadow:"0 -6px 24px rgba(61,54,48,0.12)"}}>
                      <div style={{maxHeight:"32vh",overflowY:"auto"}}>
                      {cart.map(item=>(
                        <div key={item.id} style={S.cartRow}>
                          <span style={{color:"var(--ink,#3d3630)",fontSize:"0.85rem",fontWeight:600}}>{item.emoji} {item.name}</span>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <button className="qty-btn" onClick={()=>removeOne(item.id)}>－</button>
                            <span style={{color:"var(--ink,#3d3630)",minWidth:18,textAlign:"center",fontWeight:700}}>{item.qty}</span>
                            <button className="qty-btn" onClick={()=>addToCart(item)}>＋</button>
                            <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem",minWidth:56,textAlign:"right"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                      {benefitItems.map((item,i)=>(
                        <div key={i} style={{...S.cartRow,opacity:0.85}}>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
                          <span style={{color:rank.color,fontWeight:700,fontSize:"0.85rem"}}>🎁 無料</span>
                        </div>
                      ))}
                      </div>
                      <div style={{paddingTop:8,borderTop:"1px solid var(--line,#e7ded3)",marginTop:6}}>
                        {isSpecial&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"#9c3fb5",fontSize:"0.85rem"}}>💜 スペシャル割引</span>
                          <span style={{color:"#9c3fb5",fontSize:"0.85rem"}}>全品無料</span>
                        </div>}
                        {!isSpecial&&staffDiscount>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"#3e9a5c",fontSize:"0.85rem"}}>🟢 スタッフ割引 {discountRate}%</span>
                          <span style={{color:"#3e9a5c",fontSize:"0.85rem"}}>－¥{staffDiscount.toLocaleString()}</span>
                        </div>}
                        {!isSpecial&&discount>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>{rank.benefit.icon} ランク割引</span>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>－¥{discount.toLocaleString()}</span>
                        </div>}
                        {benefitItems.length>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>🎁 月次特典</span>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>無料</span>
                        </div>}
                        {/* 合計と一緒に「払ったあといくら残るか」を出す。
                            残高不足で押せなくなってから気づくのでは遅いため。 */}
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                          <div>
                            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>合計</div>
                            <div style={{color:total>found.balance?"#c25b52":"#a79b90",fontSize:"0.75rem",marginTop:2}}>
                              {total>found.balance
                                ? `のこり ¥${found.balance.toLocaleString()} — ¥${(total-found.balance).toLocaleString()} 足りません`
                                : `お支払い後 ¥${(found.balance-total).toLocaleString()}`}
                            </div>
                          </div>
                          <span style={{color:"var(--ink-strong,#2f2925)",fontWeight:800,fontSize:"1.7rem",letterSpacing:"-0.02em"}}>¥{total.toLocaleString()}</span>
                        </div>
                        {/* ちょうど500円なら「ワンコイン！」 */}
                        {total === 500 && <div className="chip-pop" style={{position:"static",display:"inline-block",marginBottom:8}}>ワンコイン！🪙</div>}
                        {/* 「クリア」は間違って押されると全部消える操作なので、小さく端に置く */}
                        <div style={{display:"flex",gap:8,alignItems:"stretch"}}>
                          <button className="btn-clear" style={{flexShrink:0,padding:"13px 14px",fontSize:"0.85rem"}}
                            onClick={()=>{setCart([]); setBenefitItems([]); setBenefitUsed(false); setCleared(Date.now()); setTimeout(()=>setCleared(0),1600);}}>クリア</button>
                          <button className="btn-pay"
                            disabled={(cart.length===0 && benefitItems.length===0) || total>found.balance}
                            style={{opacity:(cart.length>0||benefitItems.length>0)&&total<=found.balance?1:0.35,fontSize:"1rem"}}
                            onClick={placeOrder}>
                            {total<=found.balance?"注文する":"残高が足りません"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── VIP PRESENT TAB ──────────────────────
function VipPresentTab({ found, vipGiftDrink, orders, saveOrders, saveC, customers }) {
  const vipGiftUsed  = found.vipGiftUsedMonth === currentMonth();
  const pendingGift  = orders.find(o=>o.customerId===found.id && o.status==="pending" && o.isVipGift);

  const claimGift = () => {
    if (!vipGiftDrink || vipGiftUsed || pendingGift) return;
    const order = {
      orderId:      `ord_${Date.now()}`,
      customerId:   found.id,
      customerName: found.name,
      rankName:     "VIP", rankColor:"#ffd700", rankGem:"⭐",
      items:        [],
      benefitItems: [{ ...vipGiftDrink, price:0, qty:1 }],
      subtotal: 0, discount: 0, total: 0,
      isVipGift: true,
      staffLinked: null,
      status:   "pending",
      createdAt: new Date().toLocaleString("ja-JP"),
    };
    saveOrders([order, ...orders.filter(o=>!(o.customerId===found.id && o.status==="pending" && o.isVipGift))]);
    // 書き込みの土台は同期済みの最新を使う（開きっぱなしの画面の古い残高で上書きしないため）
    const base = customers.find(c=>c.id===found.id) || found;
    const updated = { ...base, vipGiftUsedMonth: currentMonth() };
    saveC(customers.map(c=>c.id===found.id ? updated : c));
  };

  const cancelGift = () => {
    if (!pendingGift) return;
    saveOrders(orders.filter(o=>o.orderId!==pendingGift.orderId));
    const base = customers.find(c=>c.id===found.id) || found;
    const updated = { ...base, vipGiftUsedMonth: null };
    saveC(customers.map(c=>c.id===found.id ? updated : c));
  };

  return (
    <div>
      {/* VIPバッジ */}
      <div style={{textAlign:"center",marginBottom:20,paddingTop:8}}>
        <div style={{fontSize:"2.5rem",marginBottom:8}}>⭐</div>
        <div style={{color:"#a9791a",fontWeight:800,fontSize:"1.15rem",letterSpacing:"0.08em"}}>VIP会員</div>
        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginTop:4}}>{found.name} さん専用</div>
      </div>

      {/* 今月のプレゼント */}
      <div style={{background:"linear-gradient(135deg,#faf0dc,#f7e7c4)",border:"1px solid #e8c14a55",borderRadius:16,padding:"20px",marginBottom:16}}>
        <div style={{color:"#a9791a",fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>🎁 今月のプレゼント</div>

        {!vipGiftDrink ? (
          <div style={{textAlign:"center",color:"var(--ink3,#9a8f85)",fontSize:"0.85rem",padding:"16px 0"}}>
            今月のプレゼントは設定中です<br/>
            <span style={{fontSize:"0.75rem",color:"var(--ink4,#a79b90)"}}>しばらくお待ちください</span>
          </div>
        ) : (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
              <span style={{fontSize:"2.5rem"}}>{vipGiftDrink.emoji}</span>
              <div>
                <div style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"1.15rem"}}>{vipGiftDrink.name}</div>
                <div style={{color:"#a9791a",fontSize:"0.85rem",marginTop:2}}>無料プレゼント ✨</div>
              </div>
            </div>

            {pendingGift ? (
              <div>
                <div style={{background:"#dcefe1",border:"1px solid #7cc39444",borderRadius:12,padding:"10px 14px",marginBottom:10,color:"#3e9a5c",fontWeight:700,fontSize:"0.85rem"}}>
                  ✅ スタッフが準備中です
                </div>
                <button className="btn-danger" style={{padding:"9px",fontSize:"0.85rem"}} onClick={cancelGift}>
                  キャンセル
                </button>
              </div>
            ) : vipGiftUsed ? (
              <div style={{background:"var(--panel2,#f6f1ea)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem"}}>今月は受け取り済みです</div>
                <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",marginTop:4}}>来月また受け取れます</div>
              </div>
            ) : (
              <button
                style={{width:"100%",background:"linear-gradient(135deg,#d9a441,#ffd98a)",color:"var(--ink,#3d3630)",
                  border:"none",borderRadius:12,padding:"15px",fontSize:"1rem",fontWeight:800,
                  cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.04em",
                  boxShadow:"0 4px 20px #ffd70044",transition:"transform 0.1s"}}
                onClick={claimGift}>
                🎁 プレゼントを受け取る
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",textAlign:"center"}}>
        プレゼントは月に1回受け取れます
      </div>
    </div>
  );
}

// ── BENEFIT ORDER SECTION ────────────────
function BenefitOrderSection({ rank, menu, benefitUsed, benefitItems, setBenefitItems, setBenefitUsed, designatedDrink, availableTopping }) {
  const [open, setOpen] = useState(false);

  const benefitName = rank.benefit.desc;
  const benefitIcon = rank.benefit.icon;

  const toppingMax     = getToppingMax(rank);
  const isToppingBenefit = toppingMax > 0;
  const selectable     = availableTopping; // 今回選べる残り回数
  const isCoffeeBenefit  = rank.name==="プラチナ";
  const isSpecificDrink  = rank.name==="チタン";
  const isAnyDrink       = rank.name==="サファイア";

  const toppingItems = menu.filter(m=>m.category==="トッピング");
  const coffeeItems  = menu.filter(m=>m.category==="コーヒー" && (m.name==="アイスコーヒー"||m.name==="ホットコーヒー"));
  const anyDrinkItems= menu.filter(m=>m.category==="コーヒー"||m.category==="ドリンク");

  const toggleTopping = (item) => {
    const already = benefitItems.find(b=>b.id===item.id);
    if (already) {
      const next = benefitItems.filter(b=>b.id!==item.id);
      setBenefitItems(next);
      if (next.length===0) setBenefitUsed(false);
    } else if (benefitItems.length < selectable) {
      setBenefitItems([...benefitItems, {...item, price:0, qty:1}]);
      setBenefitUsed(true);
    }
  };

  const selectDrink = (item) => {
    setBenefitItems([{...item, price:0, qty:1}]);
    setBenefitUsed(true);
    setOpen(false);
  };

  const clearBenefit = () => { setBenefitItems([]); setBenefitUsed(false); setOpen(false); };

  // ヘッダーのサブテキスト（残り回数表示）
  const subText = isToppingBenefit && selectable < toppingMax
    ? `（今月残り${selectable}回）`
    : isToppingBenefit
      ? `（${toppingMax}回分）`
      : "";

  return (
    <div style={{background:rank.color+"0e",border:`1px solid ${rank.color}44`,borderRadius:12,padding:"12px 14px",marginBottom:14}}>
      {/* ヘッダー */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(open||benefitUsed)?10:0}}>
        <div>
          <div style={{color:rank.color,fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:2}}>🎁 今月の特典</div>
          <div style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"0.85rem"}}>{benefitIcon} {benefitName}
            {subText && <span style={{color:rank.color,fontSize:"0.75rem",marginLeft:6,fontWeight:400}}>{subText}</span>}
          </div>
        </div>
        {benefitUsed ? (
          <button style={{background:"transparent",border:`1px solid ${rank.color}55`,borderRadius:999,
            padding:"4px 10px",color:rank.color,fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}}
            onClick={clearBenefit}>取り消す</button>
        ) : (
          <button style={{background:rank.color+"22",border:`1px solid ${rank.color}`,borderRadius:999,
            padding:"4px 12px",color:rank.color,fontWeight:700,fontSize:"0.85rem",cursor:"pointer",fontFamily:"inherit"}}
            onClick={()=>setOpen(p=>!p)}>
            {open?"閉じる":"使用する →"}
          </button>
        )}
      </div>

      {/* 選択済み表示 */}
      {benefitUsed && benefitItems.length>0 && (
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:open?8:0}}>
          {benefitItems.map((b,i)=>(
            <span key={i} style={{background:rank.color+"22",border:`1px solid ${rank.color}55`,
              borderRadius:999,padding:"3px 10px",color:rank.color,fontSize:"0.85rem",fontWeight:700}}>
              {b.emoji} {b.name} 🎁
            </span>
          ))}
          {isToppingBenefit && benefitItems.length < selectable && (
            <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",alignSelf:"center"}}>
              あと{selectable-benefitItems.length}つ選べます
            </span>
          )}
        </div>
      )}

      {open && isToppingBenefit && (
        <div>
          <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:8}}>
            トッピングを選択（あと{selectable - benefitItems.length}つ選べます）
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {toppingItems.map(item=>{
              const sel = !!benefitItems.find(b=>b.id===item.id);
              const disabled = !sel && benefitItems.length >= selectable;
              return (
                <button key={item.id}
                  disabled={disabled}
                  style={{background:sel?rank.color+"33":"#f6f1ea",
                    border:`1px solid ${sel?rank.color:"#e7ded3"}`,
                    borderRadius:12,padding:"12px 18px",cursor:disabled?"default":"pointer",
                    fontFamily:"inherit",color:sel?rank.color:disabled?"#a79b90":"#8a7f76",
                    fontWeight:sel?700:400,fontSize:"0.95rem",transition:"all 0.15s",opacity:disabled?0.4:1}}
                  onClick={()=>!disabled&&toggleTopping(item)}>
                  {item.emoji} {item.name}{sel&&" ✓"}
                </button>
              );
            })}
          </div>
          <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:6}}>
            {benefitItems.length}/{selectable} 選択中
            {selectable < toppingMax && ` （今月の残り使用回数: ${selectable}回）`}
          </div>
        </div>
      )}

      {/* コーヒー選択（プラチナ） */}
      {open && isCoffeeBenefit && (
        <div>
          <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:8}}>アイスコーヒー / ホットコーヒーから1杯選択</div>
          <div style={{display:"flex",gap:8}}>
            {coffeeItems.length===0
              ? <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem"}}>メニューにアイスコーヒー・ホットコーヒーがありません</div>
              : coffeeItems.map(item=>(
                <button key={item.id} className="menu-item"
                  style={{flex:1,border:`1px solid ${rank.color}44`,background:rank.color+"0a"}}
                  onClick={()=>selectDrink(item)}>
                  <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                  <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink2,#8a7f76)",lineHeight:1.2,marginTop:2}}>{item.name}</span>
                  <span style={{color:rank.color,fontWeight:700,fontSize:"0.75rem"}}>🎁 無料</span>
                </button>
              ))
            }
          </div>
        </div>
      )}

      {/* 指定ドリンク選択（チタン） */}
      {open && isSpecificDrink && (
        <div>
          <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:8}}>今月の指定ドリンク（1杯無料）</div>
          {!designatedDrink
            ? <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem",background:"var(--card,#ffffff)",borderRadius:8,padding:"10px 12px"}}>
                今月の指定ドリンクはスタッフが設定中です
              </div>
            : (
              <button className="menu-item" style={{width:"100%",border:`1px solid ${rank.color}55`,background:rank.color+"0a"}}
                onClick={()=>selectDrink(designatedDrink)}>
                <span style={{fontSize:"1.7rem"}}>{designatedDrink.emoji}</span>
                <span style={{fontSize:"0.85rem",fontWeight:700,color:"var(--ink2,#8a7f76)",marginTop:2}}>{designatedDrink.name}</span>
                <span style={{color:rank.color,fontWeight:700,fontSize:"0.85rem"}}>🎁 今月の指定ドリンク</span>
              </button>
            )
          }
        </div>
      )}

      {/* 好きなドリンク選択（サファイア） */}
      {open && isAnyDrink && (
        <div>
          <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:8}}>好きなドリンクを1杯選択（全て対象）</div>
          <div style={S.menuGrid}>
            {anyDrinkItems.map(item=>(
              <button key={item.id} className="menu-item"
                style={{border:`1px solid ${rank.color}44`,background:rank.color+"0a"}}
                onClick={()=>selectDrink(item)}>
                <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink,#3d3630)",lineHeight:1.25,marginTop:3,textAlign:"center"}}>{item.name}</span>
                <span style={{color:rank.color,fontWeight:700,fontSize:"0.75rem"}}>🎁 無料</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ORDER MENU TABS ───────────────────────
function OrderMenuTabs({ menu, cart, addToCart, removeOne }) {
  const categories = [...new Set(menu.map(m=>m.category))];
  const [activeTab, setActiveTab] = useState(categories[0] || "");
  // 直前に追加した商品（「+1」の飛び出しを出す場所）
  const [lastAdd, setLastAdd] = useState(null);
  // 効果音のオン・オフ（初期はオフ。設定は端末に記憶される）
  const [sndOn, setSndOn] = useState(() => { try { return localStorage.getItem("niji_snd") === "on"; } catch { return false; } });
  const toggleSnd = () => {
    const next = !sndOn;
    setSndOn(next);
    try { localStorage.setItem("niji_snd", next ? "on" : "off"); } catch {}
    if (next) popSound();   // オンにした瞬間に一度鳴らして、音量を確かめられるように
  };

  return (
    <div>
      {/* カテゴリタブ。スクロールしても上に貼り付いたままにして、
          下の方の商品を見ている途中でもカテゴリを切り替えられるようにする。 */}
      <div style={{display:"flex",gap:0,overflowX:"auto",background:"var(--card,#ffffff)",borderRadius:"10px 10px 0 0",marginBottom:0,
        position:"sticky",top:0,zIndex:15,borderBottom:"1px solid #f0eae2"}}>
        {categories.map(cat=>(
          <button key={cat}
            style={{flexShrink:0,background:"transparent",border:"none",
              borderBottom:`2px solid ${activeTab===cat?"#d3a94f":"transparent"}`,
              color:activeTab===cat?"#b07c1e":"#9a8f85",padding:"9px 14px",fontSize:"0.85rem",
              fontWeight:activeTab===cat?700:400,cursor:"pointer",fontFamily:"inherit",
              transition:"all 0.15s",whiteSpace:"nowrap"}}
            onClick={()=>setActiveTab(cat)}>
            {cat}
          </button>
        ))}
        {/* 効果音の切り替え（押すと「ぽっ」と鳴る。初期はオフ） */}
        <button onClick={toggleSnd} title="効果音"
          style={{marginLeft:"auto",flexShrink:0,background:"transparent",border:"none",
            padding:"9px 12px",cursor:"pointer",fontSize:"0.95rem",opacity:sndOn?1:0.45}}>
          {sndOn ? "🔔" : "🔕"}
        </button>
      </div>
      {/* 選択カテゴリのメニュー */}
      <div style={{background:"var(--card,#ffffff)",borderRadius:"0 0 10px 10px",padding:"10px 8px",marginBottom:8}}>
        <div style={S.menuGrid}>
          {menu.filter(m=>m.category===activeTab).map(item=>{
            const inCart=cart.find(c=>c.id===item.id);
            return (
              <button key={item.id} className={`menu-item ${inCart?"menu-item-active":""}`}
                onClick={()=>{ addToCart(item); setLastAdd({id:item.id, n:Date.now()}); popSound(); }}>
                {/* 押した瞬間、絵文字がぷるんと弾んで「+1」が飛び出す */}
                <span className="m-emoji" style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink,#3d3630)",lineHeight:1.25,marginTop:3,textAlign:"center"}}>{item.name}</span>
                <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                {inCart&&<div key={inCart.qty} className="pop" style={S.cartBadge}>{inCart.qty}</div>}
                {inCart&&inCart.qty>=5&&<span className="hot-tag">大人気！</span>}
                {lastAdd && lastAdd.id===item.id && <span key={lastAdd.n} className="plus-one">+1</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── RANKING BOARD ────────────────────────
function RankingBoard({ customers, myId }) {
  // ランク順（rankBasis降順）→ 今年の購入回数降順 でソートしてTOP5
  const sorted = [...customers].sort((a, b) => {
    const ra = getEffectiveRank(a);
    const rb = getEffectiveRank(b);
    const ri = RANKS.findIndex(r=>r.name===ra.name);
    const rj = RANKS.findIndex(r=>r.name===rb.name);
    if (rj !== ri) return rj - ri;
    return (b.currentYearPurchases??0) - (a.currentYearPurchases??0);
  });

  const medals = ["🥇","🥈","🥉"];

  return (
    <div style={{marginTop:20,marginBottom:8}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <div style={{flex:1,height:1,background:"linear-gradient(90deg,transparent,#f6f1ea)"}}/>
        <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",letterSpacing:"0.1em",whiteSpace:"nowrap"}}>🏆 メンバーズランキング</span>
        <div style={{flex:1,height:1,background:"linear-gradient(90deg,#f6f1ea,transparent)"}}/>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {sorted.map((c, i) => {
          const r    = getEffectiveRank(c);
          const isMe = c.id === myId;
          return (
            <div key={c.id} style={{
              display:"flex", alignItems:"center", gap:10,
              background: isMe ? r.color+"18" : "#ffffff",
              border: `1px solid ${isMe ? r.color+"55" : "#e7ded3"}`,
              borderRadius:12, padding:"9px 12px",
              boxShadow: isMe ? `0 0 12px ${r.color}22` : "none",
            }}>
              <span style={{fontSize:"1.15rem",flexShrink:0,minWidth:24,textAlign:"center"}}>
                {i < 3 ? medals[i] : <span style={{color:"var(--ink4,#a79b90)",fontSize:"0.85rem",fontWeight:700}}>{i+1}</span>}
              </span>
              <span style={{fontSize:"0.95rem",flexShrink:0}}>{r.gem}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{
                    color: isMe ? r.color : "#3d3630",
                    fontWeight: isMe ? 800 : 600,
                    fontSize:"0.95rem",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                  }}>
                    {c.name}
                  </span>
                  {isMe && <span style={{color:r.color,fontSize:"0.75rem",fontWeight:700,background:r.color+"22",border:`1px solid ${r.color}44`,borderRadius:999,padding:"1px 6px",flexShrink:0}}>あなた</span>}
                </div>
                <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>{r.name}</span>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{color: isMe ? r.color : "#8a7f76",fontWeight:700,fontSize:"0.85rem"}}>{c.currentYearPurchases??0}回</div>
                <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem"}}>今年</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  STAFF LOGIN
// ══════════════════════════════════════════
function StaffLogin({ setScreen, setStaffRole, setStaffName, setStaffIsChief, staffAccounts, managerAccounts }) {
  const [selected, setSelected] = useState(null);
  const [pw, setPw]   = useState("");
  const [err, setErr] = useState("");

  const [busy, setBusy] = useState(false);

  const enter = (isMgr) => {
    setStaffRole(isMgr ? "manager" : "staff");
    setStaffIsChief(!isMgr && !!selected.isChief);
    setStaffName(selected.name);
    setScreen("pos");
  };

  const login = async () => {
    if (!selected || busy) return;
    const isMgr = selected._role === "manager";
    setBusy(true); setErr("");
    try {
      // パスワードの照合はサーバーの中で行う（ブラウザでは照合しない）
      const r = await apiLogin(isMgr ? "manager" : "staff", { name: selected.name, password: pw });
      setApiToken(r.token);   // 以降の読み書きはこの証を使ってサーバー経由になる
      enter(isMgr);
    } catch (e) {
      if (e.rejected) {
        // サーバーが「違う」と判断した場合は、そのまま伝える
        setErr("パスワードが違います");
      } else {
        // サーバーに繋がらない・不調のときは、お店が止まらないよう今までの方法で確認する
        console.warn("ログイン用サーバーに繋がらないため、従来の方法で確認します", e);
        if (pw === selected.password) enter(isMgr);
        else setErr("パスワードが違います");
      }
    }
    setBusy(false);
  };

  // ログイン画面に出すアカウント一覧は、サーバーから「名前と役割だけ」を受け取る。
  // 取れなかったときは今までどおり手元のデータを使う。
  const [serverAccounts, setServerAccounts] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/login")
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (alive && j && Array.isArray(j.accounts)) setServerAccounts(j.accounts); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // サーバーから届くまでは何も出さない。
  // 手元の初期値（見本の「山田花子」など）を一瞬でも見せると、
  // 存在しないアカウントを選んでしまうため。
  const allAccounts = serverAccounts || [];

  return (
    <div style={S.page}>
      <button className="back-btn" onClick={()=>{ if(selected){setSelected(null);setPw("");setErr("");}else setScreen("home"); }}>
        {selected ? "← 戻る" : "← ホームへ"}
      </button>
      <h2 style={S.title}>スタッフログイン</h2>

      {!selected ? (
        <div>
          <p style={S.hint}>
            {serverAccounts === null ? "読み込み中..." :
             allAccounts.length === 0 ? "アカウントを取得できませんでした。通信状況を確認して、画面を開き直してください。" :
             "アカウントを選択してください"}
          </p>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
            {allAccounts.map(acc=>(
              <button key={acc.id} className={`staff-select-btn${acc._role==="manager"?" manager":""}`}
                onClick={()=>{setSelected(acc);setPw("");setErr("");}}>
                <span style={{fontSize:"1.15rem"}}>{acc._role==="manager"?"👑":"👤"}</span>
                <span style={{fontWeight:700,color:acc._role==="manager"?"#b07c1e":"#3d3630"}}>{acc.name}</span>
                <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem",marginLeft:"auto"}}>→</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"12px 14px",marginBottom:4}}>
            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:2}}>ログイン中のアカウント</div>
            <div style={{fontWeight:700,color:selected._role==="manager"?"#b07c1e":"#3d3630",display:"flex",alignItems:"center",gap:6}}>
              <span>{selected._role==="manager"?"👑":"👤"}</span>
              <span>{selected.name}</span>
            </div>
          </div>
          <input style={S.input} type="password" placeholder="パスワード"
            value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&login()} autoFocus/>
          {err && <p style={S.err}>{err}</p>}
          <button className="btn-gold" onClick={login} disabled={busy}
            style={busy?{opacity:0.5}:undefined}>{busy ? "確認中..." : "ログイン"}</button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  POS
// ══════════════════════════════════════════
function POS({ customers, menu, orders, staffRole, staffName, staffIsChief, staffAccounts, saveStaffAccounts, managerAccounts, saveManagerAccounts, saveC, saveMenu, saveOrders, designatedDrink, saveDesignatedDrink, vipGiftDrink, saveVipGiftDrink, setScreen }) {
  const [customer,  setCustomer]  = useState(null);
  const [cart,      setCart]      = useState([]);
  const [query,     setQuery]     = useState("");
  const [flash,     setFlash]     = useState(null);
  const [showCode,       setShowCode]       = useState(false);
  const [showHistory,    setShowHistory]    = useState(false);
  const [showYearHistory,setShowYearHistory]= useState(false);
  const [posTab,         setPosTab]         = useState("order"); // "order" | "menu"
  const [pwPrompt,       setPwPrompt]       = useState(null);
  const [pwInput,   setPwInput]   = useState("");
  const [pwErr,     setPwErr]     = useState("");
  const [pwTarget,  setPwTarget]  = useState(null);
  const [pwBusy,    setPwBusy]    = useState(false);
  // 暗証番号を一時的に表示している会員（1人だけ・5秒で自動的に伏せる）
  const [pinShown,  setPinShown]  = useState(null);
  const revealPin = (id) => {
    setPinShown(id);
    setTimeout(() => setPinShown(cur => (cur === id ? null : cur)), 5000);
  };

  const isManager = staffRole === "manager";
  const canEditPin = isManager || staffIsChief;
  const [pinEdit, setPinEdit] = useState(false);
  const rank      = customer ? getEffectiveRank(customer) : null;
  const used      = customer ? isBenefitUsed(customer) : false;
  const isAlways  = rank?.benefit.type === "always_discount";
  const subtotal  = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const discount  = rank ? calcDiscount(rank, subtotal) : 0;
  // お客様側の注文画面と同じ計算にそろえる。
  // 以前はPOSだけスペシャル会員（全品無料）とスタッフ割引を見ておらず、
  // 同じ人でもPOSで会計すると満額を引かれていた。
  const posLinkedStaff = customer
    ? (staffAccounts.find(s=>s.linkedCustomerId===customer.id)
       || (managerAccounts||[]).find(s=>s.linkedCustomerId===customer.id)) || null
    : null;
  const posStaffDiscount = posLinkedStaff
    ? Math.floor(subtotal * (posLinkedStaff.discountRate ?? 10) / 100) : 0;
  const isSpecialCustomer = !!customer?.isSpecial;
  const total     = isSpecialCustomer ? 0 : Math.max(0, subtotal - discount - posStaffDiscount);

  const update = (updated) => {
    saveC(customers.map(c=>c.id===updated.id?updated:c));
    setCustomer(updated);
  };

  const addToCart = (item) => {
    setCart(prev=>{
      const ex=prev.find(c=>c.id===item.id);
      return ex ? prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c) : [...prev,{...item,qty:1}];
    });
  };
  const removeOne = (id) => {
    setCart(prev=>{
      const ex=prev.find(c=>c.id===id);
      if(!ex) return prev;
      return ex.qty===1 ? prev.filter(c=>c.id!==id) : prev.map(c=>c.id===id?{...c,qty:c.qty-1}:c);
    });
  };

  const trigFlash = (type, amount) => {
    setFlash({type,amount});
    setTimeout(()=>setFlash(null), 1000);
  };

  const doPayment = () => {
    // スペシャル会員は total が 0 になるので、0円でも会計できるようにする
    // （以前は total===0 で何も起きず、決済ボタンが無反応だった）
    if (!customer || cart.length===0) return;
    // 書き込みの土台は、選んだ瞬間の控えではなく同期済みの最新を使う。
    // そうしないと、選んでいる間に他の端末で入ったチャージや決済を消してしまう。
    const base = customers.find(c=>c.id===customer.id) || customer;
    if (total>base.balance) { alert("残高が不足しています"); return; }
    // 二重決済の防止：この会員にアプリからの未処理注文が残っていないか確認する
    const pendingOfCustomer = (orders||[]).filter(o=>o.customerId===customer.id && o.status==="pending");
    if (pendingOfCustomer.length > 0 &&
        !window.confirm(`${customer.name} さんには、アプリからの未処理の注文が${pendingOfCustomer.length}件あります。\n「📋 注文」タブで完了すると、そこでも残高が引かれます。\n\nこのままPOSで決済すると二重に引かれる可能性があります。続けますか？`)) return;
    const now = new Date().toLocaleString("ja-JP");
    const itemText = cart.map(c=>`${c.name}×${c.qty}`).join(", ");
    const updated = {
      ...base,
      balance: isSpecialCustomer ? base.balance : Math.max(0, base.balance - total),
      history: [{
        type:"use", amount:total, subtotal, discount: subtotal - total,
        items: itemText,
        performer: staffName,
        date: now
      }, ...(base.history||[])].slice(0,60),
    };
    update(updated);
    trigFlash("sub", total);
    recordSale(total, false);
    // 会員データの履歴とは別に、消えない台帳にも残す
    logSale({ date: now, customerId: base.id, customerName: base.name,
              amount: total, subtotal, discount: subtotal - total,
              items: itemText, performer: staffName, isCash: false, source: "pos" });
    setCart([]);
  };

  const doCharge = () => requireManager(()=>{
    // 入金も、選んだ瞬間の控えではなく同期済みの最新を土台にする
    const base = customers.find(c=>c.id===customer.id) || customer;
    const updated = {
      ...base,
      balance:              base.balance + 2200,
      currentYearPurchases: (base.currentYearPurchases ?? 0) + 1,
      history:   [{type:"charge",amount:2200,performer:staffName,date:new Date().toLocaleString("ja-JP")}, ...(base.history||[])].slice(0,60),
    };
    update(updated);
    logMoney({ type:"charge", customerId:base.id, customerName:base.name, amount:2200,
               balanceBefore:base.balance, balanceAfter:updated.balance, performer:staffName });
    trigFlash("add", 2200);
  });

  const undoCharge = () => requireManager(()=>{
    // 入金の取り消しも、同期済みの最新を土台にする
    const base = customers.find(c=>c.id===customer.id) || customer;
    const newBalance = Math.max(0, base.balance - 2200);
    const newPurchases = Math.max(0, (base.currentYearPurchases ?? 0) - 1);
    const updated = {
      ...base,
      balance:              newBalance,
      currentYearPurchases: newPurchases,
      history:   [{type:"charge_undo",amount:2200,performer:staffName,date:new Date().toLocaleString("ja-JP")}, ...(base.history||[])].slice(0,60),
    };
    update(updated);
    logMoney({ type:"charge_undo", customerId:base.id, customerName:base.name, amount:-2200,
               balanceBefore:base.balance, balanceAfter:newBalance, performer:staffName });
    trigFlash("sub", 2200);
  });

  const useBenefit = () => {
    if (!customer || isAlways || used) return;
    const updated = {
      ...customer,
      benefitUsedMonth: currentMonth(),
      history: [{
        type:"benefit", desc:rank.benefit.desc,
        performer: staffName,
        date:new Date().toLocaleString("ja-JP")
      }, ...(customer.history||[])].slice(0,60),
    };
    update(updated);
  };

  const requireManager = (fn) => {
    if (isManager) { fn(); return; }
    setPwTarget(()=>fn); setPwPrompt("auth"); setPwInput(""); setPwErr("");
  };
  // マネージャーのパスワード確認。
  // ※ 照合はサーバーの中で行う。画面側にはパスワードを渡していないので、
  //    ここで手元のデータと見比べる方法では、正しいパスワードでも必ず弾かれる。
  const confirmManager = async () => {
    if (pwBusy) return;
    setPwBusy(true); setPwErr("");
    try {
      const r = await apiData("verifyManagerPw", { value: { password: pwInput } });
      if (r.ok) { setPwPrompt(null); pwTarget && pwTarget(); }
      else setPwErr("マネージャーパスワードが違います");
    } catch (e) {
      // サーバーに繋がらないときだけ、お店が止まらないよう手元のデータで確認する
      if ((managerAccounts||[]).some(a=>a.password===pwInput)) { setPwPrompt(null); pwTarget&&pwTarget(); }
      else setPwErr("確認できませんでした。通信状況を確認してください");
    }
    setPwBusy(false);
  };

  const categories = [...new Set(menu.map(m=>m.category))];

  return (
    <div style={S.root}>
      {/* TOP BAR */}
      <div className="glass" style={{...S.topbar,position:"sticky",top:0,zIndex:30}}>
        {customer ? (
          <button className="back-btn" style={{margin:0,fontSize:"0.85rem",color:"var(--gold,#b07c1e)",fontWeight:700}}
            onClick={()=>{ setCustomer(null); setCart([]); }}>
            ← 客を変える
          </button>
        ) : (
          <button className="back-btn" style={{margin:0,fontSize:"0.85rem"}} onClick={()=>setScreen("home")}>← 退出</button>
        )}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {customer && (
            <button className="back-btn" style={{margin:0,fontSize:"0.75rem",color:"var(--ink3,#9a8f85)"}} onClick={()=>setScreen("home")}>退出</button>
          )}
          <span style={{fontSize:"0.75rem",color:isManager?"#b07c1e":"#3b7fb8",background:"var(--card,#ffffff)",padding:"4px 12px",borderRadius:999}}>
            {isManager?"👑":"👤"} {staffName}
          </span>
        </div>
      </div>

      {/* 読み込みに失敗したときは、黙って見本データを出さずに、はっきり知らせる。
          （何も言わずに古い／偽の一覧が出ていると、それを本物だと思って操作してしまう） */}
      {(menu.length===0 || staffAccounts.length===0) && (
        <div style={{background:"#fbebea",borderBottom:"1px solid #f0d6d4",color:"#a5453e",
          padding:"10px 16px",fontSize:"0.85rem",lineHeight:1.5}}>
          ⚠️ {menu.length===0 && staffAccounts.length===0 ? "メニューとスタッフ一覧" : menu.length===0 ? "メニュー" : "スタッフ一覧"}
          を読み込めませんでした。通信状況を確認して、画面を開き直してください。
          （この状態では保存できません）
        </div>
      )}

      {/* TAB NAV（客未選択時のみ）
          タブの帯は画面いっぱい、中のボタンは本文と同じ幅で中央に揃える。
          （帯だけ1440px、中身は中央——という不揃いを避けるため） */}
      {!customer && (
        <div style={{background:"var(--card,#ffffff)",borderBottom:"1px solid var(--line,#e7ded3)"}}>
        <div style={{display:"flex",overflowX:"auto",maxWidth:1080,margin:"0 auto"}}>
          {[["order","👥 会員"],["menu","🍽 メニュー"],["cash","💵 現金注文"],["orders","📋 注文"],["history","🗂 履歴"],
            ...(isManager?[["staffmgmt","🔐 スタッフ"]]:[])
          ].map(([k,l])=>(
            <button key={k} className={`pos-tab ${posTab===k?"pos-tab-active":""}`}
              onClick={()=>setPosTab(k)} style={{position:"relative",flexShrink:0}}>
              {l}
              {k==="orders" && orders.filter(o=>o.status==="pending").length>0 && (
                <span style={{position:"absolute",top:6,right:4,background:"#e8467f",color:"#fff",
                  borderRadius:12,padding:"2px 9px",fontSize:"0.75rem",fontWeight:700,lineHeight:1.4}}>
                  {orders.filter(o=>o.status==="pending").length}
                </span>
              )}
            </button>
          ))}
        </div>
        </div>
      )}

      {/* ── 客未選択: 検索 ── */}
      {!customer && posTab==="order" && (
        <div className="pos-page" style={{paddingTop:14}}>
          <h2 style={S.title}>お客様を検索</h2>
          {/* 打ちながら絞り込まれるので、検索ボタンは無くしてある（1操作減る） */}
          <div style={{marginBottom:12}}>
            <input style={{...S.input,marginBottom:0}} placeholder={isManager ? "名前 or 暗証番号で絞り込み" : "名前で絞り込み"}
              value={query} onChange={e=>setQuery(e.target.value)}/>
          </div>
          <div className="pos-list">
            {customers.filter(c=>{
                if (!query) return true;
                if (isManager) return c.name.includes(query)||c.pin.includes(query);
                return c.name.includes(query);
              })
              .map(c=>{
                const r=getEffectiveRank(c);
                const u=isBenefitUsed(c);
                const isAl=r.benefit.type==="always_discount";
                return (
                  <div key={c.id} className="c-row" onClick={()=>setCustomer(c)}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:r.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:"0.95rem"}}>{c.name} {c.isVIP&&<span style={{color:"#a9791a",fontSize:"0.85rem"}}>⭐</span>}{c.isSpecial&&<span style={{color:"#9c3fb5",fontSize:"0.85rem"}}>💜</span>}</div>
                      {/* 暗証番号は伏せておく。POSの画面はカウンター越しにお客様からも見えるため。
                          「暗証」の部分を押したときだけ、その1人分を5秒だけ表示する。 */}
                      <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>
                        {isManager && (
                          <span onClick={(e)=>{ e.stopPropagation(); revealPin(c.id); }}
                            style={{cursor:"pointer",borderBottom:"1px dotted #c3bab0",paddingBottom:1}}>
                            暗証: {pinShown===c.id ? c.pin : "•".repeat(String(c.pin||"").length||4)}
                          </span>
                        )}
                        {isManager && " · "}{r.gem}{r.name}
                      </div>
                    </div>
                    <div style={{textAlign:"right",display:"flex",flexDirection:"column",gap:2,alignItems:"flex-end"}}>
                      <div style={{color:r.color,fontWeight:700}}>¥{c.balance.toLocaleString()}</div>
                      {isAl
                        ? <div style={S.tagAuto}>{r.benefit.icon} 自動割引</div>
                        : u
                          ? <div style={S.tagUsed}>特典使用済み</div>
                          : <div style={S.tagAvail}>特典あり</div>
                      }
                    </div>
                  </div>
                );
              })}
          </div>
          {isManager && (
            <button className="btn-ghost" style={{marginTop:14}} onClick={()=>setPwPrompt("addCustomer")}>
              ＋ 新規会員登録
            </button>
          )}
        </div>
      )}

      {/* ── メニュー管理 ── */}
      {!customer && posTab==="menu" && (
        <MenuManager menu={menu} saveMenu={saveMenu} designatedDrink={designatedDrink} saveDesignatedDrink={saveDesignatedDrink}/>
      )}
      
      {/* ── 現金注文 ── */}
      {!customer && posTab==="cash" && (
        <CashOrderPanel menu={menu} staffName={staffName} orders={orders} saveOrders={saveOrders}/>
      )}

      {/* ── 注文管理 ── */}
      {!customer && posTab==="orders" && (
        <OrdersPanel orders={orders} customers={customers} saveOrders={saveOrders} saveC={saveC} staffName={staffName}/>
      )}

      {/* ── スタッフ管理（マネージャーのみ） ── */}
      {!customer && posTab==="staffmgmt" && isManager && (
        <StaffMgmtPanel staffAccounts={staffAccounts} saveStaffAccounts={saveStaffAccounts} managerAccounts={managerAccounts} saveManagerAccounts={saveManagerAccounts} customers={customers} vipGiftDrink={vipGiftDrink} saveVipGiftDrink={saveVipGiftDrink} menu={menu}/>
      )}

      {/* ── 会計履歴 ── */}
      {!customer && posTab==="history" && (
        <SalesHistoryPanel customers={customers} orders={orders}/>
      )}
      {customer && (
        <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 44px)",overflow:"hidden",
          width:"100%",maxWidth:1080,margin:"0 auto"}}>

          {/* 客ストリップ */}
          <div style={{...S.customerStrip, borderColor:rank.color+"44"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{color:rank.color,fontSize:"0.85rem",fontWeight:700}}>{rank.gem} {rank.name}</span>
                  <span style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"1rem"}}>{customer.name}</span>
                </div>
                {/* 特典ステータス */}
                <div style={{...S.benefitStripBox, borderColor:rank.color+"44"}}>
                  <span style={{color:rank.color,fontSize:"0.85rem"}}>{rank.benefit.icon} {rank.benefit.desc}</span>
                  {isAlways
                    ? <div style={S.tagAuto}>毎回自動</div>
                    : used
                      ? <div style={S.tagUsed}>使用済み</div>
                      : <button className="tag-use-btn" style={{borderColor:rank.color,color:rank.color}} onClick={useBenefit}>
                          ✓ 使用する
                        </button>
                  }
                </div>
              </div>
              <div style={{textAlign:"right",flexShrink:0,marginLeft:10}}>
                <div style={{position:"relative",display:"inline-block"}}>
                  <span style={{color:rank.color,fontWeight:800,fontSize:"1.15rem"}}>¥{customer.balance.toLocaleString()}</span>
                  {flash&&<div className={`flash flash-${flash.type}`}>{flash.type==="add"?"+":"-"}¥{flash.amount.toLocaleString()}</div>}
                </div>
                <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
                  <button className="pill-btn-hist" onClick={()=>setShowHistory(true)}>📋</button>
                  <button className="pill-btn-year" onClick={()=>setShowYearHistory(true)}>📅</button>
                  {isManager && <button className="pill-btn-code" onClick={()=>setShowCode(true)}>🔑</button>}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:6,marginTop:8}}>
              {isManager && <button className="pill-btn-gold" onClick={doCharge}>🎫 +¥2,200</button>}
              {isManager && <button className="pill-btn-dim" onClick={()=>{ if(window.confirm("直前のチャージ1回分を取り消します。\n残高 -¥2,200・購入回数 -1 でよろしいですか？")) undoCharge(); }}>↩️ チャージ取消</button>}
              {isManager && <button className="pill-btn-dim" onClick={()=>setPwPrompt("editCustomer")}>✏️ 編集</button>}
              {!isManager && staffIsChief && <button className="pill-btn-dim" onClick={()=>setPinEdit(true)}>🔑 暗証番号を変更</button>}
            </div>
          </div>

          {/* メニューグリッド。広い画面では列が増えるので、スクロールがぐっと減る */}
          <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
            {categories.map(cat=>(
              <div key={cat} style={{marginBottom:14}}>
                <div style={S.catLabel}>{cat}</div>
                <div className="menu-grid-auto">
                  {menu.filter(m=>m.category===cat).map(item=>{
                    const inCart=cart.find(c=>c.id===item.id);
                    return (
                      <button key={item.id} className={`menu-item ${inCart?"menu-item-active":""}`} onClick={()=>addToCart(item)}>
                        <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                        <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink,#3d3630)",lineHeight:1.25,marginTop:3,textAlign:"center"}}>{item.name}</span>
                        <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                        {inCart&&<div style={S.cartBadge}>{inCart.qty}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* カート */}
          <div style={S.cartPanel}>
            {cart.length===0 ? (
              <div style={{color:"var(--ink4,#a79b90)",textAlign:"center",fontSize:"0.85rem",padding:"8px 0"}}>商品を選んでください</div>
            ) : (
              <>
                <div style={{maxHeight:100,overflowY:"auto",marginBottom:6}}>
                  {cart.map(item=>(
                    <div key={item.id} style={S.cartRow}>
                      <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <button className="qty-btn" onClick={()=>removeOne(item.id)}>－</button>
                        <span style={{color:"var(--ink,#3d3630)",minWidth:18,textAlign:"center",fontWeight:700}}>{item.qty}</span>
                        <button className="qty-btn" onClick={()=>addToCart(item)}>＋</button>
                        <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem",minWidth:56,textAlign:"right"}}>
                          ¥{(item.price*item.qty).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 割引・合計 */}
                <div style={{paddingTop:8,borderTop:"1px solid var(--line,#e7ded3)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                    <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>小計</span>
                    <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>¥{subtotal.toLocaleString()}</span>
                  </div>
                  {!isSpecialCustomer && discount>0 && (
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{color:rank.color,fontSize:"0.85rem"}}>{rank.benefit.icon} {rank.benefit.desc}</span>
                      <span style={{color:rank.color,fontWeight:700,fontSize:"0.85rem"}}>－¥{discount.toLocaleString()}</span>
                    </div>
                  )}
                  {!isSpecialCustomer && posStaffDiscount>0 && (
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{color:"#3e9a5c",fontSize:"0.85rem"}}>🟢 スタッフ割引 {posLinkedStaff.discountRate ?? 10}%</span>
                      <span style={{color:"#3e9a5c",fontWeight:700,fontSize:"0.85rem"}}>－¥{posStaffDiscount.toLocaleString()}</span>
                    </div>
                  )}
                  {isSpecialCustomer && (
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{color:"#9c3fb5",fontSize:"0.85rem"}}>💜 スペシャル（全品無料）</span>
                      <span style={{color:"#9c3fb5",fontWeight:700,fontSize:"0.85rem"}}>－¥{subtotal.toLocaleString()}</span>
                    </div>
                  )}
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                    <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>合計</span>
                    <span style={{color:"var(--ink,#3d3630)",fontWeight:800,fontSize:"1.4rem"}}>¥{total.toLocaleString()}</span>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn-clear" onClick={()=>setCart([])}>クリア</button>
                    <button className="btn-pay" onClick={doPayment}
                      disabled={total>customer.balance}
                      style={{opacity:total<=customer.balance?1:0.35}}>
                      {total<=customer.balance ? `¥${total.toLocaleString()} を決済` : "残高不足"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── モーダル群 ── */}
      {showCode        && customer && <CodeModal customer={customer} rank={rank} onClose={()=>setShowCode(false)}/>}
      {showHistory     && customer && <HistoryModal customer={customer} rank={rank} onClose={()=>setShowHistory(false)}/>}
      {showYearHistory && customer && <YearHistoryModal customer={customer} rank={rank} onClose={()=>setShowYearHistory(false)}/>}

      {pwPrompt==="auth" && (
        <ManagerPwModal onConfirm={confirmManager} onClose={()=>setPwPrompt(null)}
          pwInput={pwInput} setPwInput={setPwInput} err={pwErr}/>
      )}
      {pwPrompt==="editCustomer" && isManager && customer && (
        <EditCustomerModal customer={customer} customers={customers}
          onSave={updated=>{update(updated);setPwPrompt(null);}}
          onDelete={()=>{if(window.confirm(`${customer.name} を削除しますか？`)){saveC(customers.filter(c=>c.id!==customer.id));setCustomer(null);setPwPrompt(null);}}}
          onClose={()=>setPwPrompt(null)}/>
      )}
      {pinEdit && canEditPin && customer && (
        <PinChangeModal customer={customer} customers={customers}
          onSave={newPin=>{ update({...customer, pin:newPin}); setPinEdit(false); }}
          onClose={()=>setPinEdit(false)}/>
      )}
      {pwPrompt==="addCustomer" && (
        <AddCustomerModal
          customers={customers}
          onSave={c=>{saveC([...customers,c]);setPwPrompt(null);}}
          onClose={()=>setPwPrompt(null)}
          nextId={String(customers.length ? Math.max(...customers.map(c=>parseInt(c.id)||0))+1 : 1001)}/>
      )}
    </div>
  );

}

// ── BACKUP PANEL ─────────────────────────
function BackupPanel({ customers }) {
  const [showJson,   setShowJson]   = useState(false);
  const [jsonText,   setJsonText]   = useState("");
  const [copied,     setCopied]     = useState(false);
  const [restoreMode,setRestoreMode]= useState(false);
  const [restoreText,setRestoreText]= useState("");
  const [restoreMsg, setRestoreMsg] = useState("");

  const generateBackup = () => {
    const now    = new Date();
    const backup = {
      version:    "1.0",
      exportedAt: now.toLocaleString("ja-JP"),
      customers:  customers.map(c => ({
        id:                   c.id,
        name:                 c.name,
        pin:                  c.pin,
        balance:              c.balance,
        currentYearPurchases: c.currentYearPurchases ?? 0,
        rankBasis:            c.rankBasis ?? 0,
        dataYear:             c.dataYear,
        isVIP:                c.isVIP || false,
        isSpecial:            c.isSpecial || false,
        joined:               c.joined,
        benefitUsedMonth:     c.benefitUsedMonth || null,
        toppingRemaining:     c.toppingRemaining ?? null,
        toppingRemainingMonth:c.toppingRemainingMonth || null,
        vipGiftUsedMonth:     c.vipGiftUsedMonth || null,
        yearlyStats:          c.yearlyStats || [],
        history:              c.history || [],
      })),
      summary: {
        totalMembers: customers.length,
        vipCount:     customers.filter(c=>c.isVIP).length,
        specialCount: customers.filter(c=>c.isSpecial).length,
        totalBalance: customers.reduce((s,c)=>s+(c.balance||0),0),
      }
    };
    return JSON.stringify(backup, null, 2);
  };

  const openBackup = () => {
    setJsonText(generateBackup());
    setShowJson(true);
    setCopied(false);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(jsonText).then(()=>{
      setCopied(true);
      setTimeout(()=>setCopied(false), 2500);
    }).catch(()=>{
      // fallback: select the textarea
      const el = document.getElementById("backup-textarea");
      if (el) { el.select(); document.execCommand("copy"); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    });
  };

  const doRestore = () => {
    setRestoreMsg("");
    try {
      const data = JSON.parse(restoreText);
      if (!data.customers || !Array.isArray(data.customers)) {
        setRestoreMsg("❌ 形式が正しくありません"); return;
      }
      if (!window.confirm(`${data.customers.length}件の会員データを復元しますか？\n現在のデータは上書きされます。`)) return;
      dbSet("cafe_v4_customers", data.customers);
        Promise.resolve().then(()=>setRestoreMsg(`✅ ${data.customers.length}件を復元しました。ページを再読み込みしてください。`))
        .catch(()=>setRestoreMsg("❌ 復元に失敗しました"));
    } catch { setRestoreMsg("❌ JSON の解析に失敗しました"); }
  };

  return (
    <div style={{background:"#e9f1fa",border:"1px solid #7bafdb44",borderRadius:12,padding:"14px",marginBottom:14}}>
      <div style={{color:"#3b7fb8",fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:10}}>
        💾 バックアップ & リストア
      </div>

      {/* バックアップ */}
      <div style={{marginBottom:12}}>
        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginBottom:8}}>
          全会員データをテキストとして表示→コピーして保存できます
        </div>
        <button onClick={openBackup}
          style={{width:"100%",background:"linear-gradient(135deg,#dceaf5,#cfe0f0)",
            border:"1px solid #7bafdb55",borderRadius:12,padding:"13px",
            color:"#3b7fb8",fontWeight:700,fontSize:"0.95rem",cursor:"pointer",
            fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span>📋</span> バックアップデータを表示
        </button>
        <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",marginTop:6,textAlign:"center"}}>
          表示されたテキストをコピーしてメモ帳やメールに保存してください
        </div>
      </div>

      {/* リストア */}
      <div style={{borderTop:"1px solid #dbe4ec",paddingTop:12}}>
        <button onClick={()=>setRestoreMode(p=>!p)}
          style={{background:"transparent",border:"1px solid #dbe4ec",borderRadius:8,padding:"8px 14px",
            color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",cursor:"pointer",fontFamily:"inherit",width:"100%"}}>
          {restoreMode?"▲ リストアを閉じる":"▼ バックアップから復元する"}
        </button>
        {restoreMode && (
          <div style={{marginTop:10}}>
            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginBottom:6}}>
              保存済みのJSONテキストを貼り付けてください
            </div>
            <textarea
              style={{...S.input,height:100,resize:"vertical",fontSize:"0.75rem",fontFamily:"monospace"}}
              placeholder='{"version":"1.0","customers":[...]}'
              value={restoreText}
              onChange={e=>setRestoreText(e.target.value)}/>
            {restoreMsg && (
              <div style={{color:restoreMsg.startsWith("✅")?"#3e9a5c":"#c94a45",
                fontSize:"0.85rem",fontWeight:600,margin:"6px 0"}}>
                {restoreMsg}
              </div>
            )}
            <button onClick={doRestore} className="btn-save" style={{marginTop:8}}>
              復元する
            </button>
          </div>
        )}
      </div>

      {/* JSON表示モーダル */}
      {showJson && (
        <div style={S.overlay}>
          <div style={{...S.modal,maxHeight:"88vh"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div>
                <h3 style={{color:"#3b7fb8",margin:0,fontSize:"1rem"}}>📋 バックアップデータ</h3>
                <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:2}}>
                  全文をコピーしてメモ帳・メール等に保存
                </div>
              </div>
              <button className="close-btn" onClick={()=>setShowJson(false)}>✕</button>
            </div>

            <textarea
              id="backup-textarea"
              readOnly
              value={jsonText}
              style={{...S.input,height:260,resize:"none",fontSize:"0.75rem",
                fontFamily:"monospace",lineHeight:1.4,overflowY:"auto"}}/>

            <button onClick={copyToClipboard}
              style={{width:"100%",marginTop:10,background:copied?"#dcefe1":"linear-gradient(135deg,#dceaf5,#cfe0f0)",
                border:`1px solid ${copied?"#7cc39455":"#7bafdb55"}`,borderRadius:12,padding:"13px",
                color:copied?"#3e9a5c":"#3b7fb8",fontWeight:700,fontSize:"0.95rem",
                cursor:"pointer",fontFamily:"inherit",transition:"all 0.3s"}}>
              {copied ? "✅ コピーしました！" : "📋 全てコピーする"}
            </button>
            <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",marginTop:8,textAlign:"center"}}>
              コピー後、メモ帳・メール・Googleドキュメント等に貼り付けて保存してください
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── STAFF MGMT PANEL ─────────────────────
function StaffMgmtPanel({ staffAccounts, saveStaffAccounts, managerAccounts, saveManagerAccounts, customers, vipGiftDrink, saveVipGiftDrink, menu }) {
  const [editingStaff,  setEditingStaff]  = useState(null);
  const [editingMgr,    setEditingMgr]    = useState(null);
  const [form,          setForm]          = useState({});
  const [linkTarget,    setLinkTarget]    = useState(null);
  const [linkTargetMgr, setLinkTargetMgr] = useState(null);
  const [pickVip,       setPickVip]       = useState(false); // VIPドリンクの選択肢を開いているか
  const upd = (f,v) => setForm(p=>({...p,[f]:v}));

  const openNewStaff  = () => { setForm({id:`st_${Date.now()}`,name:"",password:"",linkedCustomerId:null}); setEditingStaff("new"); };
  const openEditStaff = (acc) => { setForm({...acc}); setEditingStaff(acc.id); };
  const saveStaff = () => {
    if (!form.name.trim()||!form.password.trim()) return;
    if (editingStaff==="new") saveStaffAccounts([...staffAccounts, form]);
    else saveStaffAccounts(staffAccounts.map(a=>a.id===editingStaff?form:a));
    setEditingStaff(null);
  };
  const delStaff = (id) => { if(window.confirm("削除しますか？")) saveStaffAccounts(staffAccounts.filter(a=>a.id!==id)); };
  const toggleChief = (id) => saveStaffAccounts(staffAccounts.map(a=>({...a, isChief: a.id===id ? !a.isChief : false})));

  const openNewMgr  = () => { setForm({id:`mg_${Date.now()}`,name:"",password:"",linkedCustomerId:null}); setEditingMgr("new"); };
  const openEditMgr = (acc) => { setForm({...acc}); setEditingMgr(acc.id); };
  const saveMgr = () => {
    if (!form.name.trim()||!form.password.trim()) return;
    if (editingMgr==="new") saveManagerAccounts([...managerAccounts, form]);
    else saveManagerAccounts(managerAccounts.map(a=>a.id===editingMgr?form:a));
    setEditingMgr(null);
  };
  const delMgr = (id) => {
    if (managerAccounts.length<=1) { alert("マネージャーは最低1人必要です"); return; }
    if(window.confirm("削除しますか？")) saveManagerAccounts(managerAccounts.filter(a=>a.id!==id));
  };

  const linkStaff  = (sid, cid) => { saveStaffAccounts(staffAccounts.map(a=>a.id===sid?{...a,linkedCustomerId:cid}:a)); setLinkTarget(null); };
  const unlinkStaff= (sid) => saveStaffAccounts(staffAccounts.map(a=>a.id===sid?{...a,linkedCustomerId:null}:a));
  const linkMgr    = (mid, cid) => { saveManagerAccounts(managerAccounts.map(a=>a.id===mid?{...a,linkedCustomerId:cid}:a)); setLinkTargetMgr(null); };
  const unlinkMgr  = (mid) => saveManagerAccounts(managerAccounts.map(a=>a.id===mid?{...a,linkedCustomerId:null}:a));

  const AccCard = ({acc, isManager, onEdit, onDel, ltId, setLtId, onLink, onUnlink}) => {
    const linked = acc.linkedCustomerId ? customers.find(c=>c.id===acc.linkedCustomerId) : null;
    return (
      <div style={{background:"var(--card,#ffffff)",border:`1px solid ${isManager?"#d3a94f33":"#e7ded3"}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <span style={{fontSize:"1.15rem"}}>{isManager?"👑":"👤"}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:"0.95rem",color:isManager?"#b07c1e":"#3d3630"}}>{acc.name}</div>
            {/* パスワードはサーバーの中だけで扱うようになったので、画面には届いていない。
                空の「PW:」を出しても混乱させるだけなので、状態だけを示す。 */}
            <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",marginTop:2}}>
              {acc.password ? `PW: ${acc.password}` : "パスワード設定済み（✏️ から変更できます）"}
            </div>
          </div>
          <button className="btn-tiny-edit" onClick={()=>onEdit(acc)}>✏️</button>
          <button className="btn-tiny-del"  onClick={()=>onDel(acc.id)}>🗑</button>
        </div>
        <div style={{borderTop:"1px solid var(--line,#e7ded3)",paddingTop:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>🔗 客アカウントリンク</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>割引率:</span>
              <input
                type="number" min="0" max="100"
                value={acc.discountRate ?? 10}
                onChange={e=>{
                  const rate = Math.min(100, Math.max(0, parseInt(e.target.value)||0));
                  if (isManager) saveManagerAccounts(managerAccounts.map(a=>a.id===acc.id?{...a,discountRate:rate}:a));
                  else saveStaffAccounts(staffAccounts.map(a=>a.id===acc.id?{...a,discountRate:rate}:a));
                }}
                style={{width:52,background:"var(--panel2,#f6f1ea)",border:"1px solid var(--line,#e7ded3)",borderRadius:8,padding:"3px 6px",color:"#3e9a5c",fontSize:"0.85rem",fontWeight:700,fontFamily:"inherit",textAlign:"center"}}
              />
              <span style={{color:"#3e9a5c",fontSize:"0.75rem"}}>%</span>
            </div>
          </div>
          {linked ? (
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{color:"#2f9b85",fontSize:"0.85rem",fontWeight:600}}>{linked.name}</span>
              <div style={{display:"flex",gap:6}}>
                <button style={{background:"transparent",border:"1px solid var(--line,#e7ded3)",borderRadius:999,padding:"3px 10px",color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>setLtId(ltId===acc.id?null:acc.id)}>変更</button>
                <button style={{background:"transparent",border:"1px solid #f0d6d4",borderRadius:999,padding:"3px 10px",color:"#c94a45",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>onUnlink(acc.id)}>解除</button>
              </div>
            </div>
          ) : (
            <button style={{background:"#e9f1fa",border:"1px solid #7fcdbd33",borderRadius:999,padding:"4px 12px",color:"#2f9b85",fontSize:"0.85rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>setLtId(ltId===acc.id?null:acc.id)}>
              {ltId===acc.id?"閉じる ↑":"客アカウントを紐付ける"}
            </button>
          )}
          {ltId===acc.id && (
            <div style={{marginTop:8,maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {customers.map(c=>(
                <button key={c.id} style={{background:acc.linkedCustomerId===c.id?"#e9f5ec":"#ffffff",border:`1px solid ${acc.linkedCustomerId===c.id?"#7fcdbd55":"#e7ded3"}`,borderRadius:8,padding:"8px 12px",cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between"}}
                  onClick={()=>onLink(acc.id, c.id)}>
                  <span style={{color:"var(--ink,#3d3630)",fontSize:"0.85rem"}}>{c.name}</span>
                  <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>No.{c.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="pos-page" style={{paddingTop:14, paddingBottom:40}}>
      {/* ※ バックアップ欄はこのタブの一番下に移した。
             年に数回しか使わないものが最上段にあると、毎回それを飛ばしてから
             本題（スタッフ一覧）に入ることになるため。 */}

      {/* マネージャーアカウント */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <h2 style={{...S.title,margin:0,color:"var(--gold,#b07c1e)"}}>👑 マネージャー</h2>
        <button className="btn-sm-gold" onClick={openNewMgr}>＋ 追加</button>
      </div>
      {(managerAccounts||[]).map(acc=>(
        <AccCard key={acc.id} acc={acc} isManager={true} onEdit={openEditMgr} onDel={delMgr}
          ltId={linkTargetMgr} setLtId={setLinkTargetMgr} onLink={linkMgr} onUnlink={unlinkMgr}/>
      ))}

      {/* VIPプレゼントドリンク設定。選択肢は普段は畳んでおく（月に一度しか変えないため） */}
      <div style={{background:"linear-gradient(135deg,#faf0dc,#f7e7c4)",border:"1px solid #e8c14a44",borderRadius:12,padding:"14px",marginBottom:14,marginTop:10}}>
        <div style={{color:"#a9791a",fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:6}}>⭐ VIPプレゼント — 今月のドリンク</div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <span style={{color:vipGiftDrink?"#3d3630":"#9a8f85",fontWeight:vipGiftDrink?700:400,fontSize:vipGiftDrink?"1rem":"0.85rem"}}>
            {vipGiftDrink ? `${vipGiftDrink.emoji} ${vipGiftDrink.name}` : "未設定"}
          </span>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            {vipGiftDrink && (
              <button style={{background:"transparent",border:"1px solid #ddd3c6",borderRadius:999,padding:"4px 10px",color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>saveVipGiftDrink(null)}>解除</button>
            )}
            <button style={{background:"var(--card,#ffffff)",border:"1px solid #e8c14a",borderRadius:999,padding:"4px 12px",color:"#a9791a",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
              onClick={()=>setPickVip(v=>!v)}>{pickVip?"閉じる":"変更"}</button>
          </div>
        </div>
        {pickVip && (
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10}}>
            {menu.map(item=>(
              <button key={item.id}
                style={{background:vipGiftDrink?.id===item.id?"#f7e7c4":"#ffffff",border:`1px solid ${vipGiftDrink?.id===item.id?"#e8c14a":"#e7ded3"}`,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",color:vipGiftDrink?.id===item.id?"#a9791a":"#8a7f76",fontSize:"0.85rem",fontWeight:vipGiftDrink?.id===item.id?700:400,transition:"all 0.15s"}}
                onClick={()=>{ saveVipGiftDrink(item); setPickVip(false); }}>
                {item.emoji} {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* スタッフアカウント */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <h2 style={{...S.title,margin:0}}>👤 スタッフ</h2>
        <button className="btn-sm-gold" onClick={openNewStaff}>＋ 追加</button>
      </div>
      {staffAccounts.map(acc=>(
        <AccCard key={acc.id} acc={acc} isManager={false} onEdit={openEditStaff} onDel={delStaff}
          ltId={linkTarget} setLtId={setLinkTarget} onLink={linkStaff} onUnlink={unlinkStaff}/>
      ))}
      {/* 店長の指名（店長はお客さんのPINを変更できる） */}
      <div style={{background:"var(--card,#ffffff)",border:"1px solid #d3a94f33",borderRadius:12,padding:"12px 14px",marginTop:4,marginBottom:8}}>
        <div style={{fontWeight:700,color:"var(--gold,#b07c1e)",fontSize:"0.95rem",marginBottom:4}}>⭐ 店長の指名</div>
        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:10}}>店長に選ばれたスタッフは、お客さんの暗証番号（PIN）を変更できます。店長は1人までです。</div>
        {staffAccounts.length===0
          ? <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>スタッフがいません</div>
          : staffAccounts.map(a=>(
            <button key={a.id} onClick={()=>toggleChief(a.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",boxSizing:"border-box",background:a.isChief?"#f7e7c4":"#ffffff",border:`1px solid ${a.isChief?"#d3a94f":"#e7ded3"}`,borderRadius:12,padding:"10px 12px",marginBottom:6,cursor:"pointer"}}>
              <span style={{color:a.isChief?"#b07c1e":"#3d3630",fontWeight:a.isChief?700:500,fontSize:"0.95rem"}}>{a.isChief?"⭐ ":""}{a.name}</span>
              <span style={{color:a.isChief?"#b07c1e":"#8a7f76",fontSize:"0.85rem"}}>{a.isChief?"店長":"店長にする"}</span>
            </button>
          ))
        }
      </div>
      {staffAccounts.length===0&&<div style={{textAlign:"center",color:"var(--ink2,#8a7f76)",padding:"20px",background:"var(--card,#ffffff)",borderRadius:12}}>スタッフアカウントがありません</div>}

      {/* バックアップ欄はここ（一番下）。普段使うものではないため。 */}
      <div style={{marginTop:24}}>
        <BackupPanel customers={customers}/>
      </div>

      {/* マネージャー編集モーダル */}
      {editingMgr && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"var(--gold,#b07c1e)",margin:0}}>{editingMgr==="new"?"マネージャー追加":"マネージャー編集"}</h3>
              <button className="close-btn" onClick={()=>setEditingMgr(null)}>✕</button>
            </div>
            <div style={{marginBottom:12}}><label style={S.label}>名前 *</label><input style={S.input} placeholder="例: 田中 店長" value={form.name||""} onChange={e=>upd("name",e.target.value)}/></div>
            <div style={{marginBottom:16}}><label style={S.label}>パスワード *</label><input style={S.input} type="text" value={form.password||""} onChange={e=>upd("password",e.target.value)}/></div>
            <button className="btn-save" style={{opacity:(form.name?.trim()&&form.password?.trim())?1:0.4}} onClick={saveMgr}>{editingMgr==="new"?"追加する":"保存する"}</button>
          </div>
        </div>
      )}

      {/* スタッフ編集モーダル */}
      {editingStaff && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"var(--gold,#b07c1e)",margin:0}}>{editingStaff==="new"?"スタッフ追加":"スタッフ編集"}</h3>
              <button className="close-btn" onClick={()=>setEditingStaff(null)}>✕</button>
            </div>
            <div style={{marginBottom:12}}><label style={S.label}>名前 *</label><input style={S.input} placeholder="例: 山田 花子" value={form.name||""} onChange={e=>upd("name",e.target.value)}/></div>
            <div style={{marginBottom:16}}><label style={S.label}>パスワード *</label><input style={S.input} type="text" value={form.password||""} onChange={e=>upd("password",e.target.value)}/></div>
            <button className="btn-save" style={{opacity:(form.name?.trim()&&form.password?.trim())?1:0.4}} onClick={saveStaff}>{editingStaff==="new"?"追加する":"保存する"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SalesHistoryPanel({ customers, orders }) {
  // 会計履歴の画面を開いたときだけ、アーカイブ済みの過去注文を読み込む。
  // 普段の同期では読みに行かないので、通信量は増えない。
  // アーカイブがまだ無い場合も、何も表示が変わらないだけで問題なく動く。
  const [archive, setArchive] = useState(null);
  // 消えない売上台帳（2026-08-17 から記録開始）。
  // 会員データの履歴は1人60件で古いものから消えるため、
  // 消えた分をこちらで補う。まだ台帳が空でも、表示は今までどおり。
  const [salesLog, setSalesLog] = useState([]);
  useEffect(() => {
    let alive = true;
    dbGet("cafe_v4_orders_archive").then(a => {
      if (alive) setArchive(Array.isArray(a) ? a.filter(Boolean) : []);
    });
    dbGet("cafe_v4_sales_log", SALES_LOG_QUERY).then(v => {
      if (!alive) return;
      // Firebase は追記した記録を「鍵つきの入れ物」で返すので、中身だけ取り出す
      const list = v && typeof v === "object" ? Object.values(v).filter(Boolean) : [];
      setSalesLog(list);
    });
    return () => { alive = false; };
  }, []);

  // 今の注文とアーカイブを合わせる。移し替えの途中で両方に同じ注文があっても、
  // orderId で重複を取り除くので二重に数えることはない。
  const seenOrderIds = new Set();
  const mergedOrders = [];
  [...(orders || []), ...(archive || [])].forEach(o => {
    if (!o || !o.orderId || seenOrderIds.has(o.orderId)) return;
    seenOrderIds.add(o.orderId);
    mergedOrders.push(o);
  });

  // 全会員のhistoryからtype:"use"を集めて日付でグループ化
  const allEntries = [];
  customers.forEach(c => {
    (c.history || []).forEach(h => {
      if (h.type === "use") {
        allEntries.push({ ...h, customerName: c.name });
      }
    });
  });
  // 完了した現金注文も会計履歴に含める
  mergedOrders.forEach(o => {
    if (o.isCash && o.status === "completed") {
      allEntries.push({
        type: "use",
        amount: o.total || 0,
        subtotal: o.subtotal || 0,
        discount: 0,
        items: (o.items || []).map(i=>`${i.name}×${i.qty}`).join(", "),
        performer: o.completedBy || "スタッフ",
        date: o.completedAt || o.createdAt,
        customerName: o.customerName || "現金のお客様",
        isCash: true,
      });
    }
  });

  // 会員の注文のうち、会員データ側の履歴に対応する記録が無いものを補う。
  // 過去のデータ消失で会員の履歴だけが失われた分が、注文データには残っているため、
  // それを会計履歴に復活させる。
  // 注文を完了したとき、履歴の date と注文の completedAt にはまったく同じ文字列を書いている。
  // そこで「会員名＋日時」が一致する履歴があるものは重複とみなして足さない。
  // （実データで確認済み：同じ会員・同じ日時の記録が2つ以上ある例は履歴側・注文側とも0件）
  const historyKeys = new Set();
  customers.forEach(c => {
    (c.history || []).forEach(h => {
      if (h.type === "use") historyKeys.add(`${c.name}\u0000${h.date}`);
    });
  });
  mergedOrders.forEach(o => {
    if (!o || o.isCash || o.status !== "completed") return;
    if (historyKeys.has(`${o.customerName}\u0000${o.completedAt}`)) return;
    allEntries.push({
      type: "use",
      amount: o.total || 0,
      subtotal: o.subtotal || 0,
      discount: o.discount || 0,
      items: [
        ...(o.items || []).map(i=>`${i.name}×${i.qty}`),
        ...(o.benefitItems || []).map(i=>`${i.name}(特典)`),
        ...(o.makaiItem ? [`${o.makaiItem.name}(賄い)`] : []),
      ].join(", "),
      performer: o.completedBy || "スタッフ",
      date: o.completedAt || o.createdAt,
      customerName: o.customerName,
      fromOrder: true,
    });
  });

  // 消えない売上台帳の分を足す。
  // 会員データの履歴が60件を超えて古いものが捨てられても、ここには残っている。
  // すでに上で数えた会計は足さないので、二重にはならない。
  // 同じ会計かどうかは「お客様の名前＋日時（秒まで）」で見分ける。
  // 台帳に書くときも会計履歴に出すときも、同じ名前・同じ日時の文字列を使っている。
  const countedKeys = new Set(allEntries.map(e => `${e.customerName} ${e.date}`));
  salesLog.forEach(s => {
    if (!s || !s.date) return;
    const k = `${s.customerName} ${s.date}`;
    if (countedKeys.has(k)) return;
    countedKeys.add(k);
    allEntries.push({
      type: "use",
      amount: s.amount || 0,
      subtotal: s.subtotal || 0,
      discount: s.discount || 0,
      items: s.items || "",
      performer: s.performer || "スタッフ",
      date: s.date,
      customerName: s.customerName || "—",
      isCash: !!s.isCash,
      fromLedger: true,
    });
  });

  // 日付文字列のパース（"2026/5/6 12:34:56" → "2026/5/6"）
  const getDay = (dateStr) => dateStr ? dateStr.split(" ")[0] : "不明";

  // 日付でソート（新しい順）してグループ化
  // 日時は "2026/8/9 9:05:03" のようにゼロ埋めされていないので、文字列のまま比べると
  // "2026/8/9" が "2026/8/11" より新しい扱いになってしまう。必ず数値に直してから比べる。
  const toTime = (s) => {
    if (!s) return 0;
    const m = String(s).match(/(\d+)\/(\d+)\/(\d+)\D+(\d+):(\d+):?(\d*)/);
    return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0)).getTime() : 0;
  };
  allEntries.sort((a, b) => toTime(b.date) - toTime(a.date));

  const groups = {};
  allEntries.forEach(h => {
    const day = getDay(h.date);
    if (!groups[day]) groups[day] = [];
    groups[day].push(h);
  });

  const days = Object.keys(groups); // 既にソート済み

  return (
    <div className="pos-page" style={{paddingTop:14, paddingBottom:40}}>
      <h2 style={{...S.title, margin:"0 0 14px"}}>会計履歴</h2>

      {days.length === 0 ? (
        <div style={{textAlign:"center",color:"var(--ink4,#a79b90)",padding:"40px 0",fontSize:"0.85rem",
          background:"var(--card,#ffffff)",borderRadius:12}}>
          まだ会計履歴がありません
        </div>
      ) : days.map(day => {
        const entries = groups[day];
        const dayTotal = entries.reduce((s, h) => s + (h.amount || 0), 0);
        const dayCount = entries.length;

        return (
          <div key={day} style={{marginBottom:20}}>
            {/* 日付ヘッダー */}
            <div style={{
              display:"flex", justifyContent:"space-between", alignItems:"center",
              background:"var(--card,#ffffff)", border:"1px solid var(--line,#e7ded3)", borderRadius:12,
              padding:"10px 14px", marginBottom:8,
              position:"sticky", top:0, zIndex:2,
            }}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{color:"var(--gold,#b07c1e)",fontSize:"0.95rem"}}>📅</span>
                <span style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"0.95rem"}}>{day}</span>
                <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>({dayCount}件)</span>
              </div>
              <div style={{textAlign:"right"}}>
                <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginRight:4}}>合計</span>
                <span style={{color:"var(--gold,#b07c1e)",fontWeight:800,fontSize:"1.15rem"}}>¥{dayTotal.toLocaleString()}</span>
              </div>
            </div>

            {/* その日の会計一覧 */}
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {entries.map((h, i) => {
                const time = h.date ? h.date.split(" ")[1] : "";
                return (
                  <div key={i} style={{
                    background:"var(--card,#ffffff)", border:"1px solid var(--line,#e7ded3)",
                    borderRadius:12, padding:"10px 14px",
                    display:"flex", gap:10, alignItems:"flex-start",
                  }}>
                    <div style={{flexShrink:0,marginTop:2}}>
                      <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem"}}>{time}</div>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                        <span style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"0.85rem"}}>
                          {h.isCash && <span style={{color:"#3e9a5c",marginRight:4}}>💵</span>}
                          {h.customerName}
                        </span>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <span style={{color:"var(--ink,#3d3630)",fontWeight:800,fontSize:"0.95rem"}}>¥{(h.amount||0).toLocaleString()}</span>
                          {h.discount>0 && (
                            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem"}}>割引 -¥{h.discount.toLocaleString()}</div>
                          )}
                        </div>
                      </div>
                      {h.items && (
                        <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:3,
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {h.items}
                        </div>
                      )}
                      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                        {h.isCash ? (
                          <span style={{color:"#3e9a5c",background:"#e9f5ec",border:"1px solid #7cc39433",borderRadius:999,padding:"2px 9px",fontSize:"0.75rem"}}>
                            🧾 現金 · 👤 {h.performer || "スタッフ"}
                          </span>
                        ) : (
                        <span style={{
                          color: h.performer==="マネージャー" ? "#b07c1e" : "#3b7fb8",
                          background: h.performer==="マネージャー" ? "#faf0dc" : "#e9f1fa",
                          border: `1px solid ${h.performer==="マネージャー"?"#d3a94f33":"#8fbde033"}`,
                          borderRadius:999, padding:"2px 9px", fontSize:"0.75rem",
                        }}>
                          {h.performer==="マネージャー" ? "👑" : "👤"} {h.performer || "スタッフ"}
                        </span>
                        )}
                        {h.fromOrder && (
                          <span style={{color:"#8f7a3a",background:"#faf0dc",border:"1px solid #c4b48a33",
                            borderRadius:999,padding:"2px 9px",fontSize:"0.75rem"}}>
                            📋 注文記録から
                          </span>
                        )}
                        {h.subtotal && h.subtotal !== h.amount && (
                          <span style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem"}}>小計 ¥{h.subtotal.toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ORDERS PANEL ─────────────────────────
function OrdersPanel({ orders, customers, saveOrders, saveC, staffName }) {
  const pending   = orders.filter(o=>o.status==="pending").sort((a,b)=>a.createdAt>b.createdAt?1:-1);
  const completed = orders.filter(o=>o.status==="completed").sort((a,b)=>a.completedAt<b.completedAt?1:-1).slice(0,10);

  const completeOrder = (order) => {
    const now = new Date().toLocaleString("ja-JP");
    if (order.isCash) {
      saveOrders(orders.map(o=>o.orderId===order.orderId
        ? {...o, status:"completed", completedAt:now, completedBy: staffName || "スタッフ"}
        : o
      ));
      recordSale(order.total, true);
      logSale({ date: now, customerId: null,
                customerName: order.customerName || "現金のお客様",
                amount: order.total, subtotal: order.subtotal, discount: 0,
                items: (order.items||[]).map(i=>`${i.name}×${i.qty}`).join(", "),
                performer: staffName || "スタッフ", isCash: true,
                orderId: order.orderId, source: "order" });
      return;
    }
    const customer = customers.find(c=>c.id===order.customerId);
    if (!customer) { alert("会員が見つかりません"); return; }
    if (order.total > customer.balance) {
      if (!window.confirm(`残高不足です（残高: ¥${customer.balance.toLocaleString()} / 合計: ¥${order.total.toLocaleString()}）\n続行しますか？`)) return;
    }
    const itemText = [
      ...(order.items||[]).map(i=>`${i.name}×${i.qty}`),
      ...(order.benefitItems||[]).map(i=>`${i.name}(特典)`),
      ...(order.makaiItem ? [`${order.makaiItem.name}(賄い)`] : []),
    ].join(", ");
    const updatedCustomer = {
      ...customer,
      balance: (order.isSpecial || order.isVipGift) ? customer.balance : Math.max(0, customer.balance - order.total),
      history: [{
        type:"use", amount:order.total, subtotal:order.subtotal, discount:order.discount,
        items: itemText,
        performer: staffName || "スタッフ（注文完了）", date:now,
      }, ...(customer.history||[])].slice(0,60),
    };
    saveC(customers.map(c=>c.id===customer.id ? updatedCustomer : c));
    saveOrders(orders.map(o=>o.orderId===order.orderId
      ? {...o, status:"completed", completedAt:now, completedBy: staffName || "スタッフ"}
      : o
    ));
    recordSale(order.total, false);
    // 会員データの履歴とは別に、消えない台帳にも残す
    logSale({ date: now, customerId: customer.id, customerName: customer.name,
              amount: order.total, subtotal: order.subtotal, discount: order.discount,
              items: itemText, performer: staffName || "スタッフ（注文完了）",
              isCash: false, orderId: order.orderId, source: "order" });
  };

  // 注文をキャンセルするとき、その注文で使った特典（トッピング残数・月次特典・VIPプレゼント）を元に戻す。
  // お客様側のキャンセルと同じ扱いにして、特典が使い損になるのを防ぐ。
  const deleteOrder = (order) => {
    if (!window.confirm("この注文を削除しますか？\n使用した特典は元に戻します。")) return;
    const c = customers.find(x=>x.id===order.customerId);
    if (c) {
      let updated = { ...c };
      let changed = false;
      if (order.isVipGift) {
        updated.vipGiftUsedMonth = null;
        changed = true;
      } else if (order.usedBenefit) {
        const r   = getEffectiveRank(c);
        const max = getToppingMax(r);
        if (max > 0) {
          // 月が変わっていたらトッピング残数は満数に戻っている扱いなので、
          // 先月の残り（例:0回）を土台にしないよう気をつける。
          const base = (c.toppingRemainingMonth === currentMonth()) ? (c.toppingRemaining ?? max) : max;
          const restored = base + (order.usedToppingCount || 0);
          updated.toppingRemaining      = Math.min(restored, max);
          updated.toppingRemainingMonth = currentMonth();
        } else {
          updated.benefitUsedMonth = null;
        }
        changed = true;
      }
      if (changed) saveC(customers.map(x=>x.id===c.id ? updated : x));
    }
    saveOrders(orders.filter(o=>o.orderId!==order.orderId));
  };

  return (
    <div className="pos-page" style={{paddingTop:14}}>
      <h2 style={{...S.title,margin:"0 0 14px"}}>注文管理</h2>

      {/* 受付中 */}
      <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",letterSpacing:"0.08em",marginBottom:8}}>
        受付中 {pending.length>0&&<span style={{color:"#c21354",fontWeight:700}}>({pending.length}件)</span>}
      </div>

      {pending.length===0 ? (
        <div style={{textAlign:"center",color:"var(--ink4,#a79b90)",padding:"24px 0",fontSize:"0.85rem",
          background:"var(--card,#ffffff)",borderRadius:12,marginBottom:20}}>
          現在注文はありません
        </div>
      ) : (
        <div className="pos-list" style={{marginBottom:20}}>
          {pending.map(order=>(
            <div key={order.orderId} style={{
              background:"#eef3df",border:`1px solid ${order.rankColor}55`,
              borderRadius:16,padding:"12px 14px",
              boxShadow:`0 0 12px ${order.rankColor}18`,
            }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    <span style={{fontSize:"0.95rem"}}>{order.rankGem}</span>
                    <span style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"1rem"}}>{order.customerName}</span>
                    {order.isVipGift
                      ? <span style={{color:"#a9791a",fontSize:"0.75rem",border:"1px solid #e8c14a55",borderRadius:999,padding:"2px 9px",fontWeight:700}}>⭐ VIPギフト</span>
                      : order.isCash
                        ? <span style={{color:"#3e9a5c",fontSize:"0.75rem",border:"1px solid #7cc39455",borderRadius:999,padding:"2px 9px",fontWeight:700}}>💵 現金</span>
                        : order.isSpecial
                          ? <span style={{color:"#9c3fb5",fontSize:"0.75rem",border:"1px solid #c98ada55",borderRadius:999,padding:"2px 9px",fontWeight:700}}>💜 スペシャル</span>
                          : <span style={{color:order.rankColor,fontSize:"0.75rem",border:`1px solid ${order.rankColor}55`,borderRadius:999,padding:"2px 9px"}}>{order.rankName}</span>
                    }
                  </div>
                  <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>{order.createdAt}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{color:"var(--ink,#3d3630)",fontWeight:800,fontSize:"1.15rem"}}>¥{order.total.toLocaleString()}</div>
                  {order.discount>0&&<div style={{color:order.rankColor,fontSize:"0.75rem"}}>割引 -¥{order.discount.toLocaleString()}</div>}
                </div>
              </div>
              <div style={{borderTop:"1px solid #dfe7cd",paddingTop:8,marginBottom:10}}>
                {(order.items||[]).map((item,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:3}}>
                    <span style={{color:"var(--ink2,#8a7f76)"}}>{item.emoji} {item.name} × {item.qty}</span>
                    <span style={{color:"var(--ink2,#8a7f76)"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                  </div>
                ))}
                {(order.benefitItems||[]).map((item,i)=>(
                  <div key={"b"+i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:3}}>
                    <span style={{color:order.rankColor||"#a9791a"}}>🎁 {item.emoji} {item.name} × {item.qty}（特典）</span>
                    <span style={{color:"#3e9a5c"}}>無料</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button className="btn-danger" style={{padding:"8px",fontSize:"0.85rem"}}
                  onClick={()=>deleteOrder(order)}>キャンセル</button>
                {order.staffLinked && order.staffLinked===staffName ? (
                  <div style={{flex:1,background:"var(--panel2,#f6f1ea)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"10px",
                    color:"var(--ink3,#9a8f85)",fontSize:"0.85rem",textAlign:"center"}}>
                    🔒 自分の注文は完了できません
                  </div>
                ) : (
                  <button className="btn-complete" onClick={()=>completeOrder(order)}>
                    ✓ 作成完了・決済する
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 完了済み */}
      {completed.length>0&&(
        <>
          <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",letterSpacing:"0.08em",marginBottom:8}}>完了済み（直近10件）</div>
          {/* 以前は opacity:0.7 をかけていて、金額も担当者も読み取りにくかった。
              「済んだもの」という区別は背景の色でつけて、文字はそのまま読める濃さにする。 */}
          <div className="pos-list">
            {completed.map(order=>(
              <div key={order.orderId} style={{background:"var(--panel2,#f6f1ea)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"10px 12px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <span style={{color:"var(--ink,#3d3630)",fontSize:"0.85rem",fontWeight:700}}>{order.customerName}</span>
                    <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginLeft:8}}>{order.completedAt}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:"#3e9a5c",fontSize:"0.85rem",fontWeight:700}}>¥{order.total.toLocaleString()}</span>
                    <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>{order.completedBy || "スタッフ"}</span>
                    <span style={{color:"#3e9a5c",fontSize:"0.75rem"}}>✓ 完了</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── MENU MANAGER ─────────────────────────
const EMOJIS = ["☕","🥛","☁️","🫖","🍵","🍊","🥐","🍰","🥪","🫓","🧁","🍩","🥗","🍜","🧃","🫗","🍋","🍓","🥤","🍫","🥞","🍮"];

function MenuManager({ menu, saveMenu, designatedDrink, saveDesignatedDrink }) {
  const [editing,    setEditing]    = useState(null); // item id or "new"
  const [form,       setForm]       = useState({});
  const [emojiPick,  setEmojiPick]  = useState(false);
  const [pickDrink,  setPickDrink]  = useState(false); // 指定ドリンクの選択肢を開いているか
  const categories = [...new Set(menu.map(m=>m.category))];

  const openNew = () => {
    setForm({ id:`m${Date.now()}`, name:"", category:"コーヒー", price:"", emoji:"☕" });
    setEditing("new");
    setEmojiPick(false);
  };
  const openEdit = (item) => {
    setForm({...item, price:String(item.price)});
    setEditing(item.id);
    setEmojiPick(false);
  };
  const upd = (f,v) => setForm(p=>({...p,[f]:v}));

  const save = () => {
    if (!form.name.trim() || !form.price || !form.category.trim()) return;
    const item = { ...form, price: parseInt(form.price)||0 };
    if (editing === "new") saveMenu([...menu, item]);
    else saveMenu(menu.map(m=>m.id===editing ? item : m));
    setEditing(null);
  };
  const del = (id) => {
    if (window.confirm("このメニューを削除しますか？")) saveMenu(menu.filter(m=>m.id!==id));
  };

  return (
    <div className="pos-page" style={{paddingTop:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h2 style={{...S.title,margin:0}}>メニュー管理</h2>
        <button className="btn-sm-gold" onClick={openNew}>＋ 追加</button>
      </div>

      {/* ── 今月の指定ドリンク設定（チタン特典用） ──
          選択肢は全メニュー分あるので、開きっぱなしだと本題のメニュー一覧まで
          2画面ぶんスクロールが要る。月に一度しか変えないものなので、普段は畳んでおく。 */}
      <div style={{background:"#e9f1fa",border:"1px solid #c3bab044",borderRadius:12,padding:"12px 14px",marginBottom:18}}>
        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:6}}>
          🩶 チタン特典 — 今月の指定ドリンク
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <span style={{color:designatedDrink?"#3d3630":"#9a8f85",fontWeight:designatedDrink?700:400,fontSize:designatedDrink?"1rem":"0.85rem"}}>
            {designatedDrink ? `${designatedDrink.emoji} ${designatedDrink.name}` : "未設定"}
          </span>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            {designatedDrink && (
              <button style={{background:"transparent",border:"1px solid #ddd3c6",borderRadius:999,
                padding:"4px 10px",color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}}
                onClick={()=>saveDesignatedDrink(null)}>解除</button>
            )}
            <button style={{background:"var(--card,#ffffff)",border:"1px solid #c3bab0",borderRadius:999,
              padding:"4px 12px",color:"#5d7d99",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
              onClick={()=>setPickDrink(v=>!v)}>{pickDrink?"閉じる":"変更"}</button>
          </div>
        </div>
        {pickDrink && (
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10}}>
            {menu.map(item=>(
              <button key={item.id}
                style={{background:designatedDrink?.id===item.id?"#dceaf5":"#ffffff",
                  border:`1px solid ${designatedDrink?.id===item.id?"#c3bab0":"#e7ded3"}`,
                  borderRadius:8,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",
                  color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",transition:"all 0.15s"}}
                onClick={()=>{ saveDesignatedDrink(item); setPickDrink(false); }}>
                {item.emoji} {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {categories.map(cat=>(
        <div key={cat} style={{marginBottom:18}}>
          <div style={S.catLabel}>{cat}</div>
          <div className="pos-list">
            {menu.filter(m=>m.category===cat).map(item=>(
              <div key={item.id} style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,
                padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:"1.4rem",flexShrink:0}}>{item.emoji}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:"0.95rem"}}>{item.name}</div>
                  <div style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price.toLocaleString()}</div>
                </div>
                <button className="btn-tiny-edit" onClick={()=>openEdit(item)}>✏️</button>
                <button className="btn-tiny-del"  onClick={()=>del(item.id)}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 編集・追加モーダル */}
      {editing && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"var(--gold,#b07c1e)",margin:0}}>{editing==="new"?"メニュー追加":"メニュー編集"}</h3>
              <button className="close-btn" onClick={()=>setEditing(null)}>✕</button>
            </div>

            {/* 絵文字ピッカー */}
            <div style={{marginBottom:14}}>
              <label style={S.label}>絵文字</label>
              <button style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:8,
                padding:"10px 16px",fontSize:"1.7rem",cursor:"pointer",display:"block"}}
                onClick={()=>setEmojiPick(p=>!p)}>
                {form.emoji || "☕"}
              </button>
              {emojiPick && (
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8,background:"var(--card,#ffffff)",
                  border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:10}}>
                  {EMOJIS.map(e=>(
                    <button key={e} style={{background:form.emoji===e?"#faf0dc":"#f6f1ea",
                      border:`1px solid ${form.emoji===e?"#d3a94f":"#e7ded3"}`,borderRadius:8,
                      padding:"6px 8px",fontSize:"1.15rem",cursor:"pointer"}}
                      onClick={()=>{ upd("emoji",e); setEmojiPick(false); }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{marginBottom:12}}>
              <label style={S.label}>商品名 *</label>
              <input style={S.input} placeholder="例: カフェラテ" value={form.name||""}
                onChange={e=>upd("name",e.target.value)}/>
            </div>

            <div style={{marginBottom:12}}>
              <label style={S.label}>カテゴリ *</label>
              <input style={S.input} placeholder="例: コーヒー" value={form.category||""}
                onChange={e=>upd("category",e.target.value)}/>
              {/* 既存カテゴリをサジェスト */}
              {categories.length > 0 && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
                  {categories.map(c=>(
                    <button key={c} className="preset-btn" style={{flex:"none",padding:"4px 10px",fontSize:"0.75rem"}}
                      onClick={()=>upd("category",c)}>{c}</button>
                  ))}
                </div>
              )}
            </div>

            <div style={{marginBottom:16}}>
              <label style={S.label}>価格 (¥) *</label>
              <input style={S.input} type="number" placeholder="例: 550" value={form.price||""}
                onChange={e=>upd("price",e.target.value)}/>
            </div>

            <button className="btn-save"
              style={{opacity:(form.name?.trim()&&form.price&&form.category?.trim())?1:0.4}}
              onClick={save}>
              {editing==="new"?"追加する":"保存する"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── YEAR HISTORY MODAL ───────────────────
function YearHistoryModal({ customer, rank, onClose }) {
  const year       = new Date().getFullYear();
  const yearStats  = customer.yearlyStats || [];

  // 今年のデータを先頭に追加（currentYearPurchasesから）
  const currentStat = {
    year,
    purchases: customer.currentYearPurchases ?? 0,
    rankName:  rank.name,
    rankGem:   rank.gem,
    rankColor: rank.color,
    isCurrent: true,
  };
  // 来年のランク予測
  const nextYearRankObj = getRank(customer.currentYearPurchases ?? 0);

  const allStats = [currentStat, ...yearStats.filter(s => s.year !== year)];
  const maxPurchases = Math.max(...allStats.map(s => s.purchases), 1);

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, maxHeight:"90vh"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <h3 style={{color:"var(--gold,#b07c1e)",margin:0,fontSize:"1rem"}}>📅 年度別履歴</h3>
            <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:2}}>
              <span style={{color:rank.color}}>{rank.gem} {rank.name}</span> · {customer.name}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {/* 来年のランク予測バナー */}
        <div style={{background:`${nextYearRankObj.color}18`, border:`1px solid ${nextYearRankObj.color}44`,
          borderRadius:12, padding:"10px 14px", marginBottom:14, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <div>
            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:2}}>来年のランク予測（今年の購入回数ベース）</div>
            <div style={{color:nextYearRankObj.color,fontWeight:700,fontSize:"0.95rem"}}>
              {nextYearRankObj.gem} {nextYearRankObj.name}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.75rem",marginBottom:2}}>今年の購入</div>
            <div style={{color:nextYearRankObj.color,fontWeight:800,fontSize:"1.15rem"}}>{customer.currentYearPurchases ?? 0}回</div>
          </div>
        </div>

        {/* 年度別カード一覧 */}
        <div style={{overflowY:"auto",maxHeight:"calc(90vh - 200px)",display:"flex",flexDirection:"column",gap:10}}>
          {allStats.length === 0 ? (
            <div style={{textAlign:"center",color:"var(--ink4,#a79b90)",padding:"32px 0",fontSize:"0.85rem"}}>履歴がありません</div>
          ) : allStats.map((s, i) => {
            const barPct = Math.round((s.purchases / maxPurchases) * 100);
            const isCur  = s.isCurrent;
            return (
              <div key={s.year} style={{
                background: isCur ? "#f6f1ea" : "#ffffff",
                border: `1px solid ${isCur ? s.rankColor+"55" : "#e7ded3"}`,
                borderRadius:12, padding:"14px 16px",
                boxShadow: isCur ? `0 0 16px ${s.rankColor}22` : "none",
              }}>
                {/* 年 & ランク */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{
                      background: isCur ? s.rankColor+"22" : "#f6f1ea",
                      border:`1px solid ${s.rankColor}55`,
                      borderRadius:8, padding:"4px 10px",
                      color:"var(--ink2,#8a7f76)", fontSize:"0.85rem", fontWeight:700,
                    }}>
                      {s.year}年
                      {isCur && <span style={{color:s.rankColor,marginLeft:4,fontSize:"0.75rem"}}>（今年）</span>}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <span style={{fontSize:"1rem"}}>{s.rankGem}</span>
                      <span style={{color:s.rankColor,fontWeight:700,fontSize:"0.85rem"}}>{s.rankName}</span>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span style={{color:s.rankColor,fontWeight:800,fontSize:"1.4rem"}}>{s.purchases}</span>
                    <span style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginLeft:3}}>回</span>
                  </div>
                </div>

                {/* 棒グラフ */}
                <div style={{background:"var(--panel2,#f6f1ea)",borderRadius:8,height:8,overflow:"hidden",marginBottom:8}}>
                  <div style={{
                    height:"100%", borderRadius:8,
                    width:`${barPct}%`,
                    background:`linear-gradient(90deg,${s.rankColor}99,${s.rankColor})`,
                    transition:"width 0.6s ease",
                    minWidth: s.purchases > 0 ? 8 : 0,
                  }}/>
                </div>

                {/* 特典 */}
                {(() => {
                  const r = RANKS.find(r=>r.name===s.rankName) || RANKS[0];
                  return (
                    <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>
                      {r.benefit.icon} {r.benefit.desc}
                      <span style={{marginLeft:6,color:r.benefit.type==="always_discount"?"#3b7fb8":"#8a7f76",fontSize:"0.75rem"}}>
                        {r.benefit.type==="always_discount"?"毎回自動":"月1回"}
                      </span>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <button className="btn-ghost" style={{marginTop:16}} onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

// ── HISTORY MODAL ────────────────────────
const HIST_CONFIG = {
  use:            { icon:"💳", label:"決済",          color:"#c94a45" },
  charge:         { icon:"🎫", label:"チャージ",       color:"#3e9a5c" },
  charge_undo:    { icon:"↩️", label:"チャージ取消",   color:"#c94a45" },
  benefit:        { icon:"🎁", label:"特典使用",       color:"var(--gold,#b07c1e)" },
  edit_balance:   { icon:"✏️", label:"残高編集",       color:"#3b7fb8" },
  edit_purchases: { icon:"✏️", label:"購入回数変更",   color:"#3b7fb8" },
  benefit_reset:  { icon:"🔄", label:"特典リセット",   color:"var(--ink2,#8a7f76)" },
  year_reset:     { icon:"🎉", label:"年次リセット",   color:"#7a6fd4" },
};

function HistoryModal({ customer, rank, onClose }) {
  const history = customer.history || [];

  const groups = history.reduce((acc, h) => {
    const day = h.date ? h.date.split(" ")[0] : "不明";
    if (!acc[day]) acc[day] = [];
    acc[day].push(h);
    return acc;
  }, {});

  const formatDetail = (h) => {
    if (h.type === "use") {
      const parts = [`¥${h.amount.toLocaleString()}`];
      if (h.discount > 0) parts.push(`(割引 -¥${h.discount.toLocaleString()})`);
      if (h.items) parts.push(`| ${h.items}`);
      return parts.join(" ");
    }
    if (h.type === "charge")         return `+¥2,200 · 購入回数+1`;
    if (h.type === "charge_undo")    return `-¥2,200 · 購入回数-1（取消）`;
    if (h.type === "benefit")        return h.desc || "特典使用";
    if (h.type === "edit_balance")   return `¥${h.before?.toLocaleString()} → ¥${h.after?.toLocaleString()}`;
    if (h.type === "edit_purchases") return `${h.label ? h.label+": " : ""}${h.before}回 → ${h.after}回`;
    if (h.type === "benefit_reset")  return "今月の特典を未使用に戻した";
    if (h.type === "year_reset")     return `年次リセット: 前年${h.prevPurchases}回 → ランク: ${h.newRank} で新年スタート`;
    return "";
  };

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, maxHeight:"88vh"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div>
            <h3 style={{color:"var(--gold,#b07c1e)",margin:0,fontSize:"1rem"}}>📋 操作履歴</h3>
            <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:2}}>
              <span style={{color:rank.color}}>{rank.gem} {rank.name}</span> · {customer.name}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {history.length === 0 ? (
          <div style={{textAlign:"center",color:"var(--ink4,#a79b90)",padding:"32px 0",fontSize:"0.85rem"}}>
            履歴がありません
          </div>
        ) : (
          <div style={{marginTop:14,overflowY:"auto",maxHeight:"calc(88vh - 100px)"}}>
            {Object.entries(groups).map(([day, entries]) => (
              <div key={day} style={{marginBottom:18}}>
                <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",letterSpacing:"0.08em",
                  borderBottom:"1px solid var(--line,#e7ded3)",paddingBottom:4,marginBottom:8}}>
                  📅 {day}
                </div>
                {entries.map((h, i) => {
                  const cfg = HIST_CONFIG[h.type] || {icon:"•",label:h.type,color:"var(--ink2,#8a7f76)"};
                  const time = h.date?.split(" ")[1] || "";
                  return (
                    <div key={i} style={{display:"flex",gap:10,marginBottom:10,alignItems:"flex-start"}}>
                      <div style={{fontSize:"1rem",flexShrink:0,marginTop:1}}>{cfg.icon}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}>
                          <span style={{color:cfg.color,fontWeight:700,fontSize:"0.85rem"}}>{cfg.label}</span>
                          <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                            <span style={{
                              fontSize:"0.75rem",
                              color: h.performer==="マネージャー" ? "#b07c1e" : "#8a7f76",
                              background: h.performer==="マネージャー" ? "#faf0dc" : "#f6f1ea",
                              border: `1px solid ${h.performer==="マネージャー"?"#d3a94f44":"#e7ded3"}`,
                              borderRadius:999, padding:"2px 9px",
                            }}>
                              {h.performer==="マネージャー" ? "👑 MG" : "👤 ST"}
                            </span>
                            <span style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem"}}>{time}</span>
                          </div>
                        </div>
                        <div style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",marginTop:2,wordBreak:"break-all"}}>
                          {formatDetail(h)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── CODE MODAL ──────────────────────────
function CodeModal({ customer, rank, onClose }) {
  return (
    <div style={S.overlay}>
      <div style={{...S.modal,paddingBottom:28}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <h3 style={{color:"var(--gold,#b07c1e)",margin:0,fontSize:"1rem"}}>🔑 お客様確認コード</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{textAlign:"center",marginBottom:16}}>
          <span style={{color:rank.color,fontSize:"0.85rem",fontWeight:700}}>{rank.gem} {rank.name}会員</span>
          <div style={{color:"var(--ink,#3d3630)",fontWeight:700,fontSize:"1.15rem",marginTop:4}}>{customer.name}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[["会員番号",customer.id,"会員番号欄に入力"],["暗証番号",customer.pin,"暗証番号欄に入力"]].map(([l,v,h])=>(
            <div key={l} style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"14px 18px",textAlign:"center"}}>
              <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",letterSpacing:"0.08em",marginBottom:6}}>{l}</div>
              <div style={{color:"var(--ink,#3d3630)",fontSize:"2.2rem",fontWeight:800,letterSpacing:"0.25em"}}>{v}</div>
              <div style={{color:"var(--ink4,#a79b90)",fontSize:"0.75rem",marginTop:6}}>{h}</div>
            </div>
          ))}
        </div>
        <button className="btn-ghost" style={{marginTop:18}} onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

// ── MANAGER PW MODAL ─────────────────────
function ManagerPwModal({ onConfirm, onClose, pwInput, setPwInput, err }) {
  return (
    <div style={S.overlay}>
      <div style={{...S.modal,paddingBottom:28}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h3 style={{color:"var(--gold,#b07c1e)",margin:0,fontSize:"1rem"}}>🔒 マネージャー認証</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <p style={{color:"var(--ink3,#9a8f85)",fontSize:"0.85rem",marginBottom:12}}>この操作にはマネージャーパスワードが必要です</p>
        <input style={{...S.input,marginBottom:8}} type="password" placeholder="マネージャーパスワード"
          value={pwInput} onChange={e=>setPwInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&onConfirm()} autoFocus/>
        {err && <p style={S.err}>{err}</p>}
        <button className="btn-gold" style={{marginTop:10}} onClick={onConfirm}>認証する</button>
      </div>
    </div>
  );
}

// ── EDIT CUSTOMER ────────────────────────
function EditCustomerModal({ customer, customers, onSave, onDelete, onClose }) {
  const [bal,  setBal]  = useState(String(customer.balance));
  const [pin,  setPin]  = useState(customer.pin || "");
  const [cyp,  setCyp]  = useState(String(customer.currentYearPurchases ?? customer.purchases ?? 0));
  const [rb,   setRb]   = useState(String(customer.rankBasis ?? customer.purchases ?? 0));
  const [isVIP,    setIsVIP]    = useState(!!customer.isVIP);
  const [isSpecial,setIsSpecial]= useState(!!customer.isSpecial);
  const [resetBenefit, setResetBenefit] = useState(false);
  const rankPreview = getRank(parseInt(rb)||0);

  const pinOwner = findPinOwner(pin, customers, customer.id);
  const save = () => {
    if (pinOwner) { alert(`この暗証番号は「${pinOwner.name}」さんが使用中です。別の番号にしてください`); return; }
    const newBal = Math.max(0, parseInt(bal)||0);
    const newCyp = Math.max(0, parseInt(cyp)||0);
    const newRb  = Math.max(0, parseInt(rb)||0);
    const logs = [];
    if (newBal !== customer.balance) {
      logs.push({ type:"edit_balance", before:customer.balance, after:newBal, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
      // 残高の手修正も、消えない台帳に残す
      logMoney({ type:"edit_balance", customerId:customer.id, customerName:customer.name,
                 amount:newBal-customer.balance, balanceBefore:customer.balance, balanceAfter:newBal,
                 performer:"マネージャー" });
    }
    if (newCyp !== (customer.currentYearPurchases ?? 0))
      logs.push({ type:"edit_purchases", label:"今年の購入回数", before:customer.currentYearPurchases??0, after:newCyp, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    if (newRb !== (customer.rankBasis ?? 0))
      logs.push({ type:"edit_purchases", label:"ランク基準値", before:customer.rankBasis??0, after:newRb, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    if (resetBenefit && isBenefitUsed(customer))
      logs.push({ type:"benefit_reset", performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    onSave({
      ...customer,
      balance:              newBal,
      pin:                  pin.trim() || customer.pin,
      currentYearPurchases: newCyp,
      rankBasis:            newRb,
      isVIP,
      isSpecial,
      dataYear:             new Date().getFullYear(),
      benefitUsedMonth:     resetBenefit ? null : customer.benefitUsedMonth,
      history: [...logs, ...(customer.history||[])].slice(0,60),
    });
  };

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h3 style={{color:"var(--gold,#b07c1e)",margin:0}}>会員情報の編集</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>暗証番号（お客様ログイン用）</label>
          <input style={S.input} value={pin} onChange={e=>setPin(e.target.value)} placeholder="例: 1234"/>
          {pinOwner
            ? <div style={{color:"#c94a45",fontSize:"0.75rem",marginTop:4,fontWeight:700}}>⚠️ この番号は「{pinOwner.name}」さんが使用中です</div>
            : <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:4}}>お客様が確認画面でこの番号を使用します</div>}
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>残高 (¥)</label>
          <input style={S.input} type="number" value={bal} onChange={e=>setBal(e.target.value)}/>
          <div style={{display:"flex",gap:6,marginTop:8}}>
            {[2200,4400,6600].map(v=>(
              <button key={v} className="preset-btn" onClick={()=>setBal(String((parseInt(bal)||0)+v))}>+¥{(v/1000).toFixed(1)}k</button>
            ))}
            <button className="preset-btn" style={{color:"#c94a45"}} onClick={()=>setBal("0")}>リセット</button>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>今年の購入回数（来年のランク判定に使用）</label>
          <input style={S.input} type="number" value={cyp} onChange={e=>setCyp(e.target.value)}/>
          <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:4}}>
            来年のランク予測: <span style={{color:getRank(parseInt(cyp)||0).color,fontWeight:700}}>{getRank(parseInt(cyp)||0).gem} {getRank(parseInt(cyp)||0).name}</span>
          </div>
        </div>
        <div style={{marginBottom:14,background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"12px 14px"}}>
          <label style={S.label}>現在のランク基準値（前年の購入回数）</label>
          <input style={S.input} type="number" value={rb} onChange={e=>setRb(e.target.value)}/>
          <div style={{color:rankPreview.color,fontSize:"0.75rem",marginTop:4,fontWeight:700}}>
            {rankPreview.gem} {rankPreview.name} → {rankPreview.benefit.icon} {rankPreview.benefit.desc}
          </div>
        </div>
        {/* 月次特典リセット */}
        {rankPreview.benefit.type === "monthly" && (
          <div style={{marginBottom:14,background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:12,padding:"12px 14px"}}>
            <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
              <input type="checkbox" checked={resetBenefit} onChange={e=>setResetBenefit(e.target.checked)}
                style={{width:16,height:16,accentColor:"#d4a853"}}/>
              <div>
                <div style={{color:"var(--ink,#3d3630)",fontSize:"0.85rem",fontWeight:600}}>今月の特典をリセット</div>
                <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem"}}>
                  {isBenefitUsed(customer) ? "現在: 使用済み → 未使用に戻す" : "現在: 未使用（変更不要）"}
                </div>
              </div>
            </label>
          </div>
        )}
        {/* VIPステータス */}
        <div style={{marginBottom:10,background:"#e9f1fa",border:`1px solid ${isVIP?"#e8c14a55":"#e7ded3"}`,borderRadius:12,padding:"12px 14px"}}>
          <label style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
            <div style={{position:"relative",width:44,height:24,background:isVIP?"#d9a441":"#eee7dd",borderRadius:12,transition:"background 0.2s",flexShrink:0}}
              onClick={()=>setIsVIP(p=>!p)}>
              <div style={{position:"absolute",top:3,left:isVIP?22:3,width:18,height:18,background:"#fff",borderRadius:"50%",transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{color:isVIP?"#a9791a":"#8a7f76",fontWeight:700,fontSize:"0.85rem"}}>⭐ VIP会員</div>
              <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:2}}>毎月プレゼントドリンクが受け取れます</div>
            </div>
          </label>
        </div>
        {/* スペシャルステータス */}
        <div style={{marginBottom:14,background:`${isSpecial?"#f5eafa":"#ffffff"}`,border:`1px solid ${isSpecial?"#c98ada55":"#e7ded3"}`,borderRadius:12,padding:"12px 14px"}}>
          <label style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
            <div style={{position:"relative",width:44,height:24,background:isSpecial?"#9c27b0":"#eee7dd",borderRadius:12,transition:"background 0.2s",flexShrink:0}}
              onClick={()=>setIsSpecial(p=>!p)}>
              <div style={{position:"absolute",top:3,left:isSpecial?22:3,width:18,height:18,background:"#fff",borderRadius:"50%",transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{color:isSpecial?"#9c3fb5":"#8a7f76",fontWeight:700,fontSize:"0.85rem"}}>💜 スペシャル</div>
              <div style={{color:"var(--ink3,#9a8f85)",fontSize:"0.75rem",marginTop:2}}>全ての注文が常に無料になります</div>
            </div>
          </label>
        </div>
        <button className="btn-save" onClick={save}>保存する</button>
        <button className="btn-danger" style={{marginTop:8}} onClick={onDelete}>この会員を削除</button>
      </div>
    </div>
  );
}
// ── CASH ORDER PANEL（現金注文・代理注文） ──
function CashOrderPanel({ menu, staffName, orders, saveOrders }) {
  const [cart,      setCart]      = useState([]);
  const [custName,  setCustName]  = useState("");
  const [done,      setDone]      = useState(false);
  const categories = [...new Set(menu.map(m=>m.category))];

  const addToCart = (item) => setCart(prev=>{
    const ex=prev.find(c=>c.id===item.id);
    return ex ? prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c) : [...prev,{...item,qty:1}];
  });
  const removeOne = (id) => setCart(prev=>{
    const ex=prev.find(c=>c.id===id);
    if(!ex) return prev;
    return ex.qty===1 ? prev.filter(c=>c.id!==id) : prev.map(c=>c.id===id?{...c,qty:c.qty-1}:c);
  });

  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);

  const confirmCash = () => {
    if (cart.length===0) return;
    const order = {
      orderId:      `ord_${Date.now()}`,
      customerId:   `cash_${Date.now()}`,
      customerName: custName.trim() || "現金のお客様",
      rankName: "現金", rankColor: "#5ecf7f", rankGem: "💵",
      items: cart, benefitItems: [],
      subtotal, discount: 0, staffDiscount: 0, total: subtotal,
      usedBenefit: false, usedToppingCount: 0,
      isCash: true,
      staffLinked: null,
      status: "pending",
      createdAt: new Date().toLocaleString("ja-JP"),
    };
    saveOrders([order, ...orders]);
    setCart([]); setCustName(""); setDone(true);
    setTimeout(()=>setDone(false), 2500);
  };

  return (
    <div className="pos-page" style={{paddingTop:14, paddingBottom:40}}>
      <h2 style={{...S.title,margin:"0 0 6px"}}>💵 現金注文</h2>
      <p style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem",lineHeight:1.6,marginBottom:14}}>
        会員登録のないお客様や、アプリを使えないお客様の注文を、スタッフが代わりに記録します。確定すると「📋 注文」に届き、完了すると会計履歴にも残ります。会員の残高・購入回数には影響しません。
      </p>

      {done && (
        <div style={{background:"#e9f5ec",border:"1px solid #c9e2ce",borderRadius:12,padding:"12px 14px",marginBottom:14,color:"#3e9a5c",fontWeight:700,fontSize:"0.95rem"}}>
          ✅ 現金注文を「📋 注文」に送りました（担当: {staffName}）
        </div>
      )}

      <div style={{marginBottom:14}}>
        <label style={S.label}>お客様の名前（任意・空欄でもOK）</label>
        <input style={S.input} placeholder="例: 常連の田中さん / 空欄でも可"
          value={custName} onChange={e=>setCustName(e.target.value)}/>
      </div>

      {categories.map(cat=>(
        <div key={cat} style={{marginBottom:14}}>
          <div style={S.catLabel}>{cat}</div>
          <div className="menu-grid-auto">
            {menu.filter(m=>m.category===cat).map(item=>{
              const inCart=cart.find(c=>c.id===item.id);
              return (
                <button key={item.id} className={`menu-item ${inCart?"menu-item-active":""}`} onClick={()=>addToCart(item)}>
                  <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                  <span style={{fontSize:"0.85rem",fontWeight:600,color:"var(--ink,#3d3630)",lineHeight:1.25,marginTop:3,textAlign:"center"}}>{item.name}</span>
                  <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                  {inCart&&<div style={S.cartBadge}>{inCart.qty}</div>}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {cart.length>0 && (
        <div style={{background:"var(--card,#ffffff)",border:"1px solid var(--line,#e7ded3)",borderRadius:16,padding:"12px 14px",marginTop:8}}>
          {cart.map(item=>(
            <div key={item.id} style={S.cartRow}>
              <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button className="qty-btn" onClick={()=>removeOne(item.id)}>－</button>
                <span style={{color:"var(--ink,#3d3630)",minWidth:18,textAlign:"center",fontWeight:700}}>{item.qty}</span>
                <button className="qty-btn" onClick={()=>addToCart(item)}>＋</button>
                <span style={{color:"var(--gold,#b07c1e)",fontWeight:700,fontSize:"0.85rem",minWidth:56,textAlign:"right"}}>¥{(item.price*item.qty).toLocaleString()}</span>
              </div>
            </div>
          ))}
          <div style={{paddingTop:8,borderTop:"1px solid var(--line,#e7ded3)",marginTop:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{color:"var(--ink2,#8a7f76)",fontSize:"0.85rem"}}>現金で受け取る金額</span>
              <span style={{color:"var(--ink,#3d3630)",fontWeight:800,fontSize:"1.4rem"}}>¥{subtotal.toLocaleString()}</span>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn-clear" onClick={()=>{setCart([]);setCustName("");}}>クリア</button>
              <button className="btn-pay" onClick={confirmCash}>🧾 注文に送る</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ADD CUSTOMER ─────────────────────────
function AddCustomerModal({ onSave, onClose, nextId, customers }) {
  const year = new Date().getFullYear();
  const [c,setC]=useState({id:nextId,name:"",pin:"",balance:2000,currentYearPurchases:1,rankBasis:0,dataYear:year,joined:new Date().toISOString().slice(0,10),history:[],benefitUsedMonth:null});
  const upd=(f,v)=>setC(p=>({...p,[f]:v}));
  const pinOwner = findPinOwner(c.pin, customers, c.id);
  const ok=c.name.trim()&&c.pin.trim()&&!pinOwner;
  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h3 style={{color:"#a9791a",margin:0}}>新規会員登録</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        {[["name","お名前（ひらがな）*","例: たなか みさき"],["pin","暗証番号 *","数字4桁など（例: 1234）"]].map(([f,l,p])=>(
          <div key={f} style={{marginBottom:12}}>
            <label style={S.label}>{l}</label>
            <input style={S.input} placeholder={p} value={c[f]} onChange={e=>upd(f,e.target.value)}/>
          </div>
        ))}
        {pinOwner && (
          <div style={{...S.err,marginBottom:10}}>
            ⚠️ この暗証番号は「{pinOwner.name}」さんが使用中です。別の番号にしてください
          </div>
        )}
        <div style={{marginBottom:14}}>
          <label style={S.label}>初回残高 (¥)</label>
          <input style={S.input} type="number" value={c.balance} onChange={e=>upd("balance",parseInt(e.target.value)||0)}/>
        </div>
        <button className="btn-save" style={{opacity:ok?1:0.4}} onClick={()=>ok&&onSave(c)}>登録する</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════
const S = {
  // 書体は丸ゴシック。明朝は「格式」を語る書体で、カフェの空気に合わなかった。
  // 丸みのある書体にするだけで、画面全体の印象がやわらかくなる。
  root:          { fontFamily:"'Zen Maru Gothic','Hiragino Maru Gothic ProN','ヒラギノ丸ゴ ProN',sans-serif", background:"#fdf8f3", minHeight:"100vh", color:"var(--ink,#3d3630)" },
  loading:       { color:"var(--ink2,#8a7f76)", textAlign:"center", padding:40 },
  page:          { maxWidth:480, margin:"0 auto", padding:"24px 16px" },

  // HOME
  homeOuter:     { minHeight:"100vh", maxWidth:480, margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", overflow:"hidden", padding:"24px 16px" },
  homeBgCircle1: { position:"absolute", width:340, height:340, borderRadius:"50%", background:"radial-gradient(circle,#ff8fb322,transparent 70%)", top:-80, right:-80, pointerEvents:"none" },
  homeBgCircle2: { position:"absolute", width:280, height:280, borderRadius:"50%", background:"radial-gradient(circle,#8fc2ee22,transparent 70%)", bottom:-60, left:-60, pointerEvents:"none" },
  homeBgCircle3: { position:"absolute", width:200, height:200, borderRadius:"50%", background:"radial-gradient(circle,#ffd98a18,transparent 70%)", top:"40%", left:"50%", transform:"translateX(-50%)", pointerEvents:"none" },
  homeWrap:      { display:"flex", flexDirection:"column", alignItems:"center", gap:14, textAlign:"center", position:"relative", zIndex:1, width:"100%" },
  rainbowLogoWrap:{ position:"relative", marginBottom:4 },
  rainbowLogoInner:{ width:100, height:100, borderRadius:"50%", background:"linear-gradient(135deg,#f6f1ea,#ffffff)", border:"2px solid transparent", backgroundClip:"padding-box", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 0 2px transparent, 0 8px 32px rgba(61,54,48,0.10)", position:"relative", zIndex:1 },
  rainbowGlow:   { position:"absolute", inset:-3, borderRadius:"50%", background:"linear-gradient(135deg,#ff8fb3,#ffb877,#ffd98a,#9fdcae,#8fc2ee,#b8ace0,#ff8fb3)", zIndex:0, filter:"blur(2px)", opacity:0.85 },
  brandRainbow:  { margin:0, fontSize:"2.6rem", fontWeight:800, letterSpacing:"0.08em", lineHeight:1 },
  brandUnderline:{ height:3, borderRadius:8, background:"linear-gradient(90deg,#ff8fb3,#ffb877,#ffd98a,#9fdcae,#8fc2ee,#b8ace0)", marginTop:6, width:"100%" },
  // 小さすぎる文字は読みにくいので、本文まわりは大きめに。
  taglineRainbow:{ color:"var(--ink2,#8a7f76)", fontSize:"0.95rem", letterSpacing:"0.04em", margin:"2px 0 4px" },
  homeBtns:      { display:"flex", flexDirection:"column", gap:12, width:"100%", maxWidth:320 },
  decoRow:       { display:"flex", gap:10, marginTop:10, alignItems:"center" },
  title:         { fontSize:"1.15rem", color:"var(--gold,#b07c1e)", letterSpacing:"0.08em", marginBottom:18, fontWeight:700 },
  hint:          { color:"var(--ink2,#8a7f76)", fontSize:"0.85rem", lineHeight:1.7, marginBottom:4 },
  input:         { background:"var(--card,#ffffff)", border:"1px solid var(--line,#e7ded3)", borderRadius:8, padding:"12px 14px", color:"var(--ink,#3d3630)", fontSize:"1rem", width:"100%", outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  err:           { color:"#c94a45", fontSize:"0.85rem", margin:"4px 0 0" },
  rankBadge:     { display:"inline-block", border:"1px solid", borderRadius:999, padding:"3px 10px", fontSize:"0.75rem", fontWeight:700, letterSpacing:"0.05em", marginBottom:7 },
  divider:       { borderTop:"1px dashed #d9cdbe", margin:"14px 0" },
  bar:           { background:"var(--barbg,#ece4d9)", borderRadius:999, height:10, overflow:"hidden" },
  benefitBox:    { border:"1px solid", borderRadius:12, padding:"10px 12px", marginTop:12 },
  benefitTagUsed:{ background:"#fbebea", color:"#c94a45", border:"1px solid #e0a09b44", borderRadius:999, padding:"3px 10px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
  benefitTagAvail:{ border:"1px solid", borderRadius:999, padding:"3px 10px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
  benefitTagAlways:{ background:"#eef2fb", color:"#3b7fb8", border:"1px solid #8fbde044", borderRadius:999, padding:"3px 10px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
  rankRow:       { display:"flex", alignItems:"center", padding:"7px 8px", marginBottom:2, position:"relative" },
  curDot:        { width:6, height:6, borderRadius:"50%", marginLeft:8, flexShrink:0 },
  topbar:        { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", background:"var(--card,#ffffff)", borderBottom:"1px solid var(--line,#e7ded3)", height:44, boxSizing:"border-box" },
  customerStrip: { padding:"10px 14px", background:"var(--card,#ffffff)", borderBottom:"2px solid", flexShrink:0 },
  benefitStripBox:{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"var(--card,#ffffff)", border:"1px solid", borderRadius:8, padding:"6px 10px", marginTop:6, gap:8 },
  catLabel:      { color:"var(--ink3,#9a8f85)", fontSize:"0.75rem", letterSpacing:"0.08em", marginBottom:8, paddingLeft:2 },
  menuGrid:      { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 },
  cartPanel:     { background:"var(--card,#ffffff)", borderTop:"1px solid var(--line,#e7ded3)", padding:"10px 14px", flexShrink:0 },
  cartRow:       { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid var(--line,#e7ded3)" },
  cartBadge:     { position:"absolute", top:4, right:4, background:"#e8b96a", color:"var(--ink,#3d3630)", borderRadius:"50%", width:18, height:18, fontSize:"0.75rem", fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center" },
  overlay:       { position:"fixed", inset:0, background:"#3d3630a8", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:100, backdropFilter:"blur(4px)" },
  modal:         { background:"var(--card,#ffffff)", borderRadius:"20px 20px 0 0", padding:20, width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" },
  label:         { display:"block", color:"var(--ink3,#9a8f85)", fontSize:"0.75rem", marginBottom:5, letterSpacing:"0.05em" },
  tagUsed:       { background:"#fbebea", color:"#c94a45", border:"1px solid #e0a09b33", borderRadius:999, padding:"2px 8px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
  tagAvail:      { background:"#e9f5ec", color:"#3e9a5c", border:"1px solid #7cc39444", borderRadius:999, padding:"2px 8px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
  tagAuto:       { background:"#e9f1fa", color:"#3b7fb8", border:"1px solid #8fbde044", borderRadius:999, padding:"2px 8px", fontSize:"0.75rem", fontWeight:700, whiteSpace:"nowrap" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@400;500;700&display=swap');
* { -webkit-tap-highlight-color:transparent; box-sizing:border-box; }
input:focus { border-color:#e86a8a !important; outline:none; }

.btn-gold  { background:linear-gradient(135deg,#e0a94a,#f2cd72); color:#4a3a12; border:none; border-radius:12px; padding:13px 20px; font-size:1rem; font-weight:700; cursor:pointer; width:100%; font-family:inherit; letter-spacing:0.05em; transition:opacity 0.15s,transform 0.1s; }
.btn-gold:hover { opacity:.9; transform:translateY(-1px); }

.btn-rainbow {
  display:flex; align-items:center; justify-content:center; gap:10px;
  width:100%; border:none; border-radius:999px; padding:17px 20px;
  font-size:1.15rem; font-weight:700; cursor:pointer; font-family:inherit;
  letter-spacing:0.04em; color:#fff; position:relative; overflow:hidden;
  background:linear-gradient(135deg,#ff8fb3,#ffb877,#ffdd82,#9fdcae,#8fc2ee,#b8ace0);
  background-size:200% 200%; animation:rainbowShift 4s ease infinite;
  box-shadow:0 4px 24px rgba(212,83,126,0.25); transition:transform 0.15s,box-shadow 0.15s;
  text-shadow:0 1px 4px rgba(61,54,48,0.08);
}
.btn-rainbow:hover { transform:translateY(-2px); box-shadow:0 8px 32px rgba(212,83,126,0.30); }
.btn-rainbow:active { transform:scale(0.97); }

.btn-crystal {
  display:flex; align-items:center; justify-content:center; gap:10px;
  width:100%; border-radius:999px; padding:16px 20px;
  font-size:1rem; font-weight:500; cursor:pointer; font-family:inherit;
  letter-spacing:0.04em; color:#8a7f76;
  background:linear-gradient(135deg,#ffffff,#ffffff);
  border:1px solid #e7ded3;
  box-shadow:0 2px 16px rgba(61,54,48,0.06),inset 0 1px 0 rgba(255,255,255,0.1);
  backdrop-filter:blur(8px); transition:all 0.2s;
}
.btn-crystal:hover { background:linear-gradient(135deg,#fdf8f3,#fdf8f3); border-color:#d9cdbe; box-shadow:0 4px 24px rgba(61,54,48,0.10); }

@keyframes rainbowShift {
  0%   { background-position:0% 50%; }
  50%  { background-position:100% 50%; }
  100% { background-position:0% 50%; }
}
@keyframes letterFloat {
  from { transform:translateY(0px); }
  to   { transform:translateY(-4px); }
}
@keyframes floatDeco {
  from { transform:translateY(0) rotate(-5deg); opacity:0.5; }
  to   { transform:translateY(-6px) rotate(5deg); opacity:0.9; }
}

/* ── 遊び心と、いまどきの質感 ──────────────────────
   方針：飾りは「お客様が見る画面」に集中させ、POSの仕事の邪魔はしない。
   すべてCSSと素のJSだけで動く（新しいライブラリは増やしていない）。
   端末の「視差効果を減らす」設定がオンの人には、動きを全部止める。 */

/* ホームの背景で、色の雲がゆっくり漂う */
@keyframes auroraDrift {
  0%   { transform:translate(0,0) scale(1); }
  50%  { transform:translate(26px,-20px) scale(1.18); }
  100% { transform:translate(-18px,14px) scale(0.94); }
}
.aurora { filter:blur(42px); opacity:0.8;
  animation:auroraDrift 10s ease-in-out infinite alternate; }

/* すりガラス。上のバーと注文の合計欄に使う（後ろがうっすら透ける） */
.glass { background:rgba(255,255,255,0.72) !important;
  backdrop-filter:blur(14px) saturate(1.5);
  -webkit-backdrop-filter:blur(14px) saturate(1.5); }

/* カードが下からふわっと現れる */
@keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
.rise { animation:rise 0.5s cubic-bezier(0.2,0.9,0.3,1) both; animation-delay:var(--d,0ms); }

/* 押した指に「ばね」で応える（全ボタン共通） */
button { transition:transform 0.18s cubic-bezier(0.34,1.56,0.64,1); }
button:active { transform:scale(0.96); }

/* ランクの進捗バーを、光の帯がすっと走る */
@keyframes shine { from { transform:translateX(-110%); } to { transform:translateX(320%); } }
.bar-fill { position:relative; overflow:hidden; }
.bar-fill::after { content:""; position:absolute; top:0; left:0; width:40%; height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.7),transparent);
  animation:shine 2.8s ease-in-out infinite; }

/* ランクの宝石が、ときどき小さく鼓動する */
@keyframes gemPulse { 0%,86%,100% { transform:scale(1); } 91% { transform:scale(1.22); } 96% { transform:scale(0.97); } }
.gem-pulse { display:inline-block; animation:gemPulse 5s ease-in-out infinite; }

/* 注文完了の紙吹雪と、✅のぽよんという登場 */
@keyframes confettiFall {
  0%   { transform:translateY(0) rotate(0deg); opacity:1; }
  100% { transform:translateY(150px) rotate(340deg); opacity:0; }
}
.confetti-box { position:relative; height:0; pointer-events:none; }
.confetti-box i { position:absolute; top:-6px; width:9px; height:14px; border-radius:3px;
  animation:confettiFall 1.5s ease-in forwards; }
@keyframes popIn {
  0% { transform:scale(0.2); opacity:0; } 60% { transform:scale(1.15); opacity:1; } 100% { transform:scale(1); }
}
.pop { animation:popIn 0.55s cubic-bezier(0.34,1.56,0.64,1) both; display:inline-block; }

/* ホームの虹の点が、順番に小さくはねる */
@keyframes dotWave { 0%,55%,100% { transform:translateY(0); } 25% { transform:translateY(-7px); } }
.dot-wave { animation:dotWave 2.6s ease-in-out infinite; }

/* ── ホログラムの会員カード ──────────────────────
   指の位置に合わせて3Dに傾き、虹色の光沢が指を追いかける。
   トレーディングカードの「キラカード」と同じ原理を、CSSだけで再現。 */
.tilt { transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));
  transition:transform 0.15s ease-out; will-change:transform; }
.holo-layer { position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  opacity:0; transition:opacity 0.35s;
  background:
    radial-gradient(circle at var(--mx,50%) var(--my,50%), rgba(255,255,255,0.55), transparent 42%),
    conic-gradient(from 0deg at var(--mx,50%) var(--my,50%),
      rgba(232,117,155,0.28), rgba(255,221,130,0.28), rgba(159,220,174,0.28),
      rgba(143,194,238,0.28), rgba(184,172,224,0.28), rgba(232,117,155,0.28));
  mix-blend-mode:soft-light; }
.holo-on .holo-layer { opacity:1; }

/* 画面の切り替え（View Transitions API）。前の画面が少し縮みながら消え、
   次の画面がふわっと現れる。非対応の端末では何も起きない（即切り替え） */
::view-transition-old(root) { animation:vtOut 0.26s ease both; }
::view-transition-new(root) { animation:vtIn 0.32s ease both; }
@keyframes vtOut { to { opacity:0; transform:scale(0.985); } }
@keyframes vtIn { from { opacity:0; transform:scale(1.015); } }

/* 読み込み中の虹色リング */
@keyframes spin { to { transform:rotate(360deg); } }
.spinner { width:36px; height:36px; border-radius:50%; margin:0 auto 12px;
  background:conic-gradient(#e8759b,#e8944a,#d9a821,#5fa878,#5b93c9,#8a7cc4,#e8759b);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 4px));
  mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 4px));
  animation:spin 0.9s linear infinite; }

/* ══════════════════════════════════════════
   夜のネオンガラス（お客様画面だけ）
   ══════════════════════════════════════════
   NightMode が body に .night を付けている間だけ効く配色。
   色はすべて CSS変数経由なので、ここの値を差し替えるだけで
   画面全体が夜に切り替わる。POSでは何も起きない。 */
body.night {
  --ink:#f2edff;         /* 主な文字 */
  --ink-strong:#ffffff;  /* 残高など、一番濃い文字 */
  --ink2:#c9c2ec;        /* 説明の文字 */
  --ink3:#a49cd1;        /* さらに薄い文字 */
  --ink4:#8b84b8;        /* 一番控えめな文字 */
  --card:rgba(26,22,58,0.72);      /* カードの下地（ガラス板） */
  --panel2:rgba(255,255,255,0.10); /* ボタンなどの下地 */
  --line:rgba(255,255,255,0.16);   /* 枠線 */
  --barbg:rgba(255,255,255,0.12);  /* 進捗バーの溝 */
  --gold:#ffd166;                  /* 金額の金色 → 夜は明るい琥珀 */
  background:#131029;
}
/* 背景の色つきの光は ::before に分けてある。
   こうすると hue-rotate（きせかえ🎨）が背景の光だけに効いて、
   文字やカードの色は変わらない。以前は色替えがホームの雲にしか効いておらず、
   きせかえボタンを押しても何も変わらないように見えていた。 */
body.night .approot {
  background:transparent !important;
  color:var(--ink);
}
body.night .approot::before {
  content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
  background:
    radial-gradient(1100px 700px at 85% -10%, rgba(140,60,210,0.5), transparent 60%),
    radial-gradient(900px 620px at -10% 110%, rgba(40,100,220,0.45), transparent 60%),
    radial-gradient(700px 500px at 50% 50%, rgba(90,50,160,0.18), transparent 70%);
  filter:hue-rotate(var(--nh,0deg)) saturate(1.15);
  transition:filter 0.6s ease;
}
/* 夜は、漂う色の雲が「光」になる（screen合成で背景に発光する） */
body.night .aurora { mix-blend-mode:screen; opacity:1; filter:blur(60px) saturate(1.9); }
/* ガラス板は夜用の濃さに */
body.night .glass { background:rgba(20,16,46,0.68) !important; border-color:rgba(255,255,255,0.14) !important; }
/* 入力欄 */
body.night input { background:rgba(255,255,255,0.08) !important; border-color:rgba(255,255,255,0.22) !important; color:#ffffff !important; }
body.night input::placeholder { color:#8b84b8; }
/* 切り替えタブ */
body.night .tab-btn { color:#a49cd1; }
body.night .tab-btn.active { background:rgba(255,255,255,0.13); color:#ffd9ec;
  box-shadow:0 0 16px rgba(255,110,199,0.35); }
/* 商品ボタン */
body.night .menu-item { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.13); }
body.night .menu-item:hover { background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.22); }
body.night .menu-item-active { background:rgba(255,110,199,0.16) !important; border-color:rgba(255,110,199,0.55) !important;
  box-shadow:0 0 18px rgba(255,110,199,0.28); }
/* 数量・クリア・控えめボタン */
body.night .qty-btn { background:rgba(255,255,255,0.10); color:#f2edff; border-color:rgba(255,255,255,0.22); }
body.night .btn-clear { background:rgba(255,255,255,0.08); color:#c9c2ec; border-color:rgba(255,255,255,0.18); }
body.night .btn-ghost { border-color:rgba(255,255,255,0.22); color:#c9c2ec; }
body.night .btn-quiet { color:#8b84b8; }
body.night .back-btn { color:#a49cd1; }
/* ホームの入口ボタン */
body.night .btn-crystal { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.20); color:#d9d3f5;
  box-shadow:0 0 28px rgba(120,90,220,0.28); }
body.night .btn-rainbow { box-shadow:0 6px 34px rgba(255,110,199,0.45); }
/* 会員カード：夜は黒いガラスに虹の光沢が最高に映える */
body.night .ticket-card { box-shadow:0 12px 44px rgba(0,0,0,0.5), 0 0 34px rgba(255,110,199,0.14) !important;
  border-color:rgba(255,255,255,0.14) !important; }
body.night .holo-layer { mix-blend-mode:screen; }

/* ── ネオン看板 ─────────────────────────────
   白い芯の文字に、色つきの光を何重にも重ねる（本物のネオン管と同じ構造）。
   点灯アニメは「パチ…パチ…ポワッ」の順で1文字ずつ。 */
.neon-ch { color:#fff8f4;
  text-shadow:
    0 0 4px rgba(255,255,255,0.8),
    0 0 12px var(--nc,#ff6ec7),
    0 0 28px var(--nc,#ff6ec7),
    0 0 56px var(--nc,#ff6ec7);
  animation:neonOn 1.1s both; }
@keyframes neonOn {
  0%   { opacity:0.08; text-shadow:none; }
  50%  { opacity:0.08; text-shadow:none; }
  58%  { opacity:0.9; }
  64%  { opacity:0.15; text-shadow:none; }
  72%  { opacity:1; }
  80%  { opacity:0.4; }
  100% { opacity:1; }
}
.neon-flicker { animation:neonOn 1.1s both, neonBuzz 7s 4s ease-in-out infinite; }
@keyframes neonBuzz {
  0%, 93%, 100% { opacity:1; }
  94% { opacity:0.45; } 95% { opacity:1; } 97% { opacity:0.6; } 98% { opacity:1; }
}
/* 昼の画面（万一 night 無しでロゴが出た場合）でも読めるようにしておく */
body:not(.night) .neon-ch { color:#c98ab0; text-shadow:0 0 10px var(--nc,#ff6ec7); }

/* ── ポップな夜の住人たち ────────────────────── */
/* またたく星 */
.star { position:absolute; border-radius:50%; background:#fff; pointer-events:none;
  box-shadow:0 0 6px rgba(255,255,255,0.6);
  animation:twinkle 3.2s ease-in-out infinite; }
@keyframes twinkle { 0%,100% { opacity:0.12; } 50% { opacity:0.85; } }

/* 下からぷかぷか夜空へのぼっていく絵文字 */
.float-emoji { position:absolute; bottom:-48px; font-size:1.35rem; opacity:0; pointer-events:none;
  animation:floatUp linear infinite; }
@keyframes floatUp {
  0%   { transform:translateY(0) rotate(-10deg); opacity:0; }
  10%  { opacity:0.8; }
  85%  { opacity:0.8; }
  100% { transform:translateY(-108vh) rotate(12deg); opacity:0; }
}

/* タップで絵文字がはじける花火 */
.burst { position:absolute; left:50%; top:50%; pointer-events:none; z-index:6; }
.burst-p { position:absolute; left:-8px; top:-8px; font-size:0.95rem; opacity:0;
  animation:burstFly 0.8s ease-out forwards; }
@keyframes burstFly {
  0%   { opacity:1; transform:rotate(var(--a,0deg)) translateY(-6px) scale(0.5); }
  100% { opacity:0; transform:rotate(var(--a,0deg)) translateY(-52px) scale(1.25); }
}

/* 商品を押した瞬間：絵文字がぷるん、「+1」が飛び出す */
.menu-item .m-emoji { display:inline-block; transition:transform 0.18s cubic-bezier(0.34,1.56,0.64,1); }
.menu-item:active .m-emoji { transform:scale(1.35) rotate(-8deg); }
.plus-one { position:absolute; top:4px; left:8px; font-size:0.85rem; font-weight:800; color:#ff6ec7;
  text-shadow:0 0 8px rgba(255,110,199,0.6); pointer-events:none;
  animation:plusUp 0.7s ease-out forwards; }
@keyframes plusUp {
  0%   { opacity:0; transform:translateY(4px) scale(0.7); }
  25%  { opacity:1; }
  100% { opacity:0; transform:translateY(-18px) scale(1.2); }
}

/* 夜は「注文する」ボタンがやわらかく光る */
body.night .btn-pay { box-shadow:0 0 20px rgba(255,209,102,0.35); }

/* ── 隠れた遊び心たち ────────────────────── */
/* 流れ星：光の尾を引いて斜めに流れる */
.shooting-star { position:absolute; width:2px; height:2px; border-radius:50%; background:#fff;
  box-shadow:0 0 8px 2px rgba(255,255,255,0.7); pointer-events:none;
  animation:shootStar 1.1s ease-out forwards; }
.shooting-star::after { content:""; position:absolute; right:0; top:0; width:90px; height:1.5px;
  background:linear-gradient(90deg, rgba(255,255,255,0.85), transparent);
  transform:rotate(0deg); transform-origin:right center; }
@keyframes shootStar {
  0%   { opacity:0; transform:translate(0,0) rotate(-30deg); }
  10%  { opacity:1; }
  100% { opacity:0; transform:translate(-190px,110px) rotate(-30deg); }
}

/* 星空の中の「本物の星」 */
.star-real { display:inline-block; animation:twinkle 2.4s ease-in-out infinite; }

/* 季節の飾り：ひらひら落ちてくる */
.fall-bit { position:absolute; top:-40px; pointer-events:none; opacity:0;
  animation:fallDown linear infinite; }
@keyframes fallDown {
  0%   { transform:translateY(0) rotate(-12deg); opacity:0; }
  8%   { opacity:0.9; }
  90%  { opacity:0.9; }
  100% { transform:translateY(108vh) rotate(14deg); opacity:0; }
}

/* 虹色の波（6色の点コンプリートのご褒美） */
.rainbow-wave { position:fixed; inset:0; z-index:99; pointer-events:none;
  background:linear-gradient(105deg, transparent 20%,
    rgba(232,117,155,0.5), rgba(255,221,130,0.5), rgba(159,220,174,0.5),
    rgba(143,194,238,0.5), rgba(184,172,224,0.5), transparent 80%);
  mix-blend-mode:screen; transform:translateX(-110%);
  animation:waveSweep 1.5s ease-in-out forwards; }
@keyframes waveSweep { to { transform:translateX(110%); } }

/* コナミコマンド成功中：世界が虹色に回る */
body.rainbow-mode .approot { animation:hueSpin 2.2s linear infinite; }
@keyframes hueSpin { to { filter:hue-rotate(360deg); } }

/* 星屑の尾（パソコンのカーソル用） */
.stardust { position:fixed; z-index:98; pointer-events:none; color:#fff;
  font-size:0.6rem; transform:translate(-50%,-50%);
  text-shadow:0 0 6px rgba(255,255,255,0.8);
  animation:dustFade 0.7s ease-out forwards; }
@keyframes dustFade { to { opacity:0; transform:translate(-50%,-160%) scale(0.4); } }

/* ロゴ長押しの隠しメッセージ */
.secret-toast { margin-top:10px; padding:8px 16px; border-radius:999px; font-size:0.85rem;
  background:rgba(255,255,255,0.12); color:#f2edff; border:1px solid rgba(255,255,255,0.25);
  animation:rise 0.4s ease both; }

/* お正月のひとこと */
.newyear { margin-top:12px; font-size:0.9rem; color:#ffd166;
  text-shadow:0 0 10px rgba(255,209,102,0.5); animation:rise 0.6s ease both; }

/* 読み込みの当たり（🍩） */
.spinner-donut { font-size:34px; margin:0 auto 12px; width:40px; text-align:center;
  animation:spin 0.9s linear infinite; }

/* ゾロ目・ワンコイン・節目のお祝いチップ */
.chip-pop { position:absolute; top:-10px; right:-4px; font-size:0.72rem; font-weight:800;
  background:rgba(255,209,102,0.18); color:#ffd166; border:1px solid rgba(255,209,102,0.5);
  border-radius:999px; padding:3px 10px; white-space:nowrap;
  animation:popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both; }
body:not(.night) .chip-pop { color:#a9791a; background:#faf0dc; border-color:#e8c14a88; }

/* チャージのお祝い（+¥◯◯がふわっと浮かぶ） */
.delta-up { position:absolute; margin-left:8px; font-size:1rem; font-weight:800; color:#74f7a1;
  text-shadow:0 0 10px rgba(116,247,161,0.5);
  animation:deltaFloat 1.7s ease-out forwards; }
@keyframes deltaFloat {
  0% { opacity:0; transform:translateY(6px); } 20% { opacity:1; }
  100% { opacity:0; transform:translateY(-22px); }
}

/* ランクアップまであと1回：バーが虹色に脈打つ */
.bar-rainbow { background:linear-gradient(90deg,#ff6ec7,#ffd166,#74f7a1,#4deeea,#b28dff,#ff6ec7) !important;
  background-size:300% 100% !important;
  animation:rainbowShift 2.4s linear infinite, barPulse 1.6s ease-in-out infinite; }
@keyframes barPulse { 0%,100% { opacity:1; } 50% { opacity:0.65; } }

/* 暗証番号を間違えたとき、入力欄がぷるぷる震える（2つで交互に鳴らして毎回動かす） */
@keyframes wobbleA { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-7px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(2px);} }
@keyframes wobbleB { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-7px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(2px);} }
.wobble-0 { animation:wobbleA 0.4s ease; }
.wobble-1 { animation:wobbleB 0.4s ease; }

/* 居眠りの💤 */
.sleepy { display:inline-block; margin-left:6px; animation:sleepFloat 2.4s ease-in-out infinite; }
@keyframes sleepFloat { 0%,100% { transform:translateY(0); opacity:0.5; } 50% { transform:translateY(-5px); opacity:1; } }

/* 🎁のもぞもぞ */
.wiggle { display:inline-block; animation:wiggleMove 10s ease-in-out infinite; }
@keyframes wiggleMove {
  0%,92%,100% { transform:rotate(0); }
  93% { transform:rotate(-12deg); } 95% { transform:rotate(10deg); } 97% { transform:rotate(-6deg); }
}

/* 「大人気！」タグ */
.hot-tag { position:absolute; bottom:6px; right:6px; font-size:0.65rem; font-weight:800;
  color:#ff6ec7; background:rgba(255,110,199,0.14); border:1px solid rgba(255,110,199,0.5);
  border-radius:999px; padding:2px 8px; animation:popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both; }

/* カートを空にした直後のひとこと */
.cleared-note { text-align:center; color:var(--ink3,#9a8f85); font-size:0.85rem; padding:6px 0;
  animation:clearFade 1.6s ease forwards; }
@keyframes clearFade { 0% { opacity:0; } 15% { opacity:1; } 75% { opacity:1; } 100% { opacity:0; } }

/* 注文した物が降ってくる紙吹雪 */
.confetti-box .confetti-e { position:absolute; top:-6px; font-size:1.1rem;
  animation:confettiFall 1.5s ease-in forwards; }

/* カードのくるっと一回転（ダブルタップ） */
.tilt.flip { animation:cardFlip 0.85s cubic-bezier(0.3,0.7,0.3,1); }
@keyframes cardFlip {
  0% { transform:perspective(900px) rotateY(0); }
  100% { transform:perspective(900px) rotateY(360deg); }
}

/* 夜空の色味が時間で変わる */
body.night .aurora { filter:blur(60px) saturate(1.9) hue-rotate(var(--nh,0deg)); }

/* ── ド派手な演出たち ────────────────────── */
/* ようこそのトースト（虹カーテンと一緒に出る） */
.welcome-toast { position:fixed; top:18%; left:50%; transform:translateX(-50%); z-index:100;
  padding:12px 26px; border-radius:999px; font-size:1.05rem; font-weight:700; white-space:nowrap;
  background:rgba(20,16,46,0.8); color:#fff; border:1px solid rgba(255,255,255,0.3);
  box-shadow:0 0 30px rgba(255,110,199,0.4); backdrop-filter:blur(8px);
  animation:toastInOut 1.9s ease both; pointer-events:none; }
@keyframes toastInOut {
  0% { opacity:0; transform:translateX(-50%) translateY(-14px); }
  15%,80% { opacity:1; transform:translateX(-50%) translateY(0); }
  100% { opacity:0; transform:translateX(-50%) translateY(-8px); }
}

/* ランクアップの祝祭 */
.rankup-ov { position:fixed; inset:0; z-index:120; pointer-events:none;
  background:rgba(10,8,26,0.55); animation:clearFade 3.4s ease forwards; }
.rankup-gem { position:absolute; top:-40px; font-size:1.5rem;
  animation:fallDown linear forwards; }
.rankup-box { position:absolute; top:38%; left:50%; transform:translate(-50%,-50%); text-align:center; }
.rankup-big { font-size:4.5rem; filter:drop-shadow(0 0 24px rgba(255,255,255,0.6)); }
.rankup-txt { font-size:1.8rem; font-weight:800; letter-spacing:0.1em; margin-top:6px;
  text-shadow:0 0 18px currentColor; animation:popIn 0.6s 0.2s cubic-bezier(0.34,1.56,0.64,1) both; }
.rankup-name { color:#fff; font-size:1rem; margin-top:6px; font-weight:700;
  animation:popIn 0.6s 0.45s cubic-bezier(0.34,1.56,0.64,1) both; }

/* 花火 */
.fw { position:absolute; width:0; height:0; z-index:60; pointer-events:none; }
.fw-p { position:absolute; left:-4px; top:-4px; width:8px; height:8px; border-radius:50%;
  opacity:0; animation:fwFly 1.3s ease-out forwards; box-shadow:0 0 10px currentColor; }
@keyframes fwFly {
  0%   { opacity:0; transform:rotate(var(--fa,0deg)) translateY(0) scale(0.4); }
  8%   { opacity:1; }
  100% { opacity:0; transform:rotate(var(--fa,0deg)) translateY(-86px) scale(1.1); }
}

/* 満月 */
.big-moon { position:absolute; top:6%; right:8%; font-size:5rem; pointer-events:none;
  filter:drop-shadow(0 0 40px rgba(255,236,170,0.55));
  animation:moonRise 3s ease both, moonGlow 5s 3s ease-in-out infinite alternate; }
@keyframes moonRise { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:none; } }
@keyframes moonGlow { from { filter:drop-shadow(0 0 30px rgba(255,236,170,0.4)); }
  to { filter:drop-shadow(0 0 55px rgba(255,236,170,0.75)); } }

/* 雷（2回ぴかっと光る） */
.lightning { position:fixed; inset:0; z-index:110; pointer-events:none;
  background:rgba(255,255,255,0.9); mix-blend-mode:screen;
  animation:flash 0.7s ease-out forwards; }
@keyframes flash {
  0% { opacity:0; } 6% { opacity:0.9; } 14% { opacity:0.05; }
  22% { opacity:0.6; } 40% { opacity:0; } 100% { opacity:0; }
}

/* ディスコタイム（あいさつ3連打で6秒） */
body.disco .approot { animation:hueSpin 1.2s linear infinite; }
body.disco .aurora { animation-duration:1.4s !important; opacity:1 !important; }
body.disco .star { animation-duration:0.35s !important; }
body.disco .dot-wave { animation-duration:0.5s !important; }

/* 虹の波紋（何もない所を押した場所から広がる） */
.ripple { position:fixed; z-index:50; pointer-events:none; width:12px; height:12px;
  margin-left:-6px; margin-top:-6px; border-radius:50%;
  border:2px solid rgba(255,255,255,0.7);
  box-shadow:0 0 14px rgba(255,110,199,0.6), inset 0 0 14px rgba(77,238,234,0.6);
  animation:rippleGrow 0.9s ease-out forwards; }
@keyframes rippleGrow {
  0% { opacity:0.9; transform:scale(0.4); }
  100% { opacity:0; transform:scale(9); }
}

/* 大きな🌈（6点コンプリートのご褒美に追加） */
.rainbow-big { position:fixed; top:40%; left:50%; z-index:100; font-size:5rem; pointer-events:none;
  transform:translate(-50%,-50%);
  animation:bigPop 1.5s cubic-bezier(0.34,1.56,0.64,1) both; }
@keyframes bigPop {
  0% { opacity:0; transform:translate(-50%,-50%) scale(0.2) rotate(-15deg); }
  30% { opacity:1; transform:translate(-50%,-50%) scale(1.15) rotate(5deg); }
  55% { transform:translate(-50%,-50%) scale(1) rotate(0); }
  80% { opacity:1; }
  100% { opacity:0; transform:translate(-50%,-50%) scale(1.1); }
}

/* ✅の後ろの放射光線 */
.rays { position:absolute; left:50%; top:45%; width:150px; height:150px; z-index:0;
  transform:translate(-50%,-50%); pointer-events:none; border-radius:50%;
  background:repeating-conic-gradient(rgba(255,209,102,0.25) 0deg 12deg, transparent 12deg 30deg);
  -webkit-mask:radial-gradient(circle, #000 30%, transparent 70%);
  mask:radial-gradient(circle, #000 30%, transparent 70%);
  animation:raysSpin 2.4s linear forwards, clearFade 2.4s ease forwards; }
@keyframes raysSpin { to { transform:translate(-50%,-50%) rotate(120deg); } }

/* 今日の一杯目：両脇からの祝砲 */
.cannon { position:absolute; bottom:0; font-size:1.2rem; opacity:0; pointer-events:none;
  animation:cannonFly 1.1s ease-out forwards; }
.cannon-l { left:4%; }
.cannon-r { right:4%; }
@keyframes cannonFly {
  0%   { opacity:0; transform:translate(0,0) rotate(0); }
  10%  { opacity:1; }
  100% { opacity:0; transform:translate(var(--cx,60px), var(--cy,-120px)) rotate(200deg); }
}

/* カードの入場：ぽんっと弾んで、光の帯が一度だけ横切る */
.card-in { animation:cardIn 0.55s cubic-bezier(0.34,1.56,0.64,1) both; }
@keyframes cardIn { 0% { opacity:0; transform:scale(0.85) translateY(18px); } 100% { opacity:1; transform:none; } }
.card-sheen { position:absolute; top:0; bottom:0; left:-40%; width:35%; pointer-events:none; z-index:3;
  background:linear-gradient(105deg, transparent, rgba(255,255,255,0.35), transparent);
  transform:skewX(-15deg); animation:sheenSweep 1.1s 0.4s ease both; }
@keyframes sheenSweep { to { left:120%; } }

/* ── 見て遊べるおもちゃたち ────────────────────── */
/* おもちゃの共通パネル */
.toy-panel { background:var(--card,#ffffff); border:1px solid var(--line,#e7ded3);
  border-radius:16px; padding:14px 16px; margin-top:10px; }
.toy-btn { width:100%; background:var(--panel2,#f6f1ea); color:var(--ink,#3d3630);
  border:1px solid var(--line,#e7ded3); border-radius:12px; padding:12px 16px;
  font-size:0.95rem; font-weight:700; cursor:pointer; font-family:inherit; }
.toy-btn:hover { filter:brightness(1.06); }
.toy-dim { opacity:0.7; font-weight:500; }
body.night .toy-btn { box-shadow:0 0 14px rgba(178,141,255,0.15); }

/* シャッフルの表示枠 */
.roulette-item { padding:8px 0; min-height:86px; }

/* 実績バッジの棚 */
.badge-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; }
.badge { display:flex; flex-direction:column; align-items:center; gap:2px;
  background:var(--panel2,#f6f1ea); border:1px solid var(--line,#e7ded3);
  border-radius:12px; padding:8px 4px; opacity:0.45; }
.badge-on { opacity:1; border-color:rgba(255,209,102,0.55);
  box-shadow:0 0 12px rgba(255,209,102,0.18); }
.badge-name { font-size:0.68rem; color:var(--ink2,#8a7f76); font-weight:700; text-align:center; }

/* 看板猫 */
.neko { position:absolute; top:8px; right:12px; font-size:1.5rem; cursor:pointer; z-index:4;
  display:inline-block; animation:nekoBob 4s ease-in-out infinite; }
@keyframes nekoBob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-3px); } }
.neko-say { position:absolute; right:0; top:-34px; white-space:nowrap; font-size:0.75rem; font-weight:700;
  background:var(--card,#ffffff); color:var(--ink,#3d3630); border:1px solid var(--line,#e7ded3);
  border-radius:999px; padding:4px 10px; animation:popIn 0.35s cubic-bezier(0.34,1.56,0.64,1) both, clearFade 1.6s ease forwards; }

/* きせかえボタン */
.theme-btn { background:var(--panel2,#f6f1ea); color:var(--ink2,#8a7f76);
  border:1px solid var(--line,#e7ded3); border-radius:999px; padding:6px 14px;
  font-size:0.8rem; font-weight:700; cursor:pointer; font-family:inherit; }

/* 気分チップ */
.mood-chip { background:var(--panel2,#f6f1ea); color:var(--ink2,#8a7f76);
  border:1px solid var(--line,#e7ded3); border-radius:999px; padding:8px 14px;
  font-size:0.85rem; font-weight:700; cursor:pointer; font-family:inherit; }
.mood-on { color:#ff6ec7; border-color:rgba(255,110,199,0.6);
  background:rgba(255,110,199,0.12); box-shadow:0 0 12px rgba(255,110,199,0.2); }
body:not(.night) .mood-on { color:#c2447e; background:#fdeaf3; }

/* カードの中に降り続けるキラキラ */
.srain-p { position:absolute; top:-14px; font-size:0.8rem; opacity:0; pointer-events:none; z-index:2;
  animation:srainFall linear infinite; }
@keyframes srainFall {
  0% { opacity:0; transform:translateY(0) rotate(0); }
  12% { opacity:0.8; }
  85% { opacity:0.8; }
  100% { opacity:0; transform:translateY(230px) rotate(50deg); }
}

/* 「視差効果を減らす」設定の端末では、飾りの動きを全部止める */
@media (prefers-reduced-motion: reduce) {
  .aurora, .rise, .bar-fill::after, .gem-pulse, .confetti-box i, .pop, .dot-wave,
  .btn-rainbow, .spinner, .neon-ch, .neon-flicker,
  .star, .float-emoji, .burst-p, .plus-one,
  .shooting-star, .star-real, .fall-bit, .rainbow-wave, .stardust, .spinner-donut,
  .chip-pop, .delta-up, .bar-rainbow, .sleepy, .wiggle, .hot-tag, .cleared-note,
  .confetti-box .confetti-e, .tilt.flip,
  .welcome-toast, .rankup-ov, .rankup-gem, .rankup-txt, .rankup-name, .fw-p,
  .big-moon, .lightning, .ripple, .rainbow-big, .rays, .cannon,
  .card-in, .card-sheen, .srain-p, .neko, .neko-say, .roulette-item { animation:none !important; }
  .star, .float-emoji, .shooting-star, .fall-bit, .stardust,
  .fw, .lightning, .ripple, .rays, .cannon, .card-sheen, .srain-p { display:none; }
  body.rainbow-mode .approot, body.disco .approot { animation:none !important; }
  .tilt { transform:none !important; }
  .holo-layer { display:none; }
  ::view-transition-old(root), ::view-transition-new(root) { animation:none; }
}

.btn-ghost { background:transparent; color:#8a7f76; border:1px solid #e7ded3; border-radius:12px; padding:12px 20px; font-size:0.95rem; font-weight:600; cursor:pointer; width:100%; font-family:inherit; transition:border-color 0.2s,color 0.2s; }
.btn-ghost:hover { border-color:#555; color:#8a7f76; }

.back-btn  { background:transparent; color:#9a8f85; border:none; padding:0; font-size:0.85rem; cursor:pointer; font-family:inherit; }
.close-btn { background:#f6f1ea; color:#8a7f76; border:none; border-radius:50%; width:28px; height:28px; cursor:pointer; font-size:0.85rem; display:flex; align-items:center; justify-content:center; flex-shrink:0; }

.ticket-card { border-radius:16px; padding:20px; margin-bottom:8px; }

/* ── お客様画面の切り替えタブ ──────────────────
   ここには今までスタイルが1つも当たっておらず、
   ブラウザ既定の四角いボタンがそのまま出ていた（画面で一番目につく粗）。
   iOS や Android で見慣れた「切り替えスイッチ」の形にする。 */
.tab-btn {
  flex:1; background:transparent; border:none; border-radius:9px;
  padding:10px 6px; font-size:0.95rem; font-family:inherit; font-weight:600;
  color:#9a8f85; cursor:pointer; white-space:nowrap;
  transition:background 0.18s, color 0.18s, box-shadow 0.18s;
}
.tab-btn:hover { color:#8a7f76; }
.tab-btn.active {
  background:#faf0dc; color:#b07c1e;
  box-shadow:0 1px 3px rgba(61,54,48,0.10);
}

/* 「別の番号を確認」のように、めったに押さないものは目立たせない。
   本題（残高・特典）と同じ強さで並んでいると、どれが主役か分からなくなる。 */
.btn-quiet {
  background:transparent; border:none; color:#a79b90; font-size:0.85rem;
  font-family:inherit; cursor:pointer; padding:10px; width:100%;
  text-decoration:underline; text-underline-offset:3px;
}
.btn-quiet:hover { color:#8a7f76; }
.bar-fill    { height:100%; border-radius:8px; transition:width 0.6s ease; }

.c-row { background:#ffffff; border:1px solid #e7ded3; border-radius:12px; padding:12px 14px; display:flex; align-items:center; gap:10px; cursor:pointer; transition:background 0.15s; }
.c-row:hover { background:#f6f1ea; }

.pill-btn      { background:#f6f1ea; color:#8a7f76; border:1px solid #e7ded3; border-radius:999px; padding:7px 14px; font-size:0.75rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-gold { background:#faf0dc; color:#b07c1e; border:1px solid #d3a94f44; border-radius:999px; padding:5px 12px; font-size:0.85rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-gold:hover { background:#f7e7c4; }
.pill-btn-dim  { background:#f6f1ea; color:#8a7f76; border:1px solid #e7ded3; border-radius:999px; padding:5px 12px; font-size:0.85rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-code { background:#e9f1fa; color:#3b7fb8; border:1px solid #8fbde044; border-radius:999px; padding:4px 10px; font-size:0.85rem; cursor:pointer; font-family:inherit; }
.pill-btn-hist { background:#f5eafa; color:#9c3fb5; border:1px solid #c98ada44; border-radius:999px; padding:4px 10px; font-size:0.85rem; cursor:pointer; font-family:inherit; }
.pill-btn-year { background:#e9f1fa; color:#2f9b85; border:1px solid #7fcdbd44; border-radius:999px; padding:4px 10px; font-size:0.85rem; cursor:pointer; font-family:inherit; }

.tag-use-btn { border:1px solid; border-radius:999px; padding:3px 10px; font-size:0.75rem; font-weight:700; background:transparent; cursor:pointer; font-family:inherit; white-space:nowrap; transition:opacity 0.15s; }
.tag-use-btn:hover { opacity:0.75; }

.menu-item { background:#ffffff; border:1px solid #e7ded3; border-radius:12px; padding:10px 6px; display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer; font-family:inherit; position:relative; transition:background 0.12s,border-color 0.12s,transform 0.08s; }
.menu-item:hover { background:#f6f1ea; border-color:#ddd3c6; }
.menu-item:active { transform:scale(0.94); }
.menu-item-active { background:#faf0dc !important; border-color:#d3a94f66 !important; }

.btn-pay   { flex:1; background:linear-gradient(135deg,#e0a94a,#f2cd72); color:#4a3a12; border:none; border-radius:12px; padding:13px; font-size:0.95rem; font-weight:700; cursor:pointer; font-family:inherit; }
.btn-clear { background:#f6f1ea; color:#8a7f76; border:1px solid #e7ded3; border-radius:12px; padding:13px 16px; font-size:0.95rem; cursor:pointer; font-family:inherit; }
.qty-btn   { background:#f6f1ea; color:#8a7f76; border:1px solid #ddd3c6; border-radius:8px; width:34px; height:34px; font-size:1rem; cursor:pointer; display:flex; align-items:center; justify-content:center; font-family:inherit; }
.qty-btn:hover { background:#ebe5dd; color:#3d3630; }

.preset-btn { flex:1; background:#ffffff; border:1px solid #e7ded3; border-radius:8px; color:#8a7f76; font-size:0.85rem; padding:8px 0; cursor:pointer; font-family:inherit; }
.preset-btn:hover { background:#f0ece6; color:#3d3630; }

.btn-save   { width:100%; background:linear-gradient(135deg,#e0a94a,#f2cd72); color:#4a3a12; border:none; border-radius:12px; padding:14px; font-size:1rem; font-weight:700; cursor:pointer; font-family:inherit; }
.btn-danger { width:100%; background:transparent; color:#c94a45; border:1px solid #e0a09b33; border-radius:12px; padding:11px; font-size:0.85rem; cursor:pointer; font-family:inherit; }
.btn-complete { flex:1; background:linear-gradient(135deg,#e2f2e6,#c9e6d0); color:#2c7344; border:1px solid #c9e2ce; border-radius:12px; padding:10px; font-size:0.95rem; font-weight:700; cursor:pointer; font-family:inherit; transition:background 0.15s; }
.btn-complete:hover { background:linear-gradient(135deg,#d3ead9,#bfe0c6); }
.btn-sm-gold { background:#faf0dc; color:#b07c1e; border:1px solid #d3a94f44; border-radius:8px; padding:7px 13px; font-size:0.85rem; cursor:pointer; font-family:inherit; }

/* ── POS の横幅 ──────────────────────────────
   POS はレジ台のタブレットやパソコンでも使う。
   これまでは画面がどれだけ広くても中央480pxしか使わず、
   商品名が「ホットヘーゼルナッ／ツコーヒー」のように不自然に折り返し、
   メニュー33品が1行ずつ縦に並んで延々スクロールが要る状態だった。
   広い画面では横に並べて、1画面で見渡せるようにする。
   ※ お客様のチケット画面はスマホ前提なので、そちらの幅は変えない。 */
.pos-page { max-width:480px; margin:0 auto; padding:24px 16px; }
.pos-list { display:grid; grid-template-columns:1fr; gap:8px; align-items:start; }
@media (min-width:820px) {
  .pos-page { max-width:1080px; }
  .pos-list { grid-template-columns:repeat(2,1fr); }
}
@media (min-width:1240px) {
  .pos-list { grid-template-columns:repeat(3,1fr); }
}
/* 商品ボタンは、幅に合わせて自然に列数が増える形にする（3列固定をやめる） */
.menu-grid-auto { display:grid; grid-template-columns:repeat(auto-fill,minmax(112px,1fr)); gap:8px; }

.pos-tab { flex:1; background:transparent; border:none; color:#9a8f85; padding:10px 0; font-size:0.85rem; cursor:pointer; font-family:inherit; border-bottom:2px solid transparent; transition:color 0.15s,border-color 0.15s; }
.pos-tab-active { color:#b07c1e !important; border-bottom:2px solid #d3a94f !important; font-weight:700; }

.staff-select-btn { display:flex; align-items:center; gap:10px; width:100%; background:#ffffff; border:1px solid #e7ded3; border-radius:12px; padding:14px 16px; cursor:pointer; font-family:inherit; color:#3d3630; font-size:0.95rem; transition:background 0.15s,border-color 0.15s; }
.staff-select-btn:hover { background:#f6f1ea; border-color:#e7ded3; }
.staff-select-btn.manager { border-color:#d3a94f33; }
.staff-select-btn.manager:hover { background:#faf0dc; border-color:#d3a94f66; }

.btn-tiny-edit { background:#f6f1ea; border:1px solid #e7ded3; border-radius:8px; padding:8px 12px; font-size:0.85rem; cursor:pointer; transition:background 0.15s; flex-shrink:0; }
.btn-tiny-edit:hover { background:#f0ece6; }
.btn-tiny-del  { background:#fbebea; border:1px solid #f0d6d4; border-radius:8px; padding:8px 12px; font-size:0.85rem; cursor:pointer; transition:background 0.15s; flex-shrink:0; }
.btn-tiny-del:hover { background:#f7dcda; }

.flash { position:absolute; right:0; top:-4px; font-size:1rem; font-weight:800; animation:flashPop 1s ease forwards; pointer-events:none; white-space:nowrap; }
.flash-add { color:#3e9a5c; }
.flash-sub { color:#c94a45; }
@keyframes flashPop {
  0%   { opacity:0; transform:translateY(0) scale(0.7); }
  20%  { opacity:1; transform:translateY(-10px) scale(1.15); }
  70%  { opacity:1; transform:translateY(-14px) scale(1.0); }
  100% { opacity:0; transform:translateY(-22px) scale(0.9); }
}
`;
