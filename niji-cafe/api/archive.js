// ══════════════════════════════════════════
//  GET/POST /api/archive
//  完了した古い注文を、本体（cafe_v4_orders）からアーカイブ
//  （cafe_v4_orders_archive）へ自動で移す窓口。
//
//  本体は保存のたびに全件が読み書きされるため、放っておくと太り続ける。
//  そこで「新しい60件だけを本体に残し、それより古い完了注文をアーカイブへ」を
//  毎晩 Vercel の Cron が呼んで自動で行う（vercel.json を参照）。
//
//  誰が呼べるか：
//    ・Vercel の Cron（環境変数 CRON_SECRET を Authorization: Bearer で送ってくる）
//    ・マネージャーのログイン証（POS から「今すぐ整理」を押したとき）
//  どちらでもなければ 401。CRON_SECRET が未設定なら Cron からは動かない（安全側）。
//
//  絶対に守る順番（引き継ぎメモ ④ と同じ）：
//    1. 未処理（pending）の注文は絶対に移さない
//    2. まずアーカイブ側へ書き足す
//    3. 読み戻して、移す分がすべて入っていることを確認
//    4. そこではじめて本体を縮める（書く直前にもう一度本体を読み直し、
//       その間に届いた新しい注文を巻き込まない）
//    5. 縮めた本体を読み戻して確認
//  途中のどこかで確認に失敗したら、そこで止める。本体は縮めない。
//  （アーカイブに余分が残っても、履歴画面は orderId で重複排除するので害はない）
// ══════════════════════════════════════════
import crypto from "node:crypto";
import { envReady, fbGet, fbPut, fbPost, readToken, send, bearer } from "./_lib.js";

const KEEP = 60;        // 本体に残す件数
const THRESHOLD = 70;   // これを超えたときだけ整理する（毎晩少しずつ動かさない）
const CRON_SECRET = process.env.CRON_SECRET || "";

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const ids = (list) => new Set(list.map((o) => String(o.orderId)));

function sameToken(given, expected) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 「注文が同じ中身か」を、キーの順番に左右されずに比べる
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return send(res, 405, { error: "GET または POST のみ受け付けます" });
  }
  if (!envReady()) return send(res, 503, { error: "サーバーの設定が未完了です" });

  // ── 呼び出し元の確認 ──
  const token = bearer(req);
  const byCron = CRON_SECRET.length >= 16 && sameToken(token, CRON_SECRET);
  const me = byCron ? null : readToken(token);
  const byManager = !!(me && me.r === "manager");
  if (!byCron && !byManager) return send(res, 401, { error: "この操作は許可されていません" });
  const who = byCron ? "cron" : `manager:${me.name || me.id}`;

  const startedAt = new Date().toISOString();
  const log = async (entry) => {
    try { await fbPost("cafe_v4_archive_log", { at: startedAt, by: who, ...entry }); } catch {}
  };

  try {
    // 1. 本体を読む（先頭が新しい注文）
    const body = arr(await fbGet("cafe_v4_orders"));
    if (body.length <= THRESHOLD) {
      return send(res, 200, { ok: true, skipped: true, reason: `本体 ${body.length} 件（${THRESHOLD} 件以下）`, body: body.length });
    }

    // 2. 移す候補：先頭 KEEP 件より後ろにある、完了済みの注文だけ。未処理は絶対に残す。
    const move = body.slice(KEEP).filter((o) => o && o.orderId && o.status !== "pending");
    if (move.length === 0) {
      return send(res, 200, { ok: true, skipped: true, reason: "移せる完了注文がありません", body: body.length });
    }
    const moveIds = ids(move);

    // 3. アーカイブに書き足す（既に入っているものは二重に入れない）
    const archive = arr(await fbGet("cafe_v4_orders_archive"));
    const have = ids(archive);
    const toAdd = move.filter((o) => !have.has(String(o.orderId)));
    const newArchive = [...toAdd, ...archive];   // アーカイブも「先頭が新しい」並び
    if (toAdd.length > 0) await fbPut("cafe_v4_orders_archive", newArchive);

    // 4. 読み戻して確認：件数が合い、移す分が1件も欠けず、中身も変わっていないこと
    const back = arr(await fbGet("cafe_v4_orders_archive"));
    const backById = new Map(back.map((o) => [String(o.orderId), o]));
    if (back.length !== newArchive.length) {
      await log({ ok: false, step: "archive-verify", detail: `件数不一致 ${back.length}≠${newArchive.length}` });
      return send(res, 500, { error: "アーカイブの確認に失敗（件数）。本体は触っていません" });
    }
    for (const o of move) {
      const b = backById.get(String(o.orderId));
      if (!b || canon(b) !== canon(o)) {
        await log({ ok: false, step: "archive-verify", detail: `内容不一致 ${o.orderId}` });
        return send(res, 500, { error: "アーカイブの確認に失敗（内容）。本体は触っていません" });
      }
    }

    // 5. 本体を縮める。書く直前にもう一度読み直し、その間に届いた注文を巻き込まない。
    const latest = arr(await fbGet("cafe_v4_orders"));
    const kept = latest.filter((o) => !(o && moveIds.has(String(o.orderId))));
    if (kept.length === latest.length || kept.length < KEEP) {
      // 想定外（移す注文が本体から消えている／本体が急に減っている）。事故を疑って止める
      await log({ ok: false, step: "body-sanity", detail: `kept ${kept.length} latest ${latest.length}` });
      return send(res, 500, { error: "本体の状態が想定外のため中止しました" });
    }
    await fbPut("cafe_v4_orders", kept);

    // 6. 縮めた本体を読み戻して確認
    const after = arr(await fbGet("cafe_v4_orders"));
    const afterIds = ids(after);
    const lost = kept.filter((o) => !afterIds.has(String(o.orderId)));
    const pendingBefore = latest.filter((o) => o.status === "pending").length;
    const pendingAfter = after.filter((o) => o.status === "pending").length;
    const result = {
      ok: lost.length === 0 && pendingAfter >= pendingBefore,
      moved: move.length, addedToArchive: toAdd.length,
      bodyBefore: body.length, bodyAfter: after.length, archiveAfter: back.length,
      pendingBefore, pendingAfter,
    };
    await log(result);
    return send(res, result.ok ? 200 : 500, result);
  } catch (e) {
    console.error("archive failed", e);
    await log({ ok: false, step: "exception", detail: String(e && e.message || e) });
    return send(res, 500, { error: "整理に失敗しました" });
  }
}
