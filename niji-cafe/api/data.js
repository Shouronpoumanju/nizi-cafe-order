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
import { envReady, fbGet, fbPut, fbPost, readToken, send, readBody, bearer } from "./_lib.js";

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
        const [customers, orders, menu, dd, vip, staff, mgrs] = await Promise.all([
          fbGet("cafe_v4_customers"), fbGet("cafe_v4_orders"), fbGet("cafe_v4_menu"),
          fbGet("cafe_v4_designated_drink"), fbGet("cafe_v4_vip_gift_drink"),
          fbGet("cafe_v4_staff_accounts"), fbGet("cafe_v4_manager_accounts"),
        ]);
        const mine = arr(customers).find((c) => String(c.id) === String(me.id));
        if (!mine) return send(res, 404, { error: "会員が見つかりません" });
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
        }});
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
        await fbPut(key, value);
        return send(res, 200, { ok: true });
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
        if (key !== "cafe_v4_money_log") return send(res, 403, { error: "この場所には追記できません" });
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
