// ══════════════════════════════════════════
//  POST /api/login
//  暗証番号やパスワードの確認を「サーバーの中だけ」で行い、
//  合っていればログイン証（トークン）を返します。
//  これにより、全会員の暗証番号やスタッフのパスワードを
//  ブラウザに配る必要がなくなります。
// ══════════════════════════════════════════
import { envReady, fbGet, issueToken, sameSecret, send, readBody } from "./_lib.js";

// 総当たりを遅くするための、ごく簡単な回数制限。
// Serverless は実行環境が使い回されたときだけ有効なので、これは
// 「同じ環境に連続で来る総当たりを鈍らせる」ためのもの。本命は下の待ち時間。
const attempts = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  attempts.set(ip, rec);
  return rec.n > 30;
}

export default async function handler(req, res) {
  if (!envReady()) return send(res, 503, { error: "サーバーの設定が未完了です" });

  // ── ログイン画面に出す「アカウント名の一覧」 ──────────────────
  // パスワードは絶対に返さない。名前と役割だけ。
  // これがないとスタッフがログイン画面でアカウントを選べないため、
  // ログイン前でも取得できるようにしてある。
  if (req.method === "GET") {
    try {
      const [staff, mgrs] = await Promise.all([
        fbGet("cafe_v4_staff_accounts"), fbGet("cafe_v4_manager_accounts"),
      ]);
      const pick = (list, role) => (Array.isArray(list) ? list : [])
        .filter(Boolean)
        .map(a => ({ id: a.id, name: a.name, isChief: !!a.isChief, _role: role }));
      return send(res, 200, { accounts: [...pick(mgrs, "manager"), ...pick(staff, "staff")] });
    } catch (e) {
      console.error("account list failed", e);
      return send(res, 500, { error: "アカウント一覧の取得に失敗しました" });
    }
  }

  if (req.method !== "POST") return send(res, 405, { error: "POST のみ受け付けます" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
  if (tooManyTries(ip)) return send(res, 429, { error: "しばらく時間をおいてからお試しください" });

  // 暗証番号の総当たりを現実的でなくするための待ち時間（0.4秒）
  await new Promise((r) => setTimeout(r, 400));

  const { role, pin, name, password } = readBody(req);

  try {
    // ── お客様：暗証番号でログイン ──────────────────
    if (role === "customer") {
      // 桁数は決め打ちにしない。実際の会員データには4桁以外の暗証番号も存在するため、
      // ここで長さを制限すると、その人がログインできなくなる。
      if (!/^\d{1,8}$/.test(String(pin || ""))) {
        return send(res, 400, { error: "暗証番号は数字で入力してください" });
      }
      const list = (await fbGet("cafe_v4_customers")) || [];
      const matches = list.filter((c) => c && sameSecret(c.pin, pin));
      // 同じ暗証番号の人が複数いる場合は、誰のものか決められないので断る
      if (matches.length !== 1) {
        return send(res, 401, { error: "暗証番号が違います" });
      }
      const me = matches[0];
      return send(res, 200, {
        token: issueToken({ r: "customer", id: me.id }),
        customer: me,
      });
    }

    // ── スタッフ／マネージャー：名前とパスワードでログイン ──
    if (role === "staff" || role === "manager") {
      const key = role === "staff" ? "cafe_v4_staff_accounts" : "cafe_v4_manager_accounts";
      const list = (await fbGet(key)) || [];
      const acc = list.find(
        (a) => a && String(a.name) === String(name) && sameSecret(a.password, password)
      );
      if (!acc) return send(res, 401, { error: "名前かパスワードが違います" });
      // パスワードは返さない
      const { password: _pw, ...safe } = acc;
      return send(res, 200, {
        token: issueToken({ r: role, id: acc.id, name: acc.name }),
        account: safe,
      });
    }

    return send(res, 400, { error: "role を customer / staff / manager のどれかにしてください" });
  } catch (e) {
    console.error("login failed", e);
    return send(res, 500, { error: "ログイン処理に失敗しました" });
  }
}
