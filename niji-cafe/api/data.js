// ══════════════════════════════════════════
//  POST /api/data
//  データベースへの読み書きの窓口。
//  ログイン証（トークン）を確認し、その人が触ってよい範囲だけを通します。
//
//  お客様のログイン証では、
//    ・自分の会員データと自分の注文しか読めない
//    ・残高・暗証番号・氏名は書き換えられない（特典の使用状況だけ）
//  ので、細工したリクエストを送られても残高を増やすことはできません。
// ══════════════════════════════════════════
import { envReady, fbGet, fbPut, fbPost, readToken, sameSecret, hashSecret, looksHashed, send, readBody, bearer } from "./_lib.js";

// 誰でも読んでよいもの（お店の掲示物にあたるもの）
const PUBLIC_READ = ["cafe_v4_menu", "cafe_v4_designated_drink", "cafe_v4_vip_gift_drink"];

// スタッフが読み書きしてよいもの
const STAFF_RW = [
  "cafe_v4_customers", "cafe_v4_orders", "cafe_v4_orders_archive", "cafe_v4_menu",
  "cafe_v4_cash_orders", "cafe_v4_designated_drink", "cafe_v4_vip_gift_drink",
  "cafe_v4_payment_today",
];
// マネージャーだけが書き換えてよいもの
const MANAGER_ONLY = ["cafe_v4_staff_accounts", "cafe_v4_manager_accounts"];

// スタッフが「読むだけ」できるもの。
// 台帳（消えない記録）なので、まるごと書き換えることは誰にも許さない。
// 追記は下の PUSH_OK 経由で1件ずつだけ。
const STAFF_READ_ONLY = ["cafe_v4_sales_log", "cafe_v4_money_log", "cafe_v4_archive_log"];

// お客様ひとりぶんの「遊びの記録」（実績・回数・きせかえ等）。cafe_v4_play/<会員ID>
// 端末の localStorage の控え。機種変更やデータ消去で殿堂入りが消えないようにするためのもの。
// 残高やランクには一切関係しない場所なので、お客様本人が自由に書いてよい（ただし上限つき）。
const PLAY_KEY_RE = /^cafe_v4_play\/[A-Za-z0-9_-]{1,40}$/;
const PLAY_MAX_KEYS = 120;      // niji_* の項目数の上限
const PLAY_MAX_BYTES = 8000;    // 全体の大きさの上限（1人分）
// 合流のルールは画面側（App.jsx の mergePlayValue）と同じ。消す方向には動かない。
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

// 1件ずつ追記してよい台帳
const PUSH_OK = ["cafe_v4_money_log", "cafe_v4_sales_log"];

