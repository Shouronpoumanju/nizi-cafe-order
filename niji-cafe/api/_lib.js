// ══════════════════════════════════════════
//  共通処理（Vercel Serverless Function 用）
//  ここは「サーバーの中だけ」で動くコードです。
//  ブラウザには配られないので、ここに書いた秘密の鍵は外から見えません。
// ══════════════════════════════════════════
import crypto from "node:crypto";

export const DB_BASE =
  "https://nizicafe-card-default-rtdb.asia-southeast1.firebasedatabase.app";

// 環境変数（Vercel の Settings → Environment Variables で設定する）
//   FIREBASE_DB_SECRET … Firebase のデータベースシークレット。DBルールを全部無視して読み書きできる鍵。
//   SESSION_SECRET     … ログイン証（トークン）に署名するための、適当に長いランダム文字列。
const DB_SECRET = process.env.FIREBASE_DB_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

// 鍵が設定されていなければ、何もしないで断る（設定漏れのまま素通りさせない）
export function envReady() {
  return DB_SECRET.length > 0 && SESSION_SECRET.length >= 16;
}

// ── Firebase への読み書き（サーバーからのみ） ──────────────
async function fbFetch(path, init, query) {
  const q = [`auth=${encodeURIComponent(DB_SECRET)}`];
  if (query) q.push(query);
  const res = await fetch(`${DB_BASE}/${path}.json?${q.join("&")}`, init);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return res;
}
export async function fbGet(path, query) {
  return (await fbFetch(path, undefined, query)).json();
}
export async function fbPut(path, value) {
  await fbFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return true;
}
export async function fbPost(path, value) {
  const res = await fbFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return res.json();
}

// ── ログイン証（トークン）の発行と確認 ──────────────────
// 形式: base64url(ペイロード).base64url(署名)
// 署名は SESSION_SECRET を使った HMAC-SHA256。
// 中身は誰でも読めますが、鍵が無いと偽造できません。
const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const sign = (data) =>
  b64u(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());

export function issueToken(payload, hours = 12) {
  const body = { ...payload, exp: Date.now() + hours * 3600 * 1000 };
  const data = b64u(JSON.stringify(body));
  return `${data}.${sign(data)}`;
}

export function readToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = sign(data);
  // 文字列の比較は、長さが同じときだけ定数時間で比べる（総当たりのヒントを与えない）
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(unb64u(data).toString("utf8"));
    if (!body.exp || Date.now() > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

// パスワード・暗証番号の比較（時間差から中身を推測されないように）
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ── ちいさな入り口の共通処理 ───────────────────────
export function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
}

export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
