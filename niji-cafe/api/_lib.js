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

// ── パスワードの保存形式 ─────────────────────────
// スタッフ／マネージャーのパスワードは、素の文字列ではなく
// 「h1$（塩）$（ハッシュ値）」の形で保存する。
// ハッシュ値から元のパスワードは計算できないので、
// 万一データベースの中身が漏れても、パスワード自体は知られない。
//
// ※ お客様の暗証番号（PIN）はこの対象にしていない。理由は2つ：
//   1. マネージャーが画面で確認できる必要がある（お客様が忘れたときのため）
//   2. 4桁の数字は総当たりが1万通りしかなく、ハッシュ化しても実質守れない
export function hashSecret(plain) {
  const salt = crypto.randomBytes(9).toString("hex");
  const h = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  // ※ 必ず普通の文字列連結で組み立てること。
  //    テンプレート文字列で書いたとき、区切りの $ が変数展開に飲み込まれて
  //    消えてしまう事故が実際に起きた（2026-08-22）。
  return "h1$" + salt + "$" + h;
}
export const looksHashed = (s) => typeof s === "string" && s.startsWith("h1$");

// パスワード・暗証番号の比較（時間差から中身を推測されないように）
// 保存されている方がハッシュ形式なら、入力を同じ方法で変換してから比べる。
// まだ素の文字列で保存されている古いものとも比べられる（移行中のため）。
export function sameSecret(stored, given) {
  let a = String(stored ?? "");
  let b = String(given ?? "");
  if (looksHashed(a)) {
    const parts = a.split("$");           // ["h1", 塩, ハッシュ値]
    a = parts[2] || "";
    b = crypto.createHash("sha256").update((parts[1] || "") + b).digest("hex");
  } else if (/^h1[0-9a-f]{82}$/.test(a)) {
    // 2026-08-22の不具合で、区切りの$が抜けて保存された形式（h1＋塩18桁＋ハッシュ64桁）。
    // 塩とハッシュの長さは固定なので、位置で切り出せば同じように照合できる。
    // この形式の人がログインに成功すると正しい形式に書き直されるため、いずれ使われなくなる。
    const salt = a.slice(2, 20);
    b = crypto.createHash("sha256").update(salt + b).digest("hex");
    a = a.slice(20);
  }
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
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
