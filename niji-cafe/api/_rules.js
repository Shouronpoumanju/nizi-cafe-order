// ══════════════════════════════════════════
//  虹カフェ 共通ルール
//  画面（src/App.jsx）とサーバー（api/*.js）の両方が、この1つのファイルを読む。
//  ランク・特典・チケット・行事・日付の決まりごとは、必ずここに書くこと。
//  （以前は同じ決まりが画面・サーバー・テスト用の3か所に書き写されていて、
//    1か所だけ直すと「画面では使えるのにサーバーが断る」ずれが起きていた）
//
//  ※ ファイル名が _ で始まるので、Vercel はこれを窓口（URL）として公開しない。
//  ※ ブラウザでも動くように、Node 専用の機能（crypto など）は使わないこと。
// ══════════════════════════════════════════

// ── お金の決まり ───────────────────────────
// チャージは1回 ¥2,200（¥2,000 ぶんの代金で ¥2,200 使える）。1回のチャージで「今年の回数」が1つ増える。
export const CHARGE_AMOUNT = 2200;

// ── 日付（すべて日本時間で判定する） ─────────────────
// サーバー（Vercel）は世界標準時で動いているので、new Date().getMonth() などをそのまま使うと
// 毎月1日の0〜9時が「先月」になってしまう。日付の判定は必ずここの関数を使う。
const JST = 9 * 3600 * 1000;
const jd = (t) => new Date((t == null ? Date.now() : t) + JST);
const p2 = (n) => String(n).padStart(2, "0");
export const jstYear     = (t) => jd(t).getUTCFullYear();
export const jstMonthNum = (t) => jd(t).getUTCMonth() + 1;
// "2026-10"（特典の「今月」）
export const jstMonth    = (t) => { const d = jd(t); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`; };
export const currentMonth = () => jstMonth();
// "2026/10/23"（敬老の日などの日付比較。0は付けない）
export const jstToday    = (t) => { const d = jd(t); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
// "2026-10-23"（締めの集計で使う日の名前）
export const jstDayKey   = (t) => { const d = jd(t); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
// "2026/10/23 9:05:03"（履歴の date。いままでの toLocaleString("ja-JP") と同じ形）
export const jstStamp    = (t) => { const d = jd(t); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };

// ── ランク ─────────────────────────────────
// benefit.type:
//   "monthly"         → 毎月1回リセット
//   "always_discount" → 毎回自動割引（amount: 固定額 or "half"）
export const RANKS = [
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

export const NO_RANK = {
  name:"ランクなし", min:0, color:"var(--ink3,#9a8f85)", gem:"−",
  bg:"linear-gradient(135deg,#f4f1ec,#e8e2da)", glow:"#444",
  benefit:{ type:"none", desc:"ランクなし", icon:"−" },
};

export function getRank(p) {
  if (p < 2) return NO_RANK;
  let r = RANKS[0];
  for (const x of RANKS) if (p >= x.min) r = x;
  return r;
}
// 昨年・今年の高い方のランクを返す
export function getEffectiveRank(customer) {
  const r1 = getRank(customer.rankBasis ?? 0);
  const r2 = getRank(customer.currentYearPurchases ?? 0);
  const i1 = RANKS.findIndex(r => r.name === r1.name);
  const i2 = RANKS.findIndex(r => r.name === r2.name);
  return i2 > i1 ? r2 : r1;
}
export function nextRank(p) { for (const x of RANKS) if (p < x.min) return x; return null; }

// ── 今月の特典 ───────────────────────────────
// トッピング最大選択数（ランク別）
export function getToppingMax(rank) {
  if (!rank) return 0;
  return rank.name==="ブロンズ"?1 : rank.name==="シルバー"?2 : rank.name==="ゴールド"?3 : 0;
}
// 今月の残りトッピング使用可能数
export function getToppingAvailable(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return 0;
  if (customer.toppingRemainingMonth !== currentMonth()) return max;
  return Math.max(0, Math.min(max, customer.toppingRemaining ?? max));
}
// 非トッピング特典が使用済みか
export function isBenefitUsed(customer) {
  return customer.benefitUsedMonth === currentMonth();
}
// トッピング特典が完全使用済みか（0回になった）
export function isToppingFullyUsed(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return false;
  if (customer.toppingRemainingMonth !== currentMonth()) return false;
  return (customer.toppingRemaining ?? max) === 0;
}
// always_discount の割引額を計算
export function calcDiscount(rank, total) {
  if (!rank || !rank.benefit || rank.benefit.type !== "always_discount") return 0;
  if (rank.benefit.amount === "half") return Math.floor(total / 2);
  return Math.min(rank.benefit.amount, total);
}

// 特典で無料にできるトッピングから、タピオカは外す（のあさんの指示・2026-09-16）。
export const isTapioca = (item) => /タピオカ/.test(String((item && item.name) || ""));
export const isTopping = (item) => !!item && item.category === "トッピング";

// ── 値段の計算（アプリの注文・レジの会計の両方で同じ計算） ─────────
// items: [{ id, qty }]  … 値段はメニューから引き直す（画面から届いた値段は信じない）
// staffRate: その人に紐づいたスタッフ割引の率（%）。なければ 0
// 戻り値: { lines, subtotal, discount, staffDiscount, total, isSpecial, error }
export function priceItems({ menu, items, customer, staffRate = 0, allowSoldOut = false }) {
  const byId = new Map((Array.isArray(menu) ? menu : []).filter(Boolean).map((m) => [String(m.id), m]));
  const lines = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const m = byId.get(String(it.id));
    if (!m) return { error: `メニューにない品が含まれています（${it.name || it.id}）` };
    if (!allowSoldOut && m.soldOut) return { error: `「${m.name}」は本日売り切れです。別の品をお選びください`, soldOut: true };
    const qty = Math.floor(Number(it.qty) || 0);
    if (qty < 1 || qty > 30) return { error: "数量が正しくありません" };
    const price = Math.max(0, Math.floor(Number(m.price) || 0));
    lines.push({ ...m, price, qty });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const rank = customer ? getEffectiveRank(customer) : NO_RANK;
  const isSpecial = !!(customer && customer.isSpecial);
  const discount = isSpecial ? 0 : calcDiscount(rank, subtotal);
  const staffDiscount = (!isSpecial && staffRate > 0) ? Math.floor(subtotal * staffRate / 100) : 0;
  const total = isSpecial ? 0 : Math.max(0, subtotal - discount - staffDiscount);
  return { lines, subtotal, discount, staffDiscount, total, isSpecial, rank };
}

// ── 持ち越しの特典チケット（会員データ bonusTickets） ──────────
// { id, rankName, uses, kind:"topping"|"drink", perUse, remaining, label, issuedAt, usedAt, log:[] }
export const TICKET_RANKS = ["ブロンズ", "シルバー", "ゴールド", "プラチナ", "チタン", "サファイア"];
export function makeTicket(rankName, uses) {
  const r = RANKS.find((x) => x.name === rankName);
  if (!r || !(uses > 0)) return null;
  const perUse = getToppingMax(r);
  const kind = perUse > 0 ? "topping" : "drink";
  const total = kind === "topping" ? perUse * uses : uses;
  return { id: "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
           rankName, uses, kind, perUse: kind === "topping" ? perUse : 1, remaining: total,
           label: `${rankName}特典 ${uses}回分`, desc: r.benefit.desc, icon: r.benefit.icon, gem: r.gem, color: r.color,
           issuedAt: jstStamp(), usedAt: null, log: [] };
}
export const unusedTickets = (c) => (Array.isArray(c && c.bonusTickets) ? c.bonusTickets : []).filter((t) => t && t.id && !t.usedAt && (Number(t.remaining) || 0) > 0);
export const ticketToppingsOf = (c) => unusedTickets(c).filter((t) => t.kind === "topping").reduce((s, t) => s + (Number(t.remaining) || 0), 0);
// n個ぶんのトッピングを、古い券から順に引き当てる → [{id, n}]
export function allocTicketToppings(c, n) {
  const use = [];
  for (const t of unusedTickets(c).filter((t) => t.kind === "topping")) {
    if (n <= 0) break;
    const k = Math.min(n, Number(t.remaining) || 0);
    if (k > 0) { use.push({ id: t.id, n: k }); n -= k; }
  }
  return use;
}
export function applyTicketUse(c, use, orderId) {
  const now = jstStamp();
  const map = new Map((use || []).map((u) => [String(u.id), Number(u.n) || 0]));
  return { ...c, bonusTickets: (c.bonusTickets || []).map((t) => {
    if (!t || !map.has(String(t.id))) return t;
    const rem = Math.max(0, (Number(t.remaining) || 0) - map.get(String(t.id)));
    return { ...t, remaining: rem, usedAt: rem === 0 ? now : null, log: [...(t.log || []), { orderId: orderId || null, n: map.get(String(t.id)), at: now }].slice(-30) };
  }) };
}
export function restoreTicketUse(c, use) {
  const map = new Map((use || []).map((u) => [String(u.id), Number(u.n) || 0]));
  return { ...c, bonusTickets: (c.bonusTickets || []).map((t) => {
    if (!t || !map.has(String(t.id))) return t;
    return { ...t, remaining: (Number(t.remaining) || 0) + map.get(String(t.id)), usedAt: null };
  }) };
}
export const ticketRemainText = (t) => t.kind === "topping" ? `🧁 トッピング無料 あと${t.remaining}個` : `${t.icon || "🍹"} ${t.desc || "1杯無料"} あと${t.remaining}杯`;

// ── 🎂 誕生月の一杯 ─────────────────────────────
export function isBirthdayTicketActive(c) {
  if (!c || !c.birthMonth) return false;
  if (Number(c.birthMonth) !== jstMonthNum()) return false;
  return String(c.birthdayUsedYear || "") !== String(jstYear());
}

// ── 🎁 敬老の日 特別プレゼント（2026-09-20・対象の方だけ・お一人1回） ──────
// 対象者は名前で指定（のあさんの指示）。使うと会員データに keiroGiftUsed="2026" が入る。
export const KEIRO = {
  year: "2026", date: "2026/9/20", names: ["えつこ", "ちえこ", "ゆうこ", "まきやま", "よこやま"],
  drink: "敬老の日 スペシャルドリンク",
};
export const keiroIsDay  = () => jstToday() === KEIRO.date;
export const keiroTarget = (c) => !!c && KEIRO.names.includes(String(c.name || "").trim());
export const keiroUsed   = (c) => String((c && c.keiroGiftUsed) || "") === KEIRO.year;

// ── 🎁 特別チケット（のあさんが贈る、期限つきの無料券） ─────────────
// 「お名前で対象を決める」方式。1枚＝お好きなドリンク1杯＋トッピング1つまで無料（タピオカもOK）。
// 使った枚数は会員データの specialUsed（例 { win_2026: 2 }）。増やせるのはサーバーだけ。
export const SPECIALS = [
  { id: "sp_bday_2026", icon: "🎂", cls: "bday", title: "お誕生日 特別チケット",
    n: 1, until: "2027/9/30", names: ["まり", "えがわ", "まつおたかし", "よこやま"],
    note: "お誕生日おめでとうございます。いつもありがとうございます！",
    foot: "※ いつもの誕生月の一杯とは別のプレゼントです" },
  { id: "win_2026", icon: "🏆", cls: "win", title: "優勝チケット",
    n: 5, until: "2027/9/30", names: ["よこやま"],
    note: "教会のレクリエーション 優勝おめでとうございます！",
    foot: "※ 1枚につきドリンク1杯。5枚あるので5杯ぶんです" },
];
export const SPECIAL_BY_ID = (id) => SPECIALS.find((s) => s.id === String(id)) || null;
export const specialUsedN = (c, id) => Number(((c && c.specialUsed) || {})[String(id)]) || 0;
export const specialLeft  = (c, sp) => Math.max(0, (Number(sp.n) || 0) - specialUsedN(c, sp.id));
export const specialIsTarget = (c, sp) => !!c && sp.names.includes(String(c.name || "").trim());
// 有効期限は「その日の終わりまで」。日本時間で見る。
export const specialExpired = (sp) => {
  const [y, m, d] = String(sp.until).split("/").map(Number);
  const now = jd();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return today > Date.UTC(y, m - 1, d);
};
export const mySpecials    = (c) => SPECIALS.filter((sp) => specialIsTarget(c, sp) && !specialExpired(sp) && specialLeft(c, sp) > 0);
export const allSpecialsOf = (c) => SPECIALS.filter((sp) => specialIsTarget(c, sp) && !specialExpired(sp));

// ── 年が変わったときの切り替え ─────────────────────────
// 1/1 になったら「今年の回数」を0に戻し、去年の回数を「ランク基準値」に移す。
// （ランクは昨年・今年の高い方で決まるので、年が変わってもすぐには下がらない）
// サーバーが毎晩3時（日本時間）に全員ぶんを切り替える。画面は表示のためだけに同じ計算をする。
export function checkYearRollover(c, year = jstYear()) {
  if (!c) return c;
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
        performer:"システム", date: jstStamp(),
      }, ...(c.history || [])].slice(0, 60),
    };
  }
  return Array.isArray(c.yearlyStats) ? c : { ...c, yearlyStats: [] };
}

// 履歴の欄（history）は1人60件まで。新しいものを先頭に足す。
export const pushHistory = (c, entries) => ({
  ...c, history: [...(Array.isArray(entries) ? entries : [entries]), ...(c.history || [])].slice(0, 60),
});

// アプリの版。Vercel が公開するたびに変わる（同じ公開の画面とサーバーは同じ値になる）。
// 開きっぱなしの古い画面に「新しい版があります」と知らせるために使う。
export const shortVer = (s) => String(s || "").slice(0, 7);
