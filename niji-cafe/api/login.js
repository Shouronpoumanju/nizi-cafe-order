// ══════════════════════════════════════════
//  POST /api/login
//  暗証番号やパスワードの確認を「サーバーの中だけ」で行い、
//  合っていればログイン証（トークン）を返します。
//  これにより、全会員の暗証番号やスタッフのパスワードを
//  ブラウザに配る必要がなくなります。
// ══════════════════════════════════════════
import { envReady, fbGet, fbPut, fbTxn, issueToken, sameSecret, hashSecret, looksHashed, send, readBody,
         pinVer, clientIp, guardBlocked, guardFail, asList, ssLink } from "./_lib.js";

// 「この端末で記憶する」の有効期間。週に1回来られる方が毎回打ち直さなくて済むよう、90日にしてある。
// （暗証番号を変えれば、その前のログイン証は使えなくなる → pinVer）
const REMEMBER_HOURS = 24 * 90;

export default async function handler(req, res) {
  if (!envReady()) return send(res, 503, { error: "サーバーの設定が未完了です" });

  // ── ログイン画面に出す「アカウント名の一覧」 ──────────────────
  // パスワードは絶対に返さない。名前と役割だけ。
  // これがないとスタッフがログイン画面でアカウントを選べないため、
  // ログイン前でも取得できるようにしてある。
  // ── 健康診断（GET /api/login?health=1） ───────────────────────
  // 「取り合いに強い書き込み」（ETag → _lib.js の fbTxn）が本物の Firebase で動くかを確かめる。
  // 2つ同時に書いて、両方とも数に入れば合格。個人情報には一切触れない（cafe_v4_selftest だけ）。
  // 何度も呼ばれても書き込みが増えないよう、1分に1回まで。
  if (req.method === "GET" && /[?&]health=1/.test(String(req.url || ""))) {
    try {
      const last = await fbGet("cafe_v4_selftest");
      if (last && Date.now() - (last.t || 0) < 60 * 1000) return send(res, 200, { ok: !!last.ok, cached: true, n: last.n, at: last.at, ss: last.ss || null });
      const before = (last && last.n) || 0;
      const bump = () => fbTxn("cafe_v4_selftest", (cur) => {
        const n = ((cur && cur.n) || 0) + 1;
        return { value: { ...(cur || {}), n, t: Date.now() }, result: n };
      });
      await Promise.all([bump(), bump()]);
      const after = await fbGet("cafe_v4_selftest");
      const ok = after && after.n === before + 2;
      // 教会のシークレット窓口とつながるか（名前の一覧は返さない。人数だけ）
      const p = await ssLink({ act: "ping" });
      const ss = p.ok ? { ok: true, people: Array.isArray(p.names) ? p.names.length : null } : { ok: false, code: p.code, status: p.status };
      await fbPut("cafe_v4_selftest", { ...after, ok, ss, at: new Date().toISOString() });
      // 毎晩の自動処理（archive.js）が最後に動いた時刻（止まっていたら気づけるように）
      let lastNightly = null;
      try { const nt = await fbGet("cafe_v4_nightly"); if (nt) lastNightly = { at: nt.at, by: nt.by }; } catch {}
      return send(res, 200, { ok, before, after: after && after.n, lastNightly, ss, version: process.env.VERCEL_GIT_COMMIT_SHA ? String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 7) : null });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

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

  const ip = clientIp(req);

  // 暗証番号の総当たりを現実的でなくするための待ち時間（0.4秒）
  await new Promise((r) => setTimeout(r, 400));

  const { role, pin, name, password, remember } = readBody(req);
  // 間違いが続いた回線は15分止める（回数はデータベースに残すので、同時に送られても効く）。
  // お客様とスタッフは別々に数える（お客様の打ち間違いで、スタッフが入れなくならないように）。
  const gkind = role === "customer" ? "login_cust" : "login_staff";
  if (await guardBlocked(gkind, ip)) {
    return send(res, 429, { error: "何度もまちがえたため、15分ほど待ってからお試しください。わからないときはスタッフへお声かけください" });
  }

  try {
    // ── お客様：暗証番号でログイン ──────────────────
    if (role === "customer") {
      // 桁数は決め打ちにしない。実際の会員データには4桁以外の暗証番号も存在するため、
      // ここで長さを制限すると、その人がログインできなくなる。
      if (!/^\d{1,8}$/.test(String(pin || ""))) {
        return send(res, 400, { error: "暗証番号は数字で入力してください" });
      }
      const list = asList(await fbGet("cafe_v4_customers"));
      const matches = list.filter((c) => c && sameSecret(c.pin, pin));
      // 同じ暗証番号の人が複数いる場合は、誰のものか決められないので断る
      if (matches.length !== 1) {
        // 同じ番号の人が2人いる（名簿の問題）ときは、打ち間違いとして数えない
        if (matches.length === 0) await guardFail("login_cust", ip);
        return send(res, 401, { error: matches.length > 1 ? "この暗証番号は使えません。スタッフにお声かけください" : "暗証番号が違います" });
      }
      const me = matches[0];
      return send(res, 200, {
        // remember: 「この端末で記憶する」を選んだときは90日間有効（毎回の暗証番号入力を省くため）
        // pv: 暗証番号の印。番号を変えると、この証は使えなくなる
        token: issueToken({ r: "customer", id: me.id, pv: pinVer(me) }, remember ? REMEMBER_HOURS : 12),
        customer: me,
      });
    }

    // ── スタッフ／マネージャー：名前とパスワードでログイン ──
    if (role === "staff" || role === "manager") {
      const key = role === "staff" ? "cafe_v4_staff_accounts" : "cafe_v4_manager_accounts";
      const list = asList(await fbGet(key));
      const acc = list.find(
        (a) => a && String(a.name) === String(name) && sameSecret(a.password, password)
      );
      if (!acc) { await guardFail("login_staff", ip); return send(res, 401, { error: "名前かパスワードが違います" }); }

      // パスワードがまだ素の文字列で保存されていたら、この機会にハッシュ形式へ
      // 変換して保存し直す（ログインできた＝正しいパスワードなので、いま変換できる）。
      // 全員が一度ずつログインすれば、素のパスワードはデータベースから消える。
      if (!looksHashed(acc.password)) {
        try {
          await fbPut(key, list.map((a) =>
            a && a.id === acc.id ? { ...a, password: hashSecret(password) } : a
          ));
        } catch (e) { console.error("パスワードのハッシュ化に失敗", e); }
      }

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
