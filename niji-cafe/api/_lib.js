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

// ── 「読んで・変えて・書く」を安全に行う（取り合いの防止） ──────────
// 2台の端末がほぼ同時に同じ場所を書き換えると、あとから書いた方が先の変更を消してしまう。
// Firebase の ETag（その時点の中身の印）を使い、
//   1. 中身と印を読む
//   2. 変える
//   3. 「印が読んだときのままなら書く」と頼む（if-match）
//   4. 誰かが先に書いていたら（412）、最初から読み直してやり直す
// とすることで、取り合いが起きても片方の変更が黙って消えることがなくなる。
//
// mutate(今の中身) は次のどれかを返す：
//   { value: 新しい中身, result: 呼び出し元に返したいもの } … 書く
//   { abort: 呼び出し元に返したいもの }                      … 書かずにやめる
export class TxnAbort extends Error {
  constructor(status, body) { super(body && body.error || "abort"); this.status = status; this.body = body; }
}
export async function fbTxn(path, mutate, tries = 8) {
  const base = `${DB_BASE}/${path}.json?auth=${encodeURIComponent(DB_SECRET)}`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(base, { headers: { "X-Firebase-ETag": "true" } });
    if (!r.ok) throw new Error(`Firebase ${r.status}`);
    const etag = r.headers.get("ETag") || r.headers.get("etag");
    const cur = await r.json();
    const out = await mutate(cur);
    if (!out || "abort" in out) return out ? out.abort : undefined;
    const body = JSON.stringify(out.value);
    if (!etag) {
      // 印が返ってこない（想定外）。今までどおりの書き方で書く。
      console.warn("ETag が取得できなかったため、通常の保存をします", path);
      await fbPut(path, out.value);
      return out.result;
    }
    const w = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", "if-match": etag }, body });
    if (w.ok) return out.result;
    if (w.status === 412 || w.status === 429 || w.status >= 500) {
      // 412：誰かが先に書いた／429・5xx：Firebase が一時的に不調。少し待って最初から読み直す
      await new Promise((ok) => setTimeout(ok, 40 + Math.random() * 120 * (i + 1)));
      continue;
    }
    if (w.status === 400) {
      // 条件付きの書き込み（if-match）そのものが受け付けられない場合だけ、通常の保存に切り替える
      console.error("条件付きの保存が使えないため、通常の保存に切り替えます", path, w.status);
      await fbPut(path, out.value);
      return out.result;
    }
    throw new Error(`Firebase ${w.status}`);
  }
  throw new TxnAbort(503, { error: "混み合っています。もう一度押してください" });
}

// ── 教会のホームページ（yamechurch.com）のシークレット窓口への問い合わせ ──────
// 合言葉（SS_LINK_KEY）は Vercel の環境変数だけに置く。画面には絶対に渡さない。ログにも出さない。
// 名乗り（user-agent）は nijicafe-server/1.0。curl などの名乗りは教会側の見張りが遮断するため。
// 戻り値：{ ok:true, ...中身 } か { ok:false, status, code }（code: nokey / key / notjoined / nodraw / busy / network など）
const SS_URL = "https://yamechurch.com/api/ss-link";
export async function ssLink(body) {
  const key = process.env.SS_LINK_KEY || "";
  if (!key) return { ok: false, status: 503, code: "nokey" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 7000);
  try {
    const r = await fetch(SS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ss-key": key, "user-agent": "nijicafe-server/1.0" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch { j = {}; }
    if (!r.ok) {
      const raw = String(j.error || j.code || j.reason || text || "").toLowerCase();
      const code = r.status === 429 ? "busy"
        : /nodraw/.test(raw) ? "nodraw" : /notjoined/.test(raw) ? "notjoined"
        : r.status === 403 ? "key" : r.status === 503 ? "nokey" : "error";
      return { ok: false, status: r.status, code };
    }
    return { ok: true, ...j };
  } catch {
    return { ok: false, status: 0, code: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// Firebase の「新しい方から◯件」の取得結果（{"0":…,"1":…}）を配列に直す
export function asList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v && typeof v === "object") {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]).filter(Boolean);
  }
  return [];
}

// アプリの版（Vercel が公開ごとに付ける番号の先頭7文字）。画面の版と比べて、古い画面に知らせる。
export const APP_VERSION = String(process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);

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

// お客様のログイン証に入れる「暗証番号の印」。
// 暗証番号を変えると印が変わるので、変える前に発行したログイン証は使えなくなる
// （スマホを落とした・番号を知られた、というときに番号を変えれば締め出せる）。
export function pinVer(c) {
  return crypto.createHash("sha256").update(String(c && c.id) + ":" + String(c && c.pin)).digest("hex").slice(0, 12);
}

// ── 間違いが続いたときの一時停止（総当たり対策） ──────────────
// 以前はサーバーの記憶（実行環境ごと）で数えていたため、同時にたくさん送られると効かなかった。
// 間違えた回数をデータベースに残し、同じ回線から15分に上限（下の GUARD_LIMITS）を超えたら止める。
// ※ 教会の Wi-Fi は皆さん同じ回線になるので、普通の打ち間違いで止まらないよう、ゆるめにしてある。
const GUARD_WINDOW = 15 * 60 * 1000;
// 種類ごとの上限。お客様（login_cust）はゆるめ、スタッフ（login_staff）とマネージャーのパスワード（mgrpw）は30回。
// お客様の打ち間違いが続いても、同じ回線のスタッフのログインは止まらないよう、数え方を分けてある。
const GUARD_LIMITS = { login_cust: 80, login_staff: 30, mgrpw: 30 };
const limitOf = (kind) => GUARD_LIMITS[kind] || 30;
const guardPath = (kind, ip) =>
  `cafe_v4_guard/${kind}/` + crypto.createHash("sha256").update(String(ip || "unknown")).digest("hex").slice(0, 16);
export const clientIp = (req) => String((req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();
export async function guardBlocked(kind, ip) {
  try {
    const g = await fbGet(guardPath(kind, ip));
    return !!(g && Date.now() - (g.t || 0) < GUARD_WINDOW && (g.n || 0) >= limitOf(kind));
  } catch { return false; }
}
export async function guardFail(kind, ip) {
  try {
    const p = guardPath(kind, ip);
    const g = await fbGet(p);
    const fresh = g && Date.now() - (g.t || 0) < GUARD_WINDOW;
    await fbPut(p, { n: (fresh ? g.n || 0 : 0) + 1, t: fresh ? g.t : Date.now() });
  } catch {}
}

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
  if (APP_VERSION) res.setHeader("X-App-Version", APP_VERSION);
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