// お客様が自分の会員データのうち書き換えてよい項目（特典の使用状況だけ）
const CUSTOMER_WRITABLE = [
  "benefitUsedMonth", "toppingRemaining", "toppingRemainingMonth", "vipGiftUsedMonth",
];

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST のみ受け付けます" });
  if (!envReady()) return send(res, 503, { error: "サーバーの設定が未完了です" });

  const me = readToken(bearer(req));
  if (!me) return send(res, 401, { error: "ログインし直してください" });

  const { op, key, value, query } = readBody(req);
  const isStaff = me.r === "staff" || me.r === "manager";

  try {
    switch (op) {
      // ── 読み取り ────────────────────────────
      case "get": {
        if (PUBLIC_READ.includes(key)) return send(res, 200, { value: await fbGet(key, query) });
        if (isStaff && STAFF_READ_ONLY.includes(key)) {
          return send(res, 200, { value: await fbGet(key, query) });
        }
        // スタッフは、お客様の遊びの記録を読める（無料券の確認に使う）
        if (isStaff && PLAY_KEY_RE.test(String(key))) {
          return send(res, 200, { value: await fbGet(key) });
        }
        if (isStaff && (STAFF_RW.includes(key) || MANAGER_ONLY.includes(key))) {
          const v = await fbGet(key, query);
          // スタッフ一覧を返すときもパスワードは伏せる
          if (MANAGER_ONLY.includes(key)) {
            return send(res, 200, { value: arr(v).map(({ password, ...rest }) => rest) });
          }
          return send(res, 200, { value: v });
        }
        return send(res, 403, { error: "このデータは取得できません" });
      }

      // ── お客様：自分の会員データ ──────────────────
      case "me": {
        const list = arr(await fbGet("cafe_v4_customers"));
        const found = list.find((c) => String(c.id) === String(me.id));
        if (!found) return send(res, 404, { error: "会員が見つかりません" });
        return send(res, 200, { value: found });
      }

      // ── お客様：チケット画面に必要なものを一度にまとめて返す ──────
      // 他の会員のデータ・暗証番号・スタッフのパスワードは一切含めない。
      // スタッフ割引は「その人に紐づいた割引率」だけを返す（スタッフ一覧は渡さない）。
      case "bootstrap": {
        if (me.r !== "customer") return send(res, 403, { error: "お客様専用の操作です" });
        // full: ログイン直後の1回だけ true。実績の計算に使う「アーカイブ済みの自分の注文」も返す。
        // 8秒ごとの取り直しでは付けない（アーカイブは大きいので毎回は読まない）。
        const full = !!(value && value.full);
        const [customers, orders, menu, dd, vip, staff, mgrs, play, archive] = await Promise.all([
          fbGet("cafe_v4_customers"), fbGet("cafe_v4_orders"), fbGet("cafe_v4_menu"),
          fbGet("cafe_v4_designated_drink"), fbGet("cafe_v4_vip_gift_drink"),
          fbGet("cafe_v4_staff_accounts"), fbGet("cafe_v4_manager_accounts"),
          fbGet("cafe_v4_play/" + String(me.id)).catch(() => null),
          full ? fbGet("cafe_v4_orders_archive").catch(() => null) : Promise.resolve(null),
        ]);
        const mine = arr(customers).find((c) => String(c.id) === String(me.id));
        if (!mine) return send(res, 404, { error: "会員が見つかりません" });
        const extra = { play: cleanPlay(play) };
        if (full) extra.myArchive = arr(archive).filter((o) => String(o.customerId) === String(me.id));
        const linked = [...arr(staff), ...arr(mgrs)]
          .find((s) => s.linkedCustomerId && String(s.linkedCustomerId) === String(me.id));
        return send(res, 200, { value: {
          customer: mine,
          myOrders: arr(orders).filter((o) => String(o.customerId) === String(me.id)),
          menu: menu || null,
          designatedDrink: dd || null,
          vipGiftDrink: vip || null,
          staffDiscountRate: linked ? (linked.discountRate ?? 10) : null,
          staffLinkedName: linked ? linked.name : null,
          ...extra,
        }});
      }

      // ── お客様：自分の遊びの記録（実績・回数など）を控える ──────
      // 端末の localStorage の内容をそのまま受け取り、サーバー側の控えと合流させて保存する。
      // 合流は「増える方向」だけなので、古い端末から送られてきても進みが戻ることはない。
      // 残高・暗証番号・注文には一切触れない場所（cafe_v4_play/<自分のID>）にだけ書く。
      case "setMyPlay": {
        if (me.r !== "customer") return send(res, 403, { error: "お客様専用の操作です" });
        const incoming = cleanPlay(value);
        const path = "cafe_v4_play/" + String(me.id);
        const current = cleanPlay(await fbGet(path).catch(() => null));
        const merged = { ...current };
        for (const [k, v] of Object.entries(incoming)) merged[k] = mergePlayValue(k, current[k], v);
        if (JSON.stringify(merged).length > PLAY_MAX_BYTES) {
          return send(res, 413, { error: "記録が大きすぎます" });
        }
        if (JSON.stringify(merged) !== JSON.stringify(current)) await fbPut(path, merged);
        return send(res, 200, { ok: true, value: merged });
      }

      // ── お客様：自分の注文だけ ────────────────────
      case "myOrders": {
        const list = arr(await fbGet("cafe_v4_orders"));
        return send(res, 200, { value: list.filter((o) => String(o.customerId) === String(me.id)) });
      }

      // ── 書き込み ────────────────────────────
      case "set": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        if (MANAGER_ONLY.includes(key) && me.r !== "manager") {
          return send(res, 403, { error: "この操作はマネージャーのみです" });
        }
        if (!STAFF_RW.includes(key) && !MANAGER_ONLY.includes(key)) {
          return send(res, 403, { error: "このデータは書き換えられません" });
        }
        // 会員をまるごと空にするような書き込みは、事故とみなして断る
        if (key === "cafe_v4_customers" && arr(value).length === 0) {
          return send(res, 400, { error: "会員が0人になる書き込みは受け付けません" });
        }
        // スタッフ／マネージャーの一覧は、取得するときパスワードを伏せて返している。
        // そのまま保存されるとパスワードが消えて誰もログインできなくなるので、
        // パスワードが入っていない項目は、いまDBにある値をそのまま引き継ぐ。
        if (MANAGER_ONLY.includes(key)) {
          const before = arr(await fbGet(key));
          const pw = {};
          before.forEach((a) => { if (a.id && a.password !== undefined) pw[a.id] = a.password; });
          const merged = arr(value).map((a) => {
            if (a.password === undefined) {
              // パスワードが入っていない＝画面は伏せた一覧を持っている。今の値を引き継ぐ
              return pw[a.id] !== undefined ? { ...a, password: pw[a.id] } : a;
            }
            // 新しいパスワードが入力された。素の文字列のまま保存せず、ハッシュ形式に変換する
            return looksHashed(a.password) ? a : { ...a, password: hashSecret(a.password) };
          });
          await fbPut(key, merged);
          return send(res, 200, { ok: true });
        }
        await fbPut(key, value);
        return send(res, 200, { ok: true });
      }

      // ── 会員1人だけを書き換える ───────────────────
      // これまでは、1人の残高を変えるだけでも「会員21人ぶんの一覧」をまるごと
      // 送り直していた。ブラウザが一覧を読んでから書き戻すまでの数秒のあいだに、
      // 別の端末が別のお客様の会計をすると、その会計が消えてしまう。
      //
      // この窓口では、送るのは「変える1人ぶんの中身」だけ。
      // 読み込みから書き戻しまでをサーバーの中で一続きに行うので、
      // すれ違いが起きる余地がミリ秒単位まで縮む。通信量もぐっと減る。
      case "patchCustomer": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const id = value && value.id;
        const fields = (value && value.fields) || {};
        if (!id) return send(res, 400, { error: "会員が指定されていません" });

        const list = arr(await fbGet("cafe_v4_customers"));
        const i = list.findIndex((c) => String(c.id) === String(id));
        if (i < 0) return send(res, 404, { error: "会員が見つかりません" });

        // id だけは書き換えさせない（別人に化けるのを防ぐ）
        const safe = { ...fields };
        delete safe.id;
        list[i] = { ...list[i], ...safe };

        await fbPut("cafe_v4_customers", list);
        return send(res, 200, { value: list[i] });
      }

      // ── 注文の一覧を「合流させて」保存する ─────────────
      // ブラウザから届いた一覧をそのまま書くのではなく、
      // いまDBにある最新と突き合わせてから書く。
      // これで、2台の端末がほぼ同時に注文を触っても、互いの変更を消さない。
      //   list    … ブラウザが保存したい一覧
      //   prevIds … ブラウザが直前に持っていた注文のID（消した注文を見分けるため）
      // ルール：
      //   ・ブラウザが持っていたのに list に無い注文 → 消したとみなして除く
      //   ・list にある注文 → ブラウザの内容で上書き
      //   ・DBにだけある注文（他の端末の分）→ そのまま残す
      //   ・list にだけある新しい注文 → 先頭に足す（未処理のもの、または本当に新しいもの）
      case "setOrdersMerged": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const list = arr(value && value.list);
        const prevIds = new Set(arr(value && value.prevIds).map(String));
        const latest = arr(await fbGet("cafe_v4_orders"));

        const byId = {};
        const callerIds = new Set();
        list.forEach((o) => { if (o && o.orderId) { byId[o.orderId] = o; callerIds.add(String(o.orderId)); } });

        const result = [];
        const used = new Set();
        latest.forEach((o) => {
          if (!o || !o.orderId) return;
          const id = String(o.orderId);
          if (prevIds.has(id) && !callerIds.has(id)) return;   // ブラウザが消した注文
          if (byId[o.orderId]) { result.push(byId[o.orderId]); used.add(id); }
          else result.push(o);                                  // 他の端末の注文は残す
        });
        const news = [];
        list.forEach((o) => {
          if (!o || !o.orderId || used.has(String(o.orderId))) return;
          // DBに無い注文を足すのは「新しく作った注文」か「未処理」だけ。
          // 昔から持っていた完了済みがDBに無いのは、アーカイブに移された印なので足し戻さない。
          if (!prevIds.has(String(o.orderId)) || o.status === "pending") news.push(o);
        });
        const finalList = [...news, ...result];
        await fbPut("cafe_v4_orders", finalList);
        return send(res, 200, { value: finalList });
      }

      // ── マネージャーのパスワード確認 ─────────────────
      // POS の中の保護された操作（残高の手修正など）で使う。
      // 画面側にはパスワードを渡していないので、照合はここで行う。
      // 誰のパスワードかは問わず「マネージャーの誰かのものか」だけを見る。
      case "verifyManagerPw": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        const pw = value && value.password;
        const mgrs = arr(await fbGet("cafe_v4_manager_accounts"));
        const ok = mgrs.some((a) => a && sameSecret(a.password, pw));
        // 総当たりを現実的でなくするため、外れたときだけ待たせる
        if (!ok) await new Promise((r) => setTimeout(r, 400));
        return send(res, 200, { ok });
      }

      // ── お客様：自分の特典の使用状況だけを更新 ──────────
      case "setMyBenefit": {
        if (me.r !== "customer") return send(res, 403, { error: "お客様専用の操作です" });
        const list = arr(await fbGet("cafe_v4_customers"));
        const i = list.findIndex((c) => String(c.id) === String(me.id));
        if (i < 0) return send(res, 404, { error: "会員が見つかりません" });
        const patch = {};
        for (const f of CUSTOMER_WRITABLE) {
          if (value && Object.prototype.hasOwnProperty.call(value, f)) patch[f] = value[f];
        }
        if (Object.keys(patch).length === 0) return send(res, 400, { error: "更新できる項目がありません" });
        list[i] = { ...list[i], ...patch };   // 残高・暗証番号・氏名には触れない
        await fbPut("cafe_v4_customers", list);
        return send(res, 200, { value: list[i] });
      }

      // ── お客様：自分の注文を出す／取り消す ───────────
      case "placeMyOrder": {
        if (me.r !== "customer") return send(res, 403, { error: "お客様専用の操作です" });
        const order = value || {};
        if (String(order.customerId) !== String(me.id)) {
          return send(res, 403, { error: "他の会員の注文は出せません" });
        }
        if (order.status !== "pending") return send(res, 400, { error: "注文の状態が不正です" });
        const list = arr(await fbGet("cafe_v4_orders"));
        // 同じ人の、同じ種類（通常／VIPギフト）の未処理注文を置き換える
        const kept = list.filter(
          (o) => !(String(o.customerId) === String(me.id) && o.status === "pending"
                   && !!o.isVipGift === !!order.isVipGift)
        );
        await fbPut("cafe_v4_orders", [order, ...kept]);
        return send(res, 200, { ok: true });
      }
      case "cancelMyOrder": {
        if (me.r !== "customer") return send(res, 403, { error: "お客様専用の操作です" });
        const list = arr(await fbGet("cafe_v4_orders"));
        const target = list.find((o) => o.orderId === (value && value.orderId));
        if (!target) return send(res, 404, { error: "注文が見つかりません" });
        if (String(target.customerId) !== String(me.id)) {
          return send(res, 403, { error: "他の会員の注文は取り消せません" });
        }
        // 済んだ注文は取り消せない（残高が動いた後なので）
        if (target.status !== "pending") return send(res, 400, { error: "この注文はもう取り消せません" });
        await fbPut("cafe_v4_orders", list.filter((o) => o.orderId !== target.orderId));
        return send(res, 200, { ok: true });
      }

      // ── 台帳への追記（消えない入出金の記録） ──────────
      case "push": {
        if (!isStaff) return send(res, 403, { error: "この操作はスタッフのみです" });
        if (!PUSH_OK.includes(key)) return send(res, 403, { error: "この場所には追記できません" });
        await fbPost(key, { ...value, by: me.name || me.id, byRole: me.r });
        return send(res, 200, { ok: true });
      }

      default:
        return send(res, 400, { error: "op が不正です" });
    }
  } catch (e) {
    console.error("data failed", op, key, e);
    return send(res, 500, { error: "処理に失敗しました" });
  }
}
