// ══════════════════════════════════════════
//  POST /api/data
//  データベースへの読み書きの窓口。
//  ログイン証（トークン）を確認し、その人が触ってよい範囲だけを通します。
//
//  2026-10 の作り直しで、お金と特典の計算はすべてサーバーが行うようにした。
//    ・残高を増やす・減らすのは、この中の決まった窓口だけ（できました／レジ会計／チャージ／
//      チャージ取消／残高の手修正／会員の登録・削除）。画面から「残高はいくら」と送っても通らない。
//    ・「いくら引くか」はサーバーが今の残高から計算するので、2台の端末で同時に操作しても
//      片方の変更が消えない（読んで・変えて・書く を ETag で守る → _lib.js の fbTxn）。
//    ・注文の金額・割引・無料の品は、サーバーがメニューと会員データから計算し直す。
//    ・特典（トッピング・今月の1杯・チケット・誕生日など）を使う／戻すのもサーバーが行い、
//      注文に「何を使ったか（consumed）」を残すので、取り消したときに正確に戻せる。
//    ・お金が動いたら、サーバーが消えない台帳（sales_log / money_log）に必ず書く。
// ══════════════════════════════════════════
import crypto from "node:crypto";
import { envReady, fbGet, fbPut, fbPost, fbTxn, TxnAbort, asList, readToken, sameSecret, hashSecret, looksHashed,
         send, readBody, bearer, pinVer, clientIp, guardBlocked, guardFail, ssLink } from "./_lib.js";
import * as R from "./_rules.js";

const K = {
  cust: "cafe_v4_customers", orders: "cafe_v4_orders", menu: "cafe_v4_menu",
  dd: "cafe_v4_designated_drink", vip: "cafe_v4_vip_gift_drink",
  staff: "cafe_v4_staff_accounts", mgr: "cafe_v4_manager_accounts",
  sales: "cafe_v4_sales_log", money: "cafe_v4_money_log", archive: "cafe_v4_orders_archive",
};

// 誰でも読んでよいもの（お店の掲示物にあたるもの）
const PUBLIC_READ = [K.menu, K.dd, K.vip];
// スタッフが読んでよいもの
const STAFF_READ = [K.cust, K.orders, K.archive, K.menu, K.dd, K.vip, "cafe_v4_cash_orders", "cafe_v4_payment_today",
                    K.sales, K.money, "cafe_v4_archive_log"];
// スタッフが「まるごと保存」してよいもの（お金に関係しないものだけ）
const STAFF_SET = [K.menu, K.dd, K.vip, "cafe_v4_payment_today"];
// マネージャーだけが書き換えてよいもの
const MANAGER_ONLY = [K.staff, K.mgr];
// 以前は「まるごと保存」していたが、取り合いで記録が消えるので専用の窓口に置き換えたもの
const RETIRED_SET = [K.cust, K.orders, K.archive, "cafe_v4_cash_orders"];
const RELOAD_MSG = "アプリが新しくなりました。画面を再読み込みしてください（画面を下に引っぱる、または⟳ボタン）";

// お客様ひとりぶんの「遊びの記録」（実績・回数・きせかえ等）。cafe_v4_play/<会員ID>
// 残高やランクには一切関係しない場所なので、お客様本人が自由に書いてよい（ただし上限つき）。
const PLAY_KEY_RE = /^cafe_v4_play\/[A-Za-z0-9_-]{1,40}$/;
const PLAY_MAX_KEYS = 120;
const PLAY_MAX_BYTES = 8000;
function mergePlayValue(k, a, b) {
  if (a == null || a === "") return b == null ? a : String(b);
  if (b == null || b === "") return a;
  a = String(a); b = String(b);
  if (a === b) return a;
  if (k.startsWith("niji_cnt_") || k.startsWith("niji_hall_")) return String(Math.max(Number(a) || 0, Number(b) || 0));
  if (k.endsWith("_days") || k.endsWith("_seen")) {
    return [...new Set([...a.split(","), ...b.split(",")].filter(Boolean))].slice(-60).join(",");
  }
  if (a === "1" || b === "1") return "1";
  return b;
}
function cleanPlay(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v)) {
    if (!/^niji_[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof val !== "string" || val.length > 400) continue;
    out[k] = val;
    if (Object.keys(out).length >= PLAY_MAX_KEYS) break;
  }
  return out;
}


