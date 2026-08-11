// ══════════════════════════════════════════
//  GET /api/export
//  週次バックアップ専用の窓口。全データをそのまま返すだけ。
//
//  データベースを直接読めない設定にしたあとも、バックアップだけは
//  取り続けられるようにするために用意しています。
//  合言葉（BACKUP_TOKEN）を知っている人だけが使えます。
//  この合言葉が漏れても、できるのは「読むこと」だけで、書き換えはできません。
// ══════════════════════════════════════════
import crypto from "node:crypto";
import { fbGet, send } from "./_lib.js";

const BACKUP_TOKEN = process.env.BACKUP_TOKEN || "";

// 合言葉の比較は、時間差から中身を推測されないように行う
function sameToken(given) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(BACKUP_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "GET のみ受け付けます" });
  // 合言葉が未設定のときは、誰にも使わせない
  if (BACKUP_TOKEN.length < 16) return send(res, 503, { error: "バックアップ用の設定が未完了です" });

  const auth = req.headers.authorization || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!sameToken(given)) return send(res, 401, { error: "合言葉が違います" });

  try {
    const all = await fbGet("");   // ルート＝全データ
    if (!all || typeof all !== "object") throw new Error("取得できませんでした");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(JSON.stringify(all));
  } catch (e) {
    console.error("export failed", e);
    return send(res, 500, { error: "バックアップの取得に失敗しました" });
  }
}