// ── 小さな道具 ───────────────────────────────
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : asList(v));
const sid = (v) => String(v ?? "");
const fail = (status, error, extra) => { throw new TxnAbort(status, { error, ...(extra || {}) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
const ORDER_WINDOW_QUERY = `orderBy=%22%24key%22&limitToFirst=60`;
const LOG_QUERY = (n) => `orderBy=%22%24key%22&limitToLast=${n}`;

// 消えない台帳に1件書く。失敗してもお店は止めないが、記録に残す。
async function ledger(key, entry) {
  try { await fbPost(key, { ...entry, at: R.jstStamp(), atISO: nowISO(), day: R.jstToday() }); return true; }
  catch (e) { console.error("台帳への記録に失敗", key, e); return false; }
}

// 会員1人を、取り合いに強いやり方で書き換える。
// fn(今の会員, 全員) は { customer: 新しい会員, result } を返す。やめるときは fail(...) を投げる。
async function custTxn(id, fn) {
  return fbTxn(K.cust, async (cur) => {
    const list = arr(cur);
    const i = list.findIndex((c) => sid(c.id) === sid(id));
    if (i < 0) fail(404, "会員が見つかりません");
    const out = await fn({ ...list[i] }, list);
    list[i] = out.customer;
    return { value: list, result: { customer: out.customer, ...(out.result || {}) } };
  });
}
// 注文の一覧を、取り合いに強いやり方で書き換える。fn(一覧) は { list, result } を返す。
async function ordersTxn(fn) {
  return fbTxn(K.orders, async (cur) => {
    const out = await fn(arr(cur));
    if (out && out.noWrite) return { abort: out.result };
    return { value: out.list, result: out.result };
  });
}

// 二重送信の防止：画面が操作ごとに付ける番号（reqId）。同じ番号の操作がもう履歴にあれば、やり直さない。
const reqIdOf = (v) => (/^[A-Za-z0-9_-]{6,40}$/.test(sid(v && v.reqId)) ? sid(v.reqId) : null);
const alreadyDone = (c, reqId) => !!reqId && (c.history || []).some((h) => h && h.reqId === reqId);

// その会員に紐づいたスタッフ割引（%）。紐づいていなければ 0
async function staffRateFor(customerId) {
  const [staff, mgrs] = await Promise.all([fbGet(K.staff), fbGet(K.mgr)]);
  const linked = [...arr(staff), ...arr(mgrs)].find((s) => s.linkedCustomerId && sid(s.linkedCustomerId) === sid(customerId));
  return linked ? { rate: Number(linked.discountRate ?? 10) || 0, name: linked.name } : { rate: 0, name: null };
}

// マネージャーの確認。マネージャー本人ならそのまま、スタッフならマネージャーのパスワードが必要。
// 戻り値は「承認した人の名前」（台帳に残す）。
async function needManager(me, mgrPw, ip) {
  if (me.r === "manager") return me.name || "マネージャー";
  if (me.r === "staff" && mgrPw) {
    if (await guardBlocked("mgrpw", ip)) fail(429, "パスワードを何度もまちがえたため、15分ほど待ってからお試しください");
    const mgrs = arr(await fbGet(K.mgr));
    const m = mgrs.find((a) => a && sameSecret(a.password, mgrPw));
    if (m) return m.name || "マネージャー";
    await guardFail("mgrpw", ip);
    await sleep(400);
    fail(403, "マネージャーパスワードが違います");
  }
  fail(403, "マネージャーの確認が必要です");
}
async function isChiefStaff(me) {
  if (me.r !== "staff") return false;
  const staff = arr(await fbGet(K.staff));
  const a = staff.find((s) => sid(s.id) === sid(me.id));
  return !!(a && a.isChief);
}

// 品名の一覧（履歴・台帳に残す文字）
function itemText(o) {
  const sp = R.SPECIAL_BY_ID(o.specialGiftId);
  return [
    ...(o.items || []).map((i) => `${i.name}×${i.qty}`),
    ...(o.benefitItems || []).map((i) => `${i.name}(特典)`),
    ...(o.birthdayItems || []).map((i) => `${i.name}(${o.secretTicketId ? "🎄シークレット" : o.specialGiftId ? (sp ? sp.title : "特別チケット") : "🎂誕生日"})`),
    ...(o.makaiItem ? [`${o.makaiItem.name}(賄い)`] : []),
  ].join(", ");
}
// その注文で残高から引く金額
const payOf = (o) => (o.isCash ? Number(o.total) || 0 : (o.isSpecial || o.isVipGift || o.isKeiroGift) ? 0 : Math.max(0, Number(o.total) || 0));
// 注文の種類（同じ人・同じ種類の未処理注文は、新しい注文で置き換える）
const kindOf = (o) => (o.isVipGift ? "vip" : o.isKeiroGift ? "keiro" : "normal");

// ══════════════════════════════════════════
//  特典の「使う」と「戻す」
// ══════════════════════════════════════════
// consumed（注文に残す「この注文で使ったもの」）:
//   { month, topMonthly, tickets:[{id,n}], benefitMonth, birthdayYear, specialId, keiroYear, vipMonth, secretId }
const markSecret = (c, id, used, orderId) => ({
  ...c, giftTickets: (Array.isArray(c.giftTickets) ? c.giftTickets : []).map((t) => (t && sid(t.id) === sid(id)
    ? (used ? { ...t, usedAt: R.jstToday(), usedOrderId: orderId || null } : { ...t, usedAt: null, usedOrderId: null })
    : t)),
});
function applyConsumed(c, k, orderId) {
  let x = { ...c };
  if (k.secretId) x = markSecret(x, k.secretId, true, orderId);
  if (k.topMonthly > 0) {
    const max = R.getToppingMax(R.getEffectiveRank(x));
    const avail = R.getToppingAvailable(x, R.getEffectiveRank(x));
    x.toppingRemaining = Math.max(0, Math.min(max, avail) - k.topMonthly);
    x.toppingRemainingMonth = k.month;
  }
  if (k.tickets && k.tickets.length) x = R.applyTicketUse(x, k.tickets, orderId);
  if (k.benefitMonth) x.benefitUsedMonth = k.benefitMonth;
  if (k.birthdayYear) x.birthdayUsedYear = k.birthdayYear;
  if (k.specialId) x.specialUsed = { ...(x.specialUsed || {}), [k.specialId]: R.specialUsedN(x, k.specialId) + 1 };
  if (k.keiroYear) x.keiroGiftUsed = k.keiroYear;
  if (k.vipMonth) x.vipGiftUsedMonth = k.vipMonth;
  return x;
}
function restoreConsumed(c, k) {
  if (!k) return c;
  let x = { ...c };
  if (k.topMonthly > 0 && x.toppingRemainingMonth === k.month) {
    // 月が変わっていれば今月ぶんは満タンに戻っているので、戻すものはない
    const max = R.getToppingMax(R.getEffectiveRank(x));
    if (max > 0) x.toppingRemaining = Math.min(max, (x.toppingRemaining ?? max) + k.topMonthly);
  }
  if (k.tickets && k.tickets.length) x = R.restoreTicketUse(x, k.tickets);
  if (k.benefitMonth && x.benefitUsedMonth === k.benefitMonth) x.benefitUsedMonth = null;
  if (k.birthdayYear && sid(x.birthdayUsedYear) === sid(k.birthdayYear)) x.birthdayUsedYear = null;
  if (k.specialId) x.specialUsed = { ...(x.specialUsed || {}), [k.specialId]: Math.max(0, R.specialUsedN(x, k.specialId) - 1) };
  if (k.keiroYear && sid(x.keiroGiftUsed) === sid(k.keiroYear)) x.keiroGiftUsed = null;
  if (k.vipMonth && x.vipGiftUsedMonth === k.vipMonth) x.vipGiftUsedMonth = null;
  if (k.secretId) x = markSecret(x, k.secretId, false);
  return x;
}
// 作り直し前（2026-10 以前）の画面が出した注文には consumed が無い。
// 当時の画面が取り消しのときにしていた戻し方を、そのまま再現する。
// 注文の日時（"2026/10/23 9:05:03"・日本時間）をミリ秒に。読めなければ 0
const stampToMs = (str) => {
  const m = /(\d{4})\/(\d{1,2})\/(\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(sid(str));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)) : 0;
};
function legacyConsumed(o) {
  if (o.consumed) return o.consumed;
  // 注文した日の月・年で戻す（月をまたいでから取り消したとき、今月の特典を消さないため）
  const t = stampToMs(o.createdAt) || undefined;
  const month = R.jstMonth(t), year = String(R.jstYear(t));
  const k = { month };
  if (o.isVipGift) k.vipMonth = month;
  if (o.isKeiroGift) k.keiroYear = R.KEIRO.year;
  if (o.isBirthdayGift) k.birthdayYear = year;
  if (o.specialGiftId) k.specialId = sid(o.specialGiftId);
  if (o.usedBenefit && !o.isVipGift && !o.isKeiroGift) {
    const items = o.benefitItems || [];
    if (items.length && items.every(R.isTopping)) {
      const fromTickets = (o.ticketToppingUse || []).reduce((s, u) => s + (Number(u.n) || 0), 0);
      k.topMonthly = Math.max(0, (o.usedToppingCount || items.length) - fromTickets);
      k.tickets = o.ticketToppingUse || [];
    } else {
      k.benefitMonth = month;
    }
  }
  return k;
}

// ══════════════════════════════════════════
//  お客様の注文を、サーバーで作り直す（金額・割引・無料の品・使う特典）
// ══════════════════════════════════════════
// 画面から届いた注文のうち信じるのは「どの品を何個」「どの特典を使いたいか」だけ。
// 値段・割引・合計・無料の印・使うチケットの枚数は、ここで決め直す。
// c は「置き換える未処理注文の特典を戻したあと」の会員データ。
function buildOrder({ input, c, menu, dd, vipDrink, staffLink }) {
  const month = R.jstMonth();
  const year = String(R.jstYear());
  const rank = R.getEffectiveRank(c);
  const menuById = new Map(arr(menu).map((m) => [sid(m.id), m]));
  const freeItem = (it) => {
    const m = menuById.get(sid(it && it.id));
    if (!m) fail(400, `メニューにない品が含まれています（${(it && it.name) || ""}）`);
    if (m.soldOut) fail(409, `「${m.name}」は本日売り切れです。別の品をお選びください`);
    return { ...m, price: 0, qty: 1 };
  };
  const base = {
    orderId: /^ord_\d{6,20}$/.test(sid(input.orderId)) ? sid(input.orderId) : `ord_${Date.now()}`,
    customerId: c.id, customerName: c.name,
    rankName: rank.name, rankColor: rank.color, rankGem: rank.gem,
    status: "pending", createdAt: R.jstStamp(), createdAtISO: nowISO(),
    staffLinked: staffLink.name || null,
    items: [], benefitItems: [], birthdayItems: [],
    subtotal: 0, discount: 0, staffDiscount: 0, total: 0,
    usedBenefit: false, usedToppingCount: 0, ticketToppingUse: [],
    isBirthdayGift: false, specialGiftId: null, isSpecial: !!c.isSpecial,
  };
  const k = { month };

  // 🎁 敬老の日
  if (input.isKeiroGift) {
    if (!R.keiroTarget(c)) fail(403, "このプレゼントの対象ではありません");
    if (!R.keiroIsDay()) fail(400, `このプレゼントは${R.KEIRO.date.split("/").slice(1).join("月")}日だけ受け取れます`);
    if (R.keiroUsed(c)) fail(409, "すでに受け取り済みです");
    const hotIce = /ICE|アイス/i.test(JSON.stringify(input.benefitItems || [])) ? "ICE" : "Hot";
    k.keiroYear = R.KEIRO.year;
    return { order: { ...base, rankName: "敬老の日", rankColor: "#ff6ec7", rankGem: "🎁", isKeiroGift: true,
      benefitItems: [{ id: "keiro" + R.KEIRO.year, name: `${R.KEIRO.drink}（${hotIce}）`, emoji: "🎁", price: 0, qty: 1 }],
      consumed: k }, consumed: k };
  }
  // ⭐ VIPプレゼント（毎月1杯）
  if (input.isVipGift) {
    if (!c.isVIP) fail(403, "VIP会員ではありません");
    if (c.vipGiftUsedMonth === month) fail(409, "今月のプレゼントは受け取り済みです");
    if (!vipDrink || !vipDrink.id) fail(400, "今月のプレゼントドリンクが決まっていません。スタッフにお声かけください");
    const live = menuById.get(sid(vipDrink.id));
    if (live && live.soldOut) fail(409, `「${live.name}」は本日売り切れです`);
    k.vipMonth = month;
    return { order: { ...base, rankName: "VIP", rankColor: "#ffd700", rankGem: "⭐", isVipGift: true, isSpecial: false,
      benefitItems: [{ ...(live || vipDrink), price: 0, qty: 1 }], consumed: k }, consumed: k };
  }

  // ── ふつうの注文 ──
  const priced = R.priceItems({ menu, items: input.items, customer: c, staffRate: staffLink.rate });
  if (priced.error) fail(priced.soldOut ? 409 : 400, priced.error);
  const order = { ...base, items: priced.lines, subtotal: priced.subtotal, discount: priced.discount,
                  staffDiscount: priced.staffDiscount, total: priced.total };

  // 今月の特典・持ち越しチケット
  const wantBenefit = Array.isArray(input.benefitItems) ? input.benefitItems.filter(Boolean) : [];
  if (wantBenefit.length) {
    const tmax = R.getToppingMax(rank);
    const drinkRank = rank.benefit.type === "monthly" && tmax === 0;   // プラチナ・チタン・サファイア
    if (drinkRank) {
      if (wantBenefit.length !== 1) fail(400, "今月の特典は1杯だけです");
      if (R.isBenefitUsed(c)) fail(409, "今月の特典はもう使いました");
      const it = freeItem(wantBenefit[0]);
      const ok = rank.name === "プラチナ" ? (it.category === "コーヒー" && /^(アイスコーヒー|ホットコーヒー)/.test(it.name))
              : rank.name === "チタン" ? (dd && sid(dd.id) === sid(it.id))
              : (it.category === "コーヒー" || it.category === "ドリンク");
      if (!ok) fail(400, `「${it.name}」は今月の特典では選べません`);
      order.benefitItems = [it];
      k.benefitMonth = month;
    } else {
      // トッピング（今月ぶん → 足りない分は持ち越しチケットから）
      const ids = new Set();
      const tops = wantBenefit.map((w) => {
        const it = freeItem(w);
        if (!R.isTopping(it)) fail(400, "特典で選べるのはトッピングだけです");
        if (R.isTapioca(it)) fail(400, "タピオカは特典の対象外です");
        if (ids.has(sid(it.id))) fail(400, "同じトッピングは1つまでです");
        ids.add(sid(it.id));
        return it;
      });
      const monthly = tmax > 0 ? R.getToppingAvailable(c, rank) : 0;
      const fromMonthly = Math.min(tops.length, monthly);
      const need = tops.length - fromMonthly;
      const tickets = need > 0 ? R.allocTicketToppings(c, need) : [];
      if (tickets.reduce((s, u) => s + u.n, 0) < need) fail(409, "特典の残りが足りません");
      order.benefitItems = tops;
      order.usedToppingCount = tops.length;
      order.ticketToppingUse = tickets;
      if (fromMonthly > 0) k.topMonthly = fromMonthly;
      if (tickets.length) k.tickets = tickets;
    }
    order.usedBenefit = true;
  }

  // 🎂 誕生月の一杯 ／ 🎁 特別チケット（どちらか1つ。無料の品は birthdayItems に入る）
  const wantGift = Array.isArray(input.birthdayItems) ? input.birthdayItems.filter(Boolean) : [];
  const giftShape = () => {
    const items = wantGift.map(freeItem);
    const drinks = items.filter((i) => !R.isTopping(i)), tops = items.filter(R.isTopping);
    if (drinks.length !== 1 || tops.length > 1) fail(400, "ドリンク1杯とトッピング1つまでです");
    return [...drinks, ...tops];
  };
  if (input.secretTicketId) {
    // 🎄 シークレットプレゼント：ドリンク1杯＋トッピング1つまで無料。2つめからのトッピングは items（有料）に入れて送られてくる
    const t = R.secretTickets(c).find((x) => sid(x.id) === sid(input.secretTicketId));
    if (!t) {
      const gone = (Array.isArray(c.giftTickets) ? c.giftTickets : []).find((x) => x && sid(x.id) === sid(input.secretTicketId));
      fail(gone && gone.usedAt ? 409 : 400, gone && !gone.usedAt ? "このチケットは有効期限が過ぎています" : gone ? "このチケットはもう使いました" : "このチケットは使えません");
    }
    order.birthdayItems = giftShape();
    order.secretTicketId = t.id;
    k.secretId = t.id;
  } else if (input.specialGiftId) {
    const sp = R.SPECIAL_BY_ID(input.specialGiftId);
    if (!sp) fail(400, "このチケットは使えません");
    if (R.specialExpired(sp)) fail(400, "このチケットは有効期限が過ぎています");
    if (!R.specialIsTarget(c, sp)) fail(403, "このチケットの対象ではありません");
    if (R.specialLeft(c, sp) <= 0) fail(409, "このチケットは使い切りました");
    order.birthdayItems = giftShape();
    order.specialGiftId = sp.id;
    k.specialId = sp.id;
  } else if (input.isBirthdayGift) {
    if (!c.birthMonth || Number(c.birthMonth) !== R.jstMonthNum()) fail(400, "誕生月のプレゼントは、お誕生月にだけ使えます");
    if (sid(c.birthdayUsedYear) === year) fail(409, "今年のお誕生日の一杯は、もう受け取り済みです");
    order.birthdayItems = giftShape();
    order.isBirthdayGift = true;
    k.birthdayYear = year;
  }

  if (!order.items.length && !order.benefitItems.length && !order.birthdayItems.length) fail(400, "注文が空です");
  order.consumed = k;
  return { order, consumed: k };
}

// ══════════════════════════════════════════
//  🎄 シークレットプレゼント：教会のホームページに「この人が引いた相手」を聞く
// ══════════════════════════════════════════
function ssError(p) {
  switch (p.code) {
    case "notjoined": return { status: 404, error: "シークレット・シスター／ブラザーに参加している方だけが贈れます" };
    case "nodraw":    return { status: 404, error: "教会のホームページで、引いた相手がまだ入力されていないようです。入力してから、もう一度お試しください" };
    case "busy":      return { status: 429, error: "混み合っています。少し待ってから、もう一度お試しください" };
    case "nokey": case "key": return { status: 503, error: "教会のホームページとのつながりを準備しています。少し待つか、スタッフにお声かけください" };
    default:          return { status: 502, error: "教会のホームページにつながりませんでした。少し待ってから、もう一度お試しください" };
  }
}
// 贈る人（会員ID）から、教会での名前 → 引いた相手 → 相手の会員、までをたどる。
// 戻り値 { target: 相手の教会での名前, recipientId }。たどれなければ fail（お金は動かさない）
async function findSecretTarget(customerId, checkPin) {
  if (R.secretSeasonOver()) fail(400, "シークレットプレゼントの受付は終わりました");
  const list = arr(await fbGet(K.cust));
  const me = list.find((c) => sid(c.id) === sid(customerId));
  if (!me) fail(404, "会員が見つかりません");
  checkPin(me);
  const giverName = sid(me.churchName).trim();
  if (!giverName) fail(409, "教会での名前が、まだ虹カフェに登録されていません。スタッフにお声かけください");
  const p = await ssLink({ giver: giverName });
  if (!p.ok) { const e = ssError(p); fail(e.status, e.error); }
  const target = sid(p.target).trim();
  if (!target) fail(502, "教会のホームページから、お相手を受け取れませんでした。もう一度お試しください");
  const rec = list.find((c) => sid(c.churchName).trim() === target);
  if (!rec) fail(404, "お相手がまだ虹カフェに登録されていません。スタッフにお声かけください");
  if (sid(rec.id) === sid(me.id)) fail(400, "自分には贈れません");
  return { target, recipientId: rec.id, member: sid(rec.name).trim() };
}

// ══════════════════════════════════════════
//  締め（その日のお金のまとめ）
// ══════════════════════════════════════════
const dayOfEntry = (e) => {
  if (e && e.atISO) return R.jstDayKey(Date.parse(e.atISO));
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(sid(e && (e.day || e.date || e.at)));
  return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : "";
};
async function dayReport(day) {
  const [sales, money, customers] = await Promise.all([
    fbGet(K.sales, LOG_QUERY(1500)).catch(() => null),
    fbGet(K.money, LOG_QUERY(1500)).catch(() => null),
    fbGet(K.cust),
  ]);
  const S = Object.values(sales || {}).filter((e) => e && !e.viaLegacy && dayOfEntry(e) === day);
  const M = Object.values(money || {}).filter((e) => e && !e.viaLegacy && dayOfEntry(e) === day);
  const sum = (l) => l.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const member = S.filter((e) => !e.isCash), cash = S.filter((e) => e.isCash);
  const charges = M.filter((e) => e.type === "charge"), undos = M.filter((e) => e.type === "charge_undo");
  const joins = M.filter((e) => e.type === "new_member"), edits = M.filter((e) => e.type === "edit_balance");
  const removes = M.filter((e) => e.type === "delete_member");
  // 品ごとの杯数（台帳の「品名×数」から数える。「↩ 戻す」で取り消した分は引く）
  const items = {};
  for (const e of S) {
    if (e.source === "secret_gift") continue;   // 券を買っただけ（飲み物はまだ出ていない）なので杯数に数えない
    const sign = (Number(e.amount) || 0) < 0 || e.source === "revert" ? -1 : 1;
    for (const part of sid(e.items).replace(/^↩取消: /, "").split(", ")) {
      const m = /^(.+?)(?:×(\d+)|\((.+)\))$/.exec(part.trim());
      if (!m) continue;
      items[m[1]] = (items[m[1]] || 0) + sign * (Number(m[2]) || 1);
    }
  }
  for (const k2 of Object.keys(items)) if (items[k2] <= 0) delete items[k2];
  // 件数は「取り消した分」を差し引く
  const net = (l) => l.filter((e) => (Number(e.amount) || 0) > 0 && e.source !== "revert").length - l.filter((e) => e.source === "revert").length;
  return {
    day,
    memberSales: { count: Math.max(0, net(member)), amount: sum(member) },
    cashSales:   { count: Math.max(0, net(cash)), amount: sum(cash) },
    charges:     { count: charges.length, amount: sum(charges), undoCount: undos.length, undoAmount: -sum(undos) },
    newMembers:  { count: joins.length, amount: sum(joins) },
    edits:       { count: edits.length, amount: sum(edits) },
    removed:     { count: removes.length, amount: sum(removes) },
    deposits: arr(customers).reduce((s, c) => s + (Number(c.balance) || 0), 0),
    // 🎄 シークレットプレゼント：その日に売れた枚数（残高払いの売上に含まれる）と、全体でまだ使われていない券
    secretGifts: { count: S.filter((e) => e.source === "secret_gift").length, amount: sum(S.filter((e) => e.source === "secret_gift")) },
    secretOpen: arr(customers).reduce((n, c) => n + R.secretTickets(c).length, 0),
    secretExpired: arr(customers).reduce((n, c) => n + R.secretExpiredTickets(c).length, 0),
    items: Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 12),
    entries: { sales: S.length, money: M.length },
  };
}

// ══════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST のみ受け付けます" });
  if (!envReady()) return send(res, 503, { error: "サーバーの設定が未完了です" });

  const me = readToken(bearer(req));
  if (!me) return send(res, 401, { error: "ログインし直してください" });

  const { op, key, value, query } = readBody(req);
  const v = value || {};
  const isStaff = me.r === "staff" || me.r === "manager";
  const isCustomer = me.r === "customer";
  const ip = clientIp(req);
  const staffName = me.name || (me.r === "manager" ? "マネージャー" : "スタッフ");

  // お客様のログイン証が、今の暗証番号で発行されたものか（番号を変えたら古い証は使えない）
  const checkPin = (c) => { if (me.pv && c && me.pv !== pinVer(c)) fail(401, "暗証番号が変わりました。もう一度ログインしてください"); };

  try {
    switch (op) {
      // ════════ 読み取り ════════
      case "get": {
        if (PUBLIC_READ.includes(key)) return send(res, 200, { value: await fbGet(key, query) });
        if (isStaff && PLAY_KEY_RE.test(sid(key))) return send(res, 200, { value: await fbGet(key) });
        if (isStaff && STAFF_READ.includes(key)) return send(res, 200, { value: await fbGet(key, query) });
        if (isStaff && MANAGER_ONLY.includes(key)) {
          return send(res, 200, { value: arr(await fbGet(key, query)).map(({ password, ...rest }) => rest) });
        }
        return send(res, 403, { error: "このデータは取得できません" });
      }

      case "me": {
        const list = arr(await fbGet(K.cust));
        const found = list.find((c) => sid(c.id) === sid(me.id));
        if (!found) return send(res, 404, { error: "会員が見つかりません" });
        checkPin(found);
        return send(res, 200, { value: found });
      }

      // ── お客様：画面に必要なものをまとめて返す ──
      // full   … ログイン直後。全部（アーカイブ済みの自分の注文も）
      // ranking… みんなのランキングも欲しいとき（1分に1回くらい）
      // idx    … 前回教えた「名簿の何番目か」。合っていれば自分の分だけ読む（通信量を大きく減らす）
      // それ以外は「軽い取り直し」：自分の会員データと、新しい方60件の注文の中の自分の分だけ。
      case "bootstrap": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const full = !!v.full;
        const wantRanking = full || !!v.ranking;
        let mine = null, myIdx = -1, customers = null;
        if (!wantRanking && Number.isInteger(v.idx) && v.idx >= 0 && v.idx < 5000) {
          const one = await fbGet(`${K.cust}/${v.idx}`).catch(() => null);
          if (one && sid(one.id) === sid(me.id)) { mine = one; myIdx = v.idx; }
        }
        if (!mine) {
          const raw = await fbGet(K.cust);
          const pairs = Array.isArray(raw) ? raw.map((c, i) => [i, c]) : Object.entries(raw || {}).map(([k2, c]) => [Number(k2), c]);
          customers = pairs.map((p) => p[1]).filter(Boolean);
          const hit = pairs.find((p) => p[1] && sid(p[1].id) === sid(me.id));
          if (hit) { myIdx = hit[0]; mine = hit[1]; }
        }
        if (!mine) return send(res, 404, { error: "会員が見つかりません" });
        checkPin(mine);
        const [ordersRaw, menu, dd, vip, link, play, archive] = await Promise.all([
          fbGet(K.orders, full ? undefined : ORDER_WINDOW_QUERY),
          fbGet(K.menu), fbGet(K.dd), fbGet(K.vip),
          staffRateFor(me.id),
          full ? fbGet("cafe_v4_play/" + sid(me.id)).catch(() => null) : Promise.resolve(null),
          full ? fbGet(K.archive).catch(() => null) : Promise.resolve(null),
        ]);
        const out = {
          customer: R.checkYearRollover(mine),
          idx: myIdx,
          light: !full,
          myOrders: arr(ordersRaw).filter((o) => sid(o.customerId) === sid(me.id)),
          menu: menu || null, designatedDrink: dd || null, vipGiftDrink: vip || null,
          staffDiscountRate: link.name ? link.rate : null, staffLinkedName: link.name,
        };
        if (full) { out.play = cleanPlay(play); out.myArchive = arr(archive).filter((o) => sid(o.customerId) === sid(me.id)); }
        if (wantRanking && customers) {
          // 🏆 みんなのランキング。出すのは「名前・ランクの土台になる回数・今年の回数」だけ。
          out.ranking = customers
            .map((c) => ({ id: sid(c.id), name: c.name, rankBasis: Number(c.rankBasis) || 0, purchases: Number(c.currentYearPurchases) || 0 }))
            .sort((a, b) => (b.rankBasis - a.rankBasis) || (b.purchases - a.purchases) || sid(a.name).localeCompare(sid(b.name)));
        }
        return send(res, 200, { value: out });
      }

      case "setMyPlay": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const incoming = cleanPlay(value);
        const path = "cafe_v4_play/" + sid(me.id);
        const current = cleanPlay(await fbGet(path).catch(() => null));
        const merged = { ...current };
        for (const [k2, val] of Object.entries(incoming)) merged[k2] = mergePlayValue(k2, current[k2], val);
        if (JSON.stringify(merged).length > PLAY_MAX_BYTES) return send(res, 413, { error: "記録が大きすぎます" });
        if (JSON.stringify(merged) !== JSON.stringify(current)) await fbPut(path, merged);
        return send(res, 200, { ok: true, value: merged });
      }

      // ── お客様：誕生月を登録する（未登録のときだけ・一度きり） ──
      case "setMyBirthMonth": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const m = Number(v.birthMonth);
        if (!Number.isInteger(m) || m < 1 || m > 12) return send(res, 400, { error: "月が正しくありません" });
        const r = await custTxn(me.id, (c) => {
          checkPin(c);
          if (c.birthMonth) fail(409, "誕生月はすでに登録されています。変更はスタッフにお伝えください");
          return { customer: { ...c, birthMonth: m } };
        });
        return send(res, 200, { value: r.customer });
      }

      case "myOrders": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        checkPin(arr(await fbGet(K.cust)).find((c) => sid(c.id) === sid(me.id)));
        return send(res, 200, { value: arr(await fbGet(K.orders)).filter((o) => sid(o.customerId) === sid(me.id)) });
      }

      // ── お客様：特典の使用状況（古い画面のためだけに残してある） ──
      // 今の画面は使わない（注文を出す・取り消すときにサーバーが自分で特典を使う／戻す）。
      // 古い画面が送ってきても、「使った」方向の変化しか受け付けない（自分の特典を増やすことはできない）。
      case "setMyBenefit": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const month = R.jstMonth(), year = String(R.jstYear());
        const r = await custTxn(me.id, (c) => {
          checkPin(c);
          const x = { ...c };
          if (v.benefitUsedMonth === month) x.benefitUsedMonth = month;
          if (v.vipGiftUsedMonth === month && c.isVIP) x.vipGiftUsedMonth = month;
          if (sid(v.birthdayUsedYear) === year) x.birthdayUsedYear = year;
          if (v.keiroGiftUsed === R.KEIRO.year && R.keiroTarget(c)) x.keiroGiftUsed = R.KEIRO.year;
          if (v.toppingRemainingMonth === month && Number.isFinite(Number(v.toppingRemaining))) {
            const avail = R.getToppingAvailable(c, R.getEffectiveRank(c));
            const want = Math.max(0, Math.floor(Number(v.toppingRemaining)));
            if (want < avail) { x.toppingRemaining = want; x.toppingRemainingMonth = month; }
          }
          return { customer: x };
        });
        return send(res, 200, { value: r.customer });
      }

      // ════════ お客様：注文を出す ════════
      case "placeMyOrder": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const input = v;
        if (sid(input.customerId) && sid(input.customerId) !== sid(me.id)) return send(res, 403, { error: "他の会員の注文は出せません" });
        const [menu, dd, vipDrink, staffLink, ordersNow] = await Promise.all([
          fbGet(K.menu), fbGet(K.dd), fbGet(K.vip), staffRateFor(me.id), fbGet(K.orders),
        ]);
        const kind = kindOf(input);
        // 同じ人・同じ種類の未処理注文は、新しい注文で置き換える（その注文で使った特典は戻す）
        const replaced = arr(ordersNow).filter((o) => sid(o.customerId) === sid(me.id) && o.status === "pending" && kindOf(o) === kind);
        const replacedIds = new Set(replaced.map((o) => sid(o.orderId)));
        // 1. 会員データ：置き換える注文の特典を戻し、新しい注文の分を使う
        const built = await custTxn(me.id, (c0) => {
          checkPin(c0);
          let c = c0;
          for (const o of replaced) c = restoreConsumed(c, legacyConsumed(o));
          const { order, consumed } = buildOrder({ input, c, menu, dd, vipDrink, staffLink });
          return { customer: applyConsumed(c, consumed, order.orderId), result: { order } };
        });
        const order = built.order;
        // 2. 注文の一覧に入れる
        try {
          await ordersTxn((list) => {
            for (const id of replacedIds) {
              const cur = list.find((o) => sid(o.orderId) === id);
              if (!cur || cur.status !== "pending") fail(409, "前の注文がちょうどお店で処理されました。画面を確かめて、もう一度お試しください");
            }
            return { list: [order, ...list.filter((o) => !replacedIds.has(sid(o.orderId)))] };
          });
        } catch (e) {
          // 注文が入らなかったので、使った特典を元に戻す
          try {
            await custTxn(me.id, (c) => {
              let x = restoreConsumed(c, order.consumed);
              for (const o of replaced) x = applyConsumed(x, legacyConsumed(o), o.orderId);
              return { customer: x };
            });
          } catch (e2) { console.error("特典の戻しに失敗", e2); }
          throw e;
        }
        return send(res, 200, { ok: true, order, customer: built.customer });
      }

      // ── お客様：自分の注文を取り消す（未処理のときだけ。使った特典は戻る） ──
      case "cancelMyOrder": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        checkPin(arr(await fbGet(K.cust)).find((c) => sid(c.id) === sid(me.id)));
        const target = await ordersTxn((list) => {
          const t = list.find((o) => o.orderId === v.orderId);
          if (!t) fail(404, "注文が見つかりません");
          if (sid(t.customerId) !== sid(me.id)) fail(403, "他の会員の注文は取り消せません");
          if (t.status !== "pending") fail(400, "この注文はもうお作りしたため、取り消せません");
          return { list: list.filter((o) => o.orderId !== t.orderId), result: t };
        });
        const r = await custTxn(me.id, (c) => ({ customer: restoreConsumed(c, legacyConsumed(target)) }));
        return send(res, 200, { ok: true, customer: r.customer });
      }

      // ════════ スタッフ：注文 ════════

      // 🔔 できました（お渡し・決済）
      // 1. 注文を「済み」にする（もう済んでいたら止める → 2台で同時に押しても二重に引かれない）
      // 2. 残高から引く（今の残高から計算するので、直前のチャージが消えない）
      // 3. 台帳に書く
      case "completeOrder": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const orders0 = arr(await fbGet(K.orders));
        const o0 = orders0.find((o) => o.orderId === v.orderId);
        if (!o0) return send(res, 404, { error: "注文が見つかりません（ほかの端末で取り消された可能性があります）" });
        if (o0.status !== "pending") return send(res, 409, { error: "この注文は、もう「できました」になっています" });
        if (o0.staffLinked && o0.staffLinked === me.name) return send(res, 403, { error: "自分の注文は完了できません。ほかのスタッフにお願いしてください" });
        const pay = payOf(o0);
        if (!o0.isCash) {
          const c = arr(await fbGet(K.cust)).find((x) => sid(x.id) === sid(o0.customerId));
          if (!c) return send(res, 404, { error: "会員が見つかりません" });
          if (pay > (Number(c.balance) || 0)) {
            return send(res, 409, { error: "残高が足りません", shortage: { name: c.name, balance: Number(c.balance) || 0, total: pay } });
          }
        }
        const when = R.jstStamp();
        const done = await ordersTxn((list) => {
          const i = list.findIndex((o) => o.orderId === v.orderId);
          if (i < 0) fail(404, "注文が見つかりません（ほかの端末で取り消された可能性があります）");
          if (list[i].status !== "pending") fail(409, "この注文は、もう「できました」になっています");
          list[i] = { ...list[i], status: "completed", completedAt: when, completedAtISO: nowISO(), completedBy: staffName, paid: pay };
          return { list, result: list[i] };
        });
        const text = itemText(done);
        if (done.isCash) {
          await ledger(K.sales, { date: when, customerId: null, customerName: done.customerName || "現金のお客様",
            amount: pay, subtotal: done.subtotal, discount: 0, items: text, performer: staffName, isCash: true,
            orderId: done.orderId, source: "order" });
          return send(res, 200, { ok: true, order: done });
        }
        let r;
        try {
          r = await custTxn(done.customerId, (c) => {
            const bal = Number(c.balance) || 0;
            if (pay > bal) fail(409, "残高が足りません", { shortage: { name: c.name, balance: bal, total: pay } });
            return { customer: R.pushHistory({ ...c, balance: bal - pay }, {
              type: "use", amount: pay, subtotal: done.subtotal, discount: (done.discount || 0) + (done.staffDiscount || 0),
              items: text, performer: staffName, date: when, orderId: done.orderId,
            }) };
          });
        } catch (e) {
          // 残高を引けなかったので、注文を「未処理」に戻す
          await ordersTxn((list) => {
            const i = list.findIndex((o) => o.orderId === done.orderId);
            if (i < 0 || list[i].status !== "completed") return { noWrite: true };
            const { completedAt, completedAtISO, completedBy, paid, ...rest } = list[i];
            list[i] = { ...rest, status: "pending" };
            return { list };
          }).catch((e2) => console.error("注文を戻せませんでした", e2));
          throw e;
        }
        await ledger(K.sales, { date: when, customerId: r.customer.id, customerName: r.customer.name,
          amount: pay, subtotal: done.subtotal, discount: (done.discount || 0) + (done.staffDiscount || 0),
          items: text, performer: staffName, isCash: false, orderId: done.orderId, source: "order",
          balanceAfter: r.customer.balance });
        return send(res, 200, { ok: true, order: done, customer: r.customer });
      }

      // ↩ 戻す（「できました」の押し間違い）。注文を未処理に戻し、引いた金額を残高に返す。
      case "revertOrder": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const when = R.jstStamp();
        const back = await ordersTxn((list) => {
          const i = list.findIndex((o) => o.orderId === v.orderId);
          if (i < 0) fail(404, "注文が見つかりません（整理されて古い記録に移った注文は戻せません）");
          if (list[i].status !== "completed") fail(409, "この注文は「済み」ではありません");
          if (list[i].staffLinked && list[i].staffLinked === me.name) fail(403, "自分の注文は戻せません。ほかのスタッフにお願いしてください");
          const done = Date.parse(list[i].completedAtISO || "") || stampToMs(list[i].completedAt) || Date.now() - 365 * 24 * 3600 * 1000;
          if (done && Date.now() - done > 3 * 24 * 3600 * 1000) fail(409, "3日以上前の注文は戻せません。店長が残高を手で直してください");
          const { completedAt, completedAtISO, completedBy, ...rest } = list[i];
          const paid = list[i].paid != null ? Number(list[i].paid) || 0 : payOf(list[i]);
          delete rest.paid;
          list[i] = { ...rest, status: "pending", revertedAt: when, revertedBy: staffName };
          return { list, result: { order: list[i], paid } };
        });
        const o = back.order, text = itemText(o);
        if (o.isCash) {
          await ledger(K.sales, { date: when, customerId: null, customerName: o.customerName || "現金のお客様",
            amount: -back.paid, subtotal: -(o.subtotal || 0), discount: 0, items: "↩取消: " + text, performer: staffName,
            isCash: true, orderId: o.orderId, source: "revert" });
          return send(res, 200, { ok: true, order: o });
        }
        const r = await custTxn(o.customerId, (c) => ({ customer: R.pushHistory({ ...c, balance: (Number(c.balance) || 0) + back.paid }, {
          type: "refund", amount: back.paid, items: text, performer: staffName, date: when, orderId: o.orderId,
        }) }));
        await ledger(K.sales, { date: when, customerId: r.customer.id, customerName: r.customer.name,
          amount: -back.paid, subtotal: -(o.subtotal || 0), discount: 0, items: "↩取消: " + text, performer: staffName,
          isCash: false, orderId: o.orderId, source: "revert", balanceAfter: r.customer.balance });
        return send(res, 200, { ok: true, order: o, customer: r.customer });
      }

      // 未処理の注文を消す（作らない）。その注文で使った特典は戻る。
      case "deleteOrder": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const target = await ordersTxn((list) => {
          const t = list.find((o) => o.orderId === v.orderId);
          if (!t) fail(404, "注文が見つかりません");
          if (t.status !== "pending") fail(409, "済んだ注文は消せません（押し間違いなら「↩ 戻す」を使ってください）");
          return { list: list.filter((o) => o.orderId !== t.orderId), result: t };
        });
        if (!target.isCash) {
          await custTxn(target.customerId, (c) => ({ customer: restoreConsumed(c, legacyConsumed(target)) }))
            .catch((e) => { if (!(e instanceof TxnAbort && e.status === 404)) throw e; });
        }
        return send(res, 200, { ok: true });
      }

      // 💵 現金注文（会員でない方）。値段はメニューから。
      case "placeCashOrder": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const menu = await fbGet(K.menu);
        const priced = R.priceItems({ menu, items: v.items, customer: null, allowSoldOut: true });
        if (priced.error) return send(res, 400, { error: priced.error });
        if (!priced.lines.length) return send(res, 400, { error: "品を選んでください" });
        const now = Date.now();
        const order = {
          orderId: `ord_${now}`, customerId: `cash_${now}`,
          customerName: sid(v.name).trim().slice(0, 30) || "現金のお客様",
          rankName: "現金", rankColor: "#5ecf7f", rankGem: "💵",
          items: priced.lines, benefitItems: [], birthdayItems: [],
          subtotal: priced.subtotal, discount: 0, staffDiscount: 0, total: priced.subtotal,
          usedBenefit: false, usedToppingCount: 0, isCash: true, staffLinked: null,
          status: "pending", createdAt: R.jstStamp(), createdAtISO: nowISO(), createdBy: staffName,
        };
        await ordersTxn((list) => ({ list: [order, ...list] }));
        return send(res, 200, { ok: true, order });
      }

      // ════════ スタッフ：会員のお金 ════════

      // 🧾 レジで会計（残高払い）。値段・割引はサーバーで計算。
      case "posPay": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const [menu, link] = await Promise.all([fbGet(K.menu), staffRateFor(v.customerId)]);
        const when = R.jstStamp();
        const reqId = reqIdOf(v);
        const r = await custTxn(v.customerId, (c) => {
          if (alreadyDone(c, reqId)) fail(200, "", { ok: true, dup: true, customer: c, total: 0 });
          const p = R.priceItems({ menu, items: v.items, customer: c, staffRate: link.rate, allowSoldOut: true });
          if (p.error) fail(400, p.error);
          if (!p.lines.length) fail(400, "品を選んでください");
          const bal = Number(c.balance) || 0;
          if (p.total > bal) fail(409, `残高が足りません（のこり ${yen(bal)}・お会計 ${yen(p.total)}）`);
          const text = p.lines.map((l) => `${l.name}×${l.qty}`).join(", ");
          return { customer: R.pushHistory({ ...c, balance: bal - p.total }, {
            type: "use", amount: p.total, subtotal: p.subtotal, discount: p.subtotal - p.total, items: text, performer: staffName, date: when, reqId,
          }), result: { priced: { subtotal: p.subtotal, total: p.total, discount: p.subtotal - p.total, text } } };
        });
        await ledger(K.sales, { date: when, customerId: r.customer.id, customerName: r.customer.name,
          amount: r.priced.total, subtotal: r.priced.subtotal, discount: r.priced.discount, items: r.priced.text,
          performer: staffName, isCash: false, source: "pos", balanceAfter: r.customer.balance });
        return send(res, 200, { ok: true, customer: r.customer, total: r.priced.total });
      }

      // 🎫 チャージ（+¥2,200・今年の回数+1）。マネージャーの確認が必要。
      case "charge": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const approver = await needManager(me, v.mgrPw, ip);
        const when = R.jstStamp();
        const reqId = reqIdOf(v);
        const r = await custTxn(v.customerId, (c) => {
          if (alreadyDone(c, reqId)) fail(200, "", { ok: true, dup: true, customer: c });
          const bal = Number(c.balance) || 0;
          return { customer: R.pushHistory({ ...c, balance: bal + R.CHARGE_AMOUNT,
            currentYearPurchases: (Number(c.currentYearPurchases) || 0) + 1 }, {
            type: "charge", amount: R.CHARGE_AMOUNT, performer: staffName, approvedBy: approver, date: when, reqId,
          }), result: { before: bal } };
        });
        await ledger(K.money, { type: "charge", customerId: r.customer.id, customerName: r.customer.name, amount: R.CHARGE_AMOUNT,
          balanceBefore: r.before, balanceAfter: r.customer.balance, performer: staffName, approvedBy: approver });
        return send(res, 200, { ok: true, customer: r.customer });
      }

      // ↩️ チャージ取消。取り消していないチャージがあるときだけ。
      case "undoCharge": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const approver = await needManager(me, v.mgrPw, ip);
        const when = R.jstStamp();
        const reqId = reqIdOf(v);
        const r = await custTxn(v.customerId, (c) => {
          if (alreadyDone(c, reqId)) fail(200, "", { ok: true, dup: true, customer: c });
          const h = c.history || [];
          const open = h.filter((x) => x && x.type === "charge").length - h.filter((x) => x && x.type === "charge_undo").length;
          if (open <= 0) fail(409, "取り消せるチャージがありません");
          const bal = Number(c.balance) || 0;
          if (bal < R.CHARGE_AMOUNT) fail(409, `残高が ${yen(R.CHARGE_AMOUNT)} より少ないため取り消せません（もう使った分があります）。店長が残高を手で直してください`);
          return { customer: R.pushHistory({ ...c, balance: bal - R.CHARGE_AMOUNT,
            currentYearPurchases: Math.max(0, (Number(c.currentYearPurchases) || 0) - 1) }, {
            type: "charge_undo", amount: R.CHARGE_AMOUNT, performer: staffName, approvedBy: approver, date: when, reqId,
          }), result: { before: bal } };
        });
        await ledger(K.money, { type: "charge_undo", customerId: r.customer.id, customerName: r.customer.name, amount: -R.CHARGE_AMOUNT,
          balanceBefore: r.before, balanceAfter: r.customer.balance, performer: staffName, approvedBy: approver });
        return send(res, 200, { ok: true, customer: r.customer });
      }

      // ✓ レジで特典・チケットを使う（お店で渡す）。どれも履歴に「誰が」を残す。
      // kind: monthly / topping / bonus / freeDrink / birthday / special
      case "useTicket": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const month = R.jstMonth(), year = String(R.jstYear()), when = R.jstStamp();
        const r = await custTxn(v.customerId, (c) => {
          const rank = R.getEffectiveRank(c);
          let x = { ...c }, desc = "";
          switch (v.kind) {
            case "monthly": {
              if (rank.benefit.type !== "monthly" || R.getToppingMax(rank) > 0) fail(400, "この方の特典はドリンクではありません");
              if (R.isBenefitUsed(c)) fail(409, "今月の特典はもう使っています");
              x.benefitUsedMonth = month; desc = `${rank.benefit.icon} ${rank.benefit.desc}（レジ）`; break;
            }
            case "topping": {
              const avail = R.getToppingAvailable(c, rank);
              if (avail <= 0) fail(409, "今月のトッピング特典は残っていません");
              x.toppingRemaining = avail - 1; x.toppingRemainingMonth = month; desc = "🧁 トッピング無料 1個ぶん（レジ）"; break;
            }
            case "bonus": {
              const t = R.unusedTickets(c).find((t2) => sid(t2.id) === sid(v.ticketId));
              if (!t) fail(409, "このチケットはもう使い切っています");
              const per = t.kind === "topping" ? Math.min(t.perUse || 1, t.remaining) : 1;
              x = R.applyTicketUse(x, [{ id: t.id, n: per }], `pos_${Date.now()}`);
              desc = `🎟 ${t.label}（${t.kind === "topping" ? `トッピング${per}個ぶん` : "1杯ぶん"}）`; break;
            }
            case "freeDrink": {
              if (c.freeDrinkUsedAt) fail(409, "この無料券はもう使っています");
              x.freeDrinkUsedAt = when; desc = "🏆 実績100個の1杯無料券"; break;
            }
            case "birthday": {
              if (!R.isBirthdayTicketActive(c)) fail(409, "誕生月の券は、いまは使えません（誕生月でない・使用済み）");
              x.birthdayUsedYear = year; desc = "🎂 誕生月の1杯"; break;
            }
            case "special": {
              const sp = R.SPECIAL_BY_ID(v.ticketId);
              if (!sp || !R.specialIsTarget(c, sp) || R.specialExpired(sp)) fail(400, "このチケットは使えません");
              if (R.specialLeft(c, sp) <= 0) fail(409, "このチケットは使い切りました");
              x.specialUsed = { ...(c.specialUsed || {}), [sp.id]: R.specialUsedN(c, sp.id) + 1 };
              desc = `${sp.icon} ${sp.title}（のこり ${R.specialLeft(x, sp)}枚）`; break;
            }
            case "secret": {
              const list = R.secretTickets(c);
              const t = v.ticketId ? list.find((x2) => sid(x2.id) === sid(v.ticketId)) : list[0];
              if (!t) fail(409, list.length ? "このチケットは使えません" : "使えるシークレットプレゼントがありません（使用済み・期限切れ）");
              x = markSecret(x, t.id, true, `pos_${Date.now()}`);
              desc = `${R.SECRET_GIFT.icon} シークレットプレゼント（ドリンク1杯＋トッピング1つ・レジ）`; break;
            }
            default: fail(400, "チケットの種類が正しくありません");
          }
          return { customer: R.pushHistory(x, { type: "benefit", desc, performer: staffName, date: when }), result: { desc } };
        });
        return send(res, 200, { ok: true, customer: r.customer, desc: r.desc });
      }

      // ✏️ 会員情報の編集（店長）。暗証番号だけは「店長スタッフ（isChief）」も変えられる。
      // set: 変える項目と新しい値 / expect: 画面を開いたときの値（ほかで変わっていたら止める）
      case "editCustomer": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const set = v.set || {}, expect = v.expect || {};
        const keys = Object.keys(set);
        const pinOnly = keys.length > 0 && keys.every((k2) => k2 === "pin");
        let approver;
        if (pinOnly && await isChiefStaff(me)) approver = staffName;
        else approver = await needManager(me, v.mgrPw, ip);
        const ALLOWED = ["balance", "pin", "currentYearPurchases", "rankBasis", "isVIP", "isSpecial", "birthMonth", "bonusTickets", "name", "churchName"];
        for (const k2 of keys) if (!ALLOWED.includes(k2)) return send(res, 400, { error: `「${k2}」はここでは変えられません` });
        const when = R.jstStamp();
        const r = await custTxn(v.customerId, (c, list) => {
          for (const k2 of keys) {
            if (k2 in expect && JSON.stringify(c[k2] ?? null) !== JSON.stringify(expect[k2] ?? null)) {
              fail(409, "ほかの端末でこの方のデータが変わりました。いったん閉じて、開き直してください");
            }
          }
          const x = { ...c }, logs = [];
          let moneyDelta = null;
          if ("pin" in set) {
            const pin = sid(set.pin).trim();
            if (!/^\d{1,8}$/.test(pin)) fail(400, "暗証番号は数字で入力してください");
            const owner = list.find((o) => sid(o.id) !== sid(c.id) && sid(o.pin).trim() === pin);
            if (owner) fail(409, `この暗証番号は「${owner.name}」さんが使用中です。別の番号にしてください`);
            if (pin !== sid(c.pin)) { x.pin = pin; logs.push({ type: "edit_pin", performer: approver, date: when }); }
          }
          if ("name" in set) { const nm = sid(set.name).trim(); if (!nm) fail(400, "名前が空です"); x.name = nm.slice(0, 30); }
          if ("churchName" in set) {
            // 教会での名前（シークレットプレゼント用）。同じ名前を2人に付けない
            const cn = sid(set.churchName).trim().slice(0, 40);
            if (cn) {
              const owner = list.find((o) => sid(o.id) !== sid(c.id) && sid(o.churchName).trim() === cn);
              if (owner) fail(409, `「${cn}」は、もう「${owner.name}」さんに付いています`);
              x.churchName = cn;
            } else {
              delete x.churchName;
            }
          }
          if ("balance" in set) {
            const nb = Math.max(0, Math.floor(Number(set.balance) || 0));
            if (nb !== (Number(c.balance) || 0)) {
              moneyDelta = { before: Number(c.balance) || 0, after: nb };
              x.balance = nb;
              logs.push({ type: "edit_balance", before: moneyDelta.before, after: nb, performer: approver, date: when });
            }
          }
          for (const [k2, label] of [["currentYearPurchases", "今年の購入回数"], ["rankBasis", "ランク基準値"]]) {
            if (k2 in set) {
              const n = Math.max(0, Math.floor(Number(set[k2]) || 0));
              if (n !== (Number(c[k2]) || 0)) { logs.push({ type: "edit_purchases", label, before: Number(c[k2]) || 0, after: n, performer: approver, date: when }); x[k2] = n; }
            }
          }
          if ("isVIP" in set) x.isVIP = !!set.isVIP;
          if ("isSpecial" in set) x.isSpecial = !!set.isSpecial;
          if ("birthMonth" in set) { const m = Number(set.birthMonth); x.birthMonth = (Number.isInteger(m) && m >= 1 && m <= 12) ? m : null; }
          if ("bonusTickets" in set) x.bonusTickets = (Array.isArray(set.bonusTickets) ? set.bonusTickets : []).filter((t) => t && t.id).slice(0, 50);
          if (v.resetBenefit && R.isBenefitUsed(c)) { x.benefitUsedMonth = null; logs.push({ type: "benefit_reset", performer: approver, date: when }); }
          x.dataYear = c.dataYear || R.jstYear();
          return { customer: logs.length ? R.pushHistory(x, logs) : x, result: { moneyDelta } };
        });
        if (r.moneyDelta) {
          await ledger(K.money, { type: "edit_balance", customerId: r.customer.id, customerName: r.customer.name,
            amount: r.moneyDelta.after - r.moneyDelta.before, balanceBefore: r.moneyDelta.before, balanceAfter: r.moneyDelta.after,
            performer: staffName, approvedBy: approver });
        }
        return send(res, 200, { ok: true, customer: r.customer });
      }

      // ＋ 新しい会員の登録（初回のチャージ込み）
      case "addCustomer": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const approver = await needManager(me, v.mgrPw, ip);
        const nc = v.customer || {};
        const name = sid(nc.name).trim().slice(0, 30), pin = sid(nc.pin).trim();
        const balance = Math.max(0, Math.floor(Number(nc.balance) || 0));
        if (!name) return send(res, 400, { error: "お名前を入れてください" });
        if (!/^\d{1,8}$/.test(pin)) return send(res, 400, { error: "暗証番号は数字で入力してください" });
        const when = R.jstStamp();
        const added = await fbTxn(K.cust, (cur) => {
          const list = arr(cur);
          if (list.length === 0) fail(503, "会員名簿を読み込めませんでした。少し待ってからもう一度お試しください");
          const owner = list.find((o) => sid(o.pin).trim() === pin);
          if (owner) fail(409, `この暗証番号は「${owner.name}」さんが使用中です。別の番号にしてください`);
          const nextId = String(Math.max(1000, ...list.map((c) => Number(c.id) || 0)) + 1);
          const c = {
            id: nextId, name, pin, balance,
            currentYearPurchases: balance > 0 ? 1 : 0, rankBasis: 0, dataYear: R.jstYear(),
            joined: R.jstDayKey(), benefitUsedMonth: null, yearlyStats: [],
            history: balance > 0 ? [{ type: "new_member", amount: balance, performer: staffName, approvedBy: approver, date: when }] : [],
          };
          return { value: [...list, c], result: c };
        });
        if (balance > 0) {
          await ledger(K.money, { type: "new_member", customerId: added.id, customerName: added.name, amount: balance,
            balanceBefore: 0, balanceAfter: balance, performer: staffName, approvedBy: approver });
        }
        return send(res, 200, { ok: true, customer: added });
      }

      // 会員の削除（店長）。消した人のデータは別の場所に控えを残す。
      case "deleteCustomer": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const approver = await needManager(me, v.mgrPw, ip);
        const pend = arr(await fbGet(K.orders)).filter((o) => sid(o.customerId) === sid(v.customerId) && o.status === "pending");
        if (pend.length) return send(res, 409, { error: "この方にはまだ未処理の注文があります。先に注文を片づけてください" });
        const gone = await fbTxn(K.cust, (cur) => {
          const list = arr(cur);
          const c = list.find((x) => sid(x.id) === sid(v.customerId));
          if (!c) fail(404, "会員が見つかりません");
          if (list.length <= 1) fail(400, "最後の1人は削除できません");
          return { value: list.filter((x) => sid(x.id) !== sid(v.customerId)), result: c };
        });
        await fbPost("cafe_v4_deleted_customers", { ...gone, deletedAt: R.jstStamp(), deletedBy: staffName, approvedBy: approver }).catch(() => {});
        await ledger(K.money, { type: "delete_member", customerId: gone.id, customerName: gone.name, amount: -(Number(gone.balance) || 0),
          balanceBefore: Number(gone.balance) || 0, balanceAfter: 0, performer: staffName, approvedBy: approver });
        return send(res, 200, { ok: true });
      }

      // 💾 バックアップからの復元（マネージャー本人のみ）。今の名簿は別の場所に控えを残してから置き換える。
      case "restoreCustomers": {
        if (me.r !== "manager") return send(res, 403, { error: "この操作はマネージャーのみです" });
        const list = (Array.isArray(v.customers) ? v.customers : []).filter((c) => c && c.id && c.name);
        if (!list.length) return send(res, 400, { error: "復元するデータが空です" });
        const cur = await fbGet(K.cust);
        await fbPost("cafe_v4_restore_backup", { at: R.jstStamp(), by: staffName, customers: cur });
        await fbPut(K.cust, list);
        await ledger(K.money, { type: "restore", amount: 0, note: `${list.length}件を復元`, performer: staffName });
        return send(res, 200, { ok: true, count: list.length });
      }

      // 年が変わったときの切り替え（毎晩の自動処理と、POS を開いたときに呼ぶ）
      case "rollover": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const n = await fbTxn(K.cust, (cur) => {
          const list = arr(cur);
          const next = list.map((c) => R.checkYearRollover(c));
          const changed = next.filter((c, i) => c !== list[i] && c.dataYear !== list[i].dataYear).length;
          if (!changed) return { abort: 0 };
          return { value: next, result: changed };
        });
        return send(res, 200, { ok: true, changed: n || 0 });
      }

      // ════════ 🎄 シークレットプレゼント ════════
      // 教会のホームページの参加者の名前（マネージャーが、会員と教会の名前を結びつけるため）
      case "ssNames": {
        if (me.r !== "manager") return send(res, 403, { error: "この操作はマネージャーのみです" });
        const p = await ssLink({ act: "ping" });
        if (!p.ok) { const e = ssError(p); return send(res, e.status, { error: e.error }); }
        return send(res, 200, { names: Array.isArray(p.names) ? p.names.map(String) : [] });
      }

      // 贈る相手の確認（贈る本人にだけ、相手の教会での名前を返す。お金はまだ動かさない）
      case "secretPreview": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        const found = await findSecretTarget(me.id, checkPin);
        return send(res, 200, { target: found.target, member: found.member, price: R.SECRET_GIFT.price, until: R.SECRET_GIFT.until });
      }

      // 贈る：贈る人の残高から ¥350 を引くことと、相手にチケットを1枚足すことを「1回の書き込み」で行う。
      // （会員名簿は1つの入れ物なので、両方を同時に書き換えて、まとめて保存できる。途中で止まれば、どちらも起きない）
      // 贈り主はどこにも残さない。相手の名前も、贈った人の履歴・台帳には残さない。
      case "buySecretGift": {
        if (!isCustomer) return send(res, 403, { error: "お客様専用の操作です" });
        if (R.secretSeasonOver()) return send(res, 400, { error: "シークレットプレゼントの受付は終わりました" });
        const reqId = reqIdOf(v);
        if (!reqId) return send(res, 400, { error: "画面を開き直して、もう一度お試しください" });
        const found = await findSecretTarget(me.id, checkPin);
        // 確認の画面を出したあとで相手が変わっていたら（教会側で入力し直したなど）止める
        if (v.confirmTarget && sid(v.confirmTarget) !== found.target) {
          return send(res, 409, { error: "お相手の情報が変わりました。もう一度「贈る」からやり直してください" });
        }
        const price = R.SECRET_GIFT.price;
        const ticketId = "sg_" + crypto.randomBytes(9).toString("hex");
        const out = await fbTxn(K.cust, (cur) => {
          const list = arr(cur);
          const gi = list.findIndex((c) => sid(c.id) === sid(me.id));
          const ri = list.findIndex((c) => sid(c.id) === sid(found.recipientId));
          if (gi < 0) fail(404, "会員が見つかりません");
          const giver = list[gi];
          if (alreadyDone(giver, reqId)) return { abort: { dup: true, customer: giver } };   // 二度押し：何もしない
          if (ri < 0 || sid(list[ri].churchName).trim() !== found.target) fail(404, "お相手がまだ虹カフェに登録されていません");
          if (ri === gi) fail(400, "自分には贈れません");
          const bal = Number(giver.balance) || 0;
          if (bal < price) fail(409, `残高が足りません（のこり ${yen(bal)}・シークレットプレゼント ${yen(price)}）。スタッフにチャージをお申し付けください`);
          // 贈る人：残高を引き、履歴は「シークレットプレゼント −¥350」とだけ（相手の名前は残さない。日付だけ）
          list[gi] = R.pushHistory({ ...giver, balance: bal - price }, {
            type: "secret_gift", amount: price, items: "🎄 シークレットプレゼント", date: R.jstToday(), reqId,
          });
          // もらう人：チケットを1枚。贈り主は書かない。届いた日も日付だけ
          const r0 = list[ri];
          list[ri] = { ...r0, giftTickets: [...(Array.isArray(r0.giftTickets) ? r0.giftTickets : []),
            { id: ticketId, kind: "secret", issuedDay: R.jstToday(), until: R.SECRET_GIFT.until, usedAt: null }].slice(-60) };
          return { value: list, result: { dup: false, customer: list[gi] } };
        });
        if (!out.dup) {
          // 売上の台帳：贈った人の残高払い ¥350（相手は書かない）
          await ledger(K.sales, { date: R.jstStamp(), customerId: out.customer.id, customerName: out.customer.name,
            amount: price, subtotal: price, discount: 0, items: "シークレットプレゼント×1", performer: "アプリ",
            isCash: false, source: "secret_gift", balanceAfter: out.customer.balance });
        }
        return send(res, 200, { ok: true, dup: !!out.dup, customer: out.customer });
      }

      // ════════ スタッフ：メニュー ════════
      case "setSoldOut": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const menu = await fbTxn(K.menu, (cur) => {
          const list = arr(cur);
          const i = list.findIndex((m) => sid(m.id) === sid(v.id));
          if (i < 0) fail(404, "メニューにない品です");
          list[i] = { ...list[i], soldOut: !!v.soldOut };
          return { value: list, result: list };
        });
        return send(res, 200, { ok: true, value: menu });
      }

      // ════════ スタッフ：締め ════════
      case "dayReport": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(sid(v.day)) ? v.day : R.jstDayKey();
        return send(res, 200, { value: await dayReport(day) });
      }

      // ════════ まるごと保存（お金に関係しないものだけ） ════════
      case "set": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        if (RETIRED_SET.includes(key)) return send(res, 410, { error: RELOAD_MSG });
        if (MANAGER_ONLY.includes(key)) {
          if (me.r !== "manager") return send(res, 403, { error: "この操作はマネージャーのみです" });
          await saveAccounts(key, value);
          return send(res, 200, { ok: true });
        }
        if (!STAFF_SET.includes(key)) return send(res, 403, { error: "このデータは書き換えられません" });
        if (key === K.menu) {
          const next = arr(value);
          const cur = arr(await fbGet(K.menu));
          if (!next.length || (cur.length >= 6 && next.length < cur.length / 2)) {
            return send(res, 400, { error: "メニューが大きく減る保存は、事故の可能性があるため止めました" });
          }
        }
        await fbPut(key, value);
        return send(res, 200, { ok: true });
      }

      case "patchCustomer":
      case "setOrdersMerged":
        return send(res, 410, { error: RELOAD_MSG });

      // ── マネージャーのパスワード確認（POS の保護された操作の前に） ──
      case "verifyManagerPw": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        if (await guardBlocked("mgrpw", ip)) return send(res, 429, { error: "パスワードを何度もまちがえたため、15分ほど待ってからお試しください" });
        const mgrs = arr(await fbGet(K.mgr));
        const hit = mgrs.find((a) => a && sameSecret(a.password, v.password));
        if (!hit) { await guardFail("mgrpw", ip); await sleep(400); }
        return send(res, 200, { ok: !!hit, name: hit ? hit.name : null });
      }

      // ── 台帳への追記（古い画面のため残してある） ──
      // 台帳は、お金を動かした窓口の中でサーバーが書く。古い画面からの追記は、実際には起きていない
      // 売上・チャージが締めに入ってしまうので受け付けない（再読み込みしてもらう）。
      case "push":
        return send(res, 410, { error: RELOAD_MSG });

      default:
        return send(res, 400, { error: "op が不正です" });
    }
  } catch (e) {
    if (e instanceof TxnAbort) return send(res, e.status || 400, e.body || { error: e.message });
    console.error("data failed", op, key, e);
    return send(res, 500, { error: "処理に失敗しました。もう一度お試しください" });
  }
}

// スタッフ／マネージャーの一覧は、取得するときパスワードを伏せて返している。
// そのまま保存されるとパスワードが消えるので、パスワードが入っていない項目は今の値を引き継ぐ。
async function saveAccounts(key, value) {
  const before = arr(await fbGet(key));
  const pw = {};
  before.forEach((a) => { if (a.id && a.password !== undefined) pw[a.id] = a.password; });
  const merged = arr(value).map((a) => {
    if (a.password === undefined) return pw[a.id] !== undefined ? { ...a, password: pw[a.id] } : a;
    return looksHashed(a.password) ? a : { ...a, password: hashSecret(a.password) };
  });
  if (!merged.length) fail(400, "一覧が空です");
  await fbPut(key, merged);
}
