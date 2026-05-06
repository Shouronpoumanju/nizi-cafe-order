import { useState, useEffect, useRef } from "react";

// ══════════════════════════════════════════
//  🔥 Firebase REST API 設定
// ══════════════════════════════════════════
const DB_BASE = "https://nizicafe-card-default-rtdb.asia-southeast1.firebasedatabase.app";

const dbSet = (key, val) =>
  fetch(`${DB_BASE}/${key}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(val),
  }).catch(() => {});

const dbGet = (key) =>
  fetch(`${DB_BASE}/${key}.json`)
    .then(r => r.json())
    .catch(() => null);

// ══════════════════════════════════════════
//  設定
// ══════════════════════════════════════════
const DEFAULT_MANAGER_ACCOUNTS = [
  { id:"mg1", name:"マネージャー", password:"5678", linkedCustomerId:null },
]; // マネージャーアカウント初期値

const DEFAULT_STAFF_ACCOUNTS = [
  { id:"st1", name:"山田 花子", password:"1234" },
  { id:"st2", name:"田中 一郎", password:"2345" },
];

// benefit.type:
//   "monthly"   → 毎月1回リセット、スタッフが「使用」ボタンで消費
//   "always_discount" → 毎回自動割引（amount: 固定額 or "half"）
const RANKS = [
  { name:"ブロンズ",    min:2,  color:"#cd7f32", gem:"🟫", bg:"linear-gradient(135deg,#3b1f0a,#6b3a1f)", glow:"#cd7f32",
    benefit:{ type:"monthly",          desc:"トッピング1回無料",       icon:"🧁" } },
  { name:"シルバー",    min:5,  color:"#c0c0c0", gem:"⬜", bg:"linear-gradient(135deg,#1a1a2e,#3a3a5c)", glow:"#c0c0c0",
    benefit:{ type:"monthly",          desc:"トッピング2回無料",       icon:"🧁🧁" } },
  { name:"ゴールド",    min:7,  color:"#ffd700", gem:"🟨", bg:"linear-gradient(135deg,#2a1f00,#5a4500)", glow:"#ffd700",
    benefit:{ type:"monthly",          desc:"トッピング3回無料",       icon:"🧁🧁🧁" } },
  { name:"プラチナ",    min:10, color:"#e0dcd8", gem:"🔘", bg:"linear-gradient(135deg,#1a1a1a,#3a3a3a)", glow:"#e0dcd8",
    benefit:{ type:"monthly",          desc:"コーヒー1杯無料",         icon:"☕" } },
  { name:"チタン",      min:13, color:"#9da8b0", gem:"🩶", bg:"linear-gradient(135deg,#0e1418,#1e2a32)", glow:"#9da8b0",
    benefit:{ type:"monthly",          desc:"指定ドリンク1杯無料",     icon:"🥤" } },
  { name:"サファイア",  min:16, color:"#4fa3e8", gem:"🔷", bg:"linear-gradient(135deg,#001030,#002060)", glow:"#4fa3e8",
    benefit:{ type:"monthly",          desc:"好きなドリンク1杯無料",   icon:"🍹" } },
  { name:"ルビー",      min:20, color:"#e0115f", gem:"🟥", bg:"linear-gradient(135deg,#1a0010,#4a0030)", glow:"#e0115f",
    benefit:{ type:"always_discount",  desc:"毎回50円引き",            icon:"💸", amount:50 } },
  { name:"エメラルド",  min:35, color:"#50c878", gem:"🟩", bg:"linear-gradient(135deg,#001a08,#003a14)", glow:"#50c878",
    benefit:{ type:"always_discount",  desc:"毎回100円引き",           icon:"💸", amount:100 } },
  { name:"ダイヤモンド",min:50, color:"#b9f2ff", gem:"💎", bg:"linear-gradient(135deg,#001020,#002040)", glow:"#b9f2ff",
    benefit:{ type:"always_discount",  desc:"毎回半額",                icon:"⭐", amount:"half" } },
];

const NO_RANK = {
  name:"ランクなし", min:0, color:"#555", gem:"−",
  bg:"linear-gradient(135deg,#111111,#1a1a1a)", glow:"#444",
  benefit:{ type:"none", desc:"ランクなし", icon:"−" },
};

function getRank(p) {
  if (p < 2) return NO_RANK;
  let r = RANKS[0];
  for (const x of RANKS) if (p >= x.min) r = x;
  return r;
}
// 昨年・今年の高い方のランクを返す
function getEffectiveRank(customer) {
  const r1 = getRank(customer.rankBasis ?? 0);
  const r2 = getRank(customer.currentYearPurchases ?? 0);
  const i1 = RANKS.findIndex(r => r.name === r1.name);
  const i2 = RANKS.findIndex(r => r.name === r2.name);
  return i2 > i1 ? r2 : r1;
}
function nextRank(p)   { for(const x of RANKS) if(p<x.min) return x; return null; }
function currentMonth(){ return new Date().toISOString().slice(0,7); } // "2026-05"
function currentWeek() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// トッピング最大選択数（ランク別）
function getToppingMax(rank) {
  if (!rank) return 0;
  return rank.name==="ブロンズ"?1 : rank.name==="シルバー"?2 : rank.name==="ゴールド"?3 : 0;
}
// 今月の残りトッピング使用可能数
function getToppingAvailable(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return 0;
  if (customer.toppingRemainingMonth !== currentMonth()) return max;
  return customer.toppingRemaining ?? max;
}
// 非トッピング特典が使用済みか
function isBenefitUsed(customer) {
  return customer.benefitUsedMonth === currentMonth();
}
// トッピング特典が完全使用済みか（0回になった）
function isToppingFullyUsed(customer, rank) {
  const max = getToppingMax(rank);
  if (!max) return false;
  if (customer.toppingRemainingMonth !== currentMonth()) return false;
  return (customer.toppingRemaining ?? max) === 0;
}

// always_discount の割引額を計算
function calcDiscount(rank, total) {
  if (rank.benefit.type !== "always_discount") return 0;
  if (rank.benefit.amount === "half") return Math.floor(total / 2);
  return Math.min(rank.benefit.amount, total);
}

// currentYearPurchases: 今年の購入回数（1/1にリセット）
// rankBasis: ランク判定に使う値（前年の購入回数、1/1に更新）
// dataYear: currentYearPurchasesが属する年
const THIS_YEAR = new Date().getFullYear();
const SAMPLE = [
  { id:"1001", name:"田中 美咲", pin:"1234", balance:4000, currentYearPurchases:10, rankBasis:10, dataYear:THIS_YEAR, joined:"2024-11-01", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-2, purchases:6,  rankName:"ゴールド",    rankGem:"🟨", rankColor:"#ffd700" },
      { year:THIS_YEAR-1, purchases:10, rankName:"プラチナ",    rankGem:"🔘", rankColor:"#e0dcd8" },
    ]},
  { id:"1002", name:"佐藤 健太", pin:"5678", balance:2000, currentYearPurchases:5,  rankBasis:5,  dataYear:THIS_YEAR, joined:"2025-02-14", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-1, purchases:3, rankName:"ブロンズ", rankGem:"🟫", rankColor:"#cd7f32" },
    ]},
  { id:"1003", name:"鈴木 花子", pin:"9999", balance:0, currentYearPurchases:52, rankBasis:52, dataYear:THIS_YEAR, joined:"2024-05-20", history:[], benefitUsedMonth:null,
    yearlyStats:[
      { year:THIS_YEAR-3, purchases:20, rankName:"ルビー",       rankGem:"🟥", rankColor:"#e0115f" },
      { year:THIS_YEAR-2, purchases:38, rankName:"エメラルド",   rankGem:"🟩", rankColor:"#50c878" },
      { year:THIS_YEAR-1, purchases:52, rankName:"ダイヤモンド", rankGem:"💎", rankColor:"#b9f2ff" },
    ]},
];

function checkYearRollover(c) {
  const year = new Date().getFullYear();
  if (c.currentYearPurchases === undefined) {
    // 旧データ移行
    return { ...c, pin: c.pin||c.phone||"0000", currentYearPurchases: c.purchases||0, rankBasis: c.purchases||0, dataYear: year, yearlyStats: c.yearlyStats||[] };
  }
  if ((c.dataYear || year) < year) {
    const prevYear      = c.dataYear || year - 1;
    const prevPurchases = c.currentYearPurchases;
    const prevRank      = getRank(prevPurchases);
    const newStat       = { year: prevYear, purchases: prevPurchases, rankName: prevRank.name, rankGem: prevRank.gem, rankColor: prevRank.color };
    const existingStats = (c.yearlyStats || []).filter(s => s.year !== prevYear);
    return {
      ...c,
      rankBasis:            prevPurchases,
      currentYearPurchases: 0,
      dataYear:             year,
      benefitUsedMonth:     null,
      toppingRemaining:     null,
      toppingRemainingMonth: null,
      yearlyStats:          [newStat, ...existingStats].sort((a,b)=>b.year-a.year).slice(0,10),
      history: [{
        type:"year_reset", prevPurchases,
        newRank: getRank(prevPurchases).name,
        performer:"システム", date: new Date().toLocaleString("ja-JP"),
      }, ...(c.history||[])].slice(0, 60),
    };
  }
  return { ...c, yearlyStats: c.yearlyStats||[] };
}

const TOPPINGS = [
  { id:"top1", name:"チョコソース",     emoji:"🍫" },
  { id:"top2", name:"キャラメルソース", emoji:"🍯" },
];

const DEFAULT_MENU = [
  { id:"m1",  category:"コーヒー",   name:"エスプレッソ",     price:400, emoji:"☕" },
  { id:"m2",  category:"コーヒー",   name:"カフェラテ",       price:550, emoji:"🥛" },
  { id:"m3",  category:"コーヒー",   name:"カプチーノ",       price:550, emoji:"☁️" },
  { id:"m4",  category:"コーヒー",   name:"アメリカーノ",     price:480, emoji:"🫖" },
  { id:"m14", category:"コーヒー",   name:"アイスコーヒー",   price:480, emoji:"🧊" },
  { id:"m15", category:"コーヒー",   name:"ホットコーヒー",   price:450, emoji:"☕" },
  { id:"m5",  category:"ドリンク",   name:"紅茶",             price:450, emoji:"🍵" },
  { id:"m6",  category:"ドリンク",   name:"オレンジジュース", price:500, emoji:"🍊" },
  { id:"m16", category:"ドリンク",   name:"ソーダ",           price:430, emoji:"🫧" },
  { id:"m17", category:"トッピング", name:"チョコソース",     price:100, emoji:"🍫" },
  { id:"m18", category:"トッピング", name:"キャラメルソース", price:100, emoji:"🍯" },
  { id:"m7",  category:"フード",     name:"クロワッサン",     price:380, emoji:"🥐" },
  { id:"m8",  category:"フード",     name:"チーズケーキ",     price:650, emoji:"🍰" },
  { id:"m9",  category:"フード",     name:"サンドイッチ",     price:750, emoji:"🥪" },
  { id:"m10", category:"フード",     name:"スコーン",         price:420, emoji:"🫓" },
];

// ══════════════════════════════════════════
//  ROOT
// ══════════════════════════════════════════
export default function App() {
  const [screen,         setScreen]         = useState("home");
  const [customers,      setCustomers]      = useState([]);
  const [menu,           setMenu]           = useState(DEFAULT_MENU);
  const [orders,         setOrders]         = useState([]);
  const [staffAccounts,  setStaffAccounts]  = useState(DEFAULT_STAFF_ACCOUNTS);
  const [managerAccounts, setManagerAccounts]= useState(DEFAULT_MANAGER_ACCOUNTS);
  const [designatedDrink,setDesignatedDrink]= useState(null);
  const [vipGiftDrink,   setVipGiftDrink]   = useState(null);
  const [staffRole,      setStaffRole]      = useState(null);
  const [staffName,      setStaffName]      = useState("");
  const [loaded,         setLoaded]         = useState(false);

  // Firebase REST API + ポーリング（3秒ごとに同期）
  useEffect(() => {
    let mounted = true;

    const loadAll = async () => {
      try {
        const [cust, menu_, ord, dd, vip, staff, mgpw] = await Promise.all([
          dbGet("cafe_v4_customers"),
          dbGet("cafe_v4_menu"),
          dbGet("cafe_v4_orders"),
          dbGet("cafe_v4_designated_drink"),
          dbGet("cafe_v4_vip_gift_drink"),
          dbGet("cafe_v4_staff_accounts"),
          dbGet("cafe_v4_manager_pw"),
        ]);
        if (!mounted) return;
        const raw = cust || SAMPLE;
        const migrated = raw.map(checkYearRollover);
        setCustomers(migrated);
        if (!cust) dbSet("cafe_v4_customers", migrated);
        else {
          const changed = migrated.some((c,i)=>raw[i]&&c.dataYear!==raw[i].dataYear);
          if (changed) dbSet("cafe_v4_customers", migrated);
        }
        if (menu_)  setMenu(menu_);
        if (ord)    setOrders(ord);
        if (dd)     setDesignatedDrink(dd);
        if (vip)    setVipGiftDrink(vip);
        if (staff)  setStaffAccounts(staff);
        if (mgpw)   setManagerPassword(mgpw);
      } catch { if (mounted) setCustomers(SAMPLE); }
      if (mounted) setLoaded(true);
    };

    loadAll();

    // リアルタイム同期（3秒ポーリング）
    const timer = setInterval(async () => {
      if (!mounted) return;
      try {
        const [cust, ord] = await Promise.all([
          dbGet("cafe_v4_customers"),
          dbGet("cafe_v4_orders"),
        ]);
        if (!mounted) return;
        if (cust) setCustomers(cust.map(checkYearRollover));
        if (ord)  setOrders(ord);
      } catch {}
    }, 3000);

    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const saveC           = (list) => { setCustomers(list);        dbSet("cafe_v4_customers",        list); };
  const saveMenu        = (list) => { setMenu(list);             dbSet("cafe_v4_menu",             list); };
  const saveOrders      = (list) => { setOrders(list);           dbSet("cafe_v4_orders",           list); };
  const saveDesignatedDrink = (item)=> { setDesignatedDrink(item); dbSet("cafe_v4_designated_drink", item); };
  const saveVipGiftDrink    = (item)=> { setVipGiftDrink(item);    dbSet("cafe_v4_vip_gift_drink",   item); };
  const saveManagerAccounts = (list)=> { setManagerAccounts(list); dbSet("cafe_v4_manager_accounts", list); };
  const saveStaffAccounts   = (list)=> { setStaffAccounts(list);   dbSet("cafe_v4_staff_accounts",   list); };

  if (!loaded) return <div style={S.loading}>読み込み中...</div>;

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      {screen==="home"     && <Home setScreen={setScreen} setStaffRole={setStaffRole}/>}
      {screen==="customer" && <CustomerView customers={customers} menu={menu} orders={orders} saveOrders={saveOrders} saveC={saveC} designatedDrink={designatedDrink} staffAccounts={staffAccounts} vipGiftDrink={vipGiftDrink} setScreen={setScreen}/>}
      {screen==="login"    && <StaffLogin setScreen={setScreen} setStaffRole={setStaffRole} setStaffName={setStaffName} staffAccounts={staffAccounts} managerAccounts={managerAccounts}/>}
      {screen==="pos"      && <POS customers={customers} menu={menu} orders={orders} staffRole={staffRole} staffName={staffName} staffAccounts={staffAccounts} saveStaffAccounts={saveStaffAccounts} managerAccounts={managerAccounts} saveManagerAccounts={saveManagerAccounts} saveC={saveC} saveMenu={saveMenu} saveOrders={saveOrders} designatedDrink={designatedDrink} saveDesignatedDrink={saveDesignatedDrink} vipGiftDrink={vipGiftDrink} saveVipGiftDrink={saveVipGiftDrink} setScreen={setScreen}/>}
    </div>
  );
}


// ══════════════════════════════════════════
//  HOME
// ══════════════════════════════════════════
function Home({ setScreen }) {
  return (
    <div style={S.homeOuter}>
      {/* 背景の虹グラデーション装飾 */}
      <div style={S.homeBgCircle1}/>
      <div style={S.homeBgCircle2}/>
      <div style={S.homeBgCircle3}/>

      <div style={S.homeWrap}>
        {/* ロゴ */}
        <div style={S.rainbowLogoWrap}>
          <div style={S.rainbowLogoInner}>
            <span style={{fontSize:52}}>🌈</span>
          </div>
          <div style={S.rainbowGlow}/>
        </div>

        {/* ブランド名 */}
        <div style={{position:"relative",marginTop:6}}>
          <h1 style={S.brandRainbow}>
            {"虹カフェ".split("").map((ch, i) => (
              <span key={i} style={{color:["#ff6b9d","#ff9f43","#ffd700","#7bed9f","#70a1ff","#a29bfe"][i % 6],
                display:"inline-block", animation:`letterFloat ${0.6+i*0.15}s ease-in-out infinite alternate`}}>
                {ch}
              </span>
            ))}
          </h1>
          <div style={S.brandUnderline}/>
        </div>

        <p style={S.taglineRainbow}>✨ デジタルチケット & メンバーシップ ✨</p>

        {/* ボタン */}
        <div style={S.homeBtns}>
          <button className="btn-rainbow" onClick={()=>setScreen("customer")}>
            <span style={{fontSize:"1.1rem"}}>🎫</span>
            <span>チケットを確認する</span>
          </button>
          <button className="btn-crystal" onClick={()=>setScreen("login")}>
            <span style={{fontSize:"1rem"}}>🔑</span>
            <span>スタッフ入口</span>
          </button>
        </div>

        {/* デコ */}
        <div style={S.decoRow}>
          {["🌟","💎","🌺","✨","🌸"].map((e,i)=>(
            <span key={i} style={{fontSize:"1.1rem",opacity:0.7,animation:`floatDeco ${1.2+i*0.3}s ease-in-out infinite alternate`}}>{e}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  CUSTOMER VIEW
// ══════════════════════════════════════════
function CustomerView({ customers, menu, orders, saveOrders, saveC, designatedDrink, staffAccounts, vipGiftDrink, setScreen }) {
  const [input,        setInput]        = useState("");
  const [found,        setFound]        = useState(null);
  const [err,          setErr]          = useState("");
  const [cvTab,        setCvTab]        = useState("ticket");
  const [cart,         setCart]         = useState([]);
  const [ordered,      setOrdered]      = useState(false);
  const [benefitItems, setBenefitItems] = useState([]); // 無料特典アイテム
  const [benefitUsed,  setBenefitUsed]  = useState(false); // この注文で特典使用

  const search = () => {
    setErr("");
    const c = customers.find(c => c.pin === input.trim());
    if (c) { setFound(c); setCvTab("ticket"); setCart([]); setOrdered(false); setBenefitItems([]); setBenefitUsed(false); }
    else setErr("暗証番号が一致しませんでした");
  };

  const rank         = found ? getEffectiveRank(found) : null;
  const next         = found ? nextRank(found.currentYearPurchases ?? 0) : null;
  const used         = found ? isBenefitUsed(found) : false;
  const isAlways     = rank?.benefit.type === "always_discount";
  const isMonthly    = rank?.benefit.type === "monthly";
  const toppingMax   = rank ? getToppingMax(rank) : 0;
  const isToppingRank = toppingMax > 0;
  // トッピング: 残り使用回数
  const availableTopping = (found && isToppingRank) ? getToppingAvailable(found, rank) : 0;
  const toppingFullyUsed = (found && isToppingRank) ? isToppingFullyUsed(found, rank) : false;
  // 特典が使えるか
  const showBenefit = isMonthly && (isToppingRank ? !toppingFullyUsed : !used);
  const cyp          = found ? (found.currentYearPurchases ?? 0) : 0;
  const nextYearRank = found ? getRank(cyp) : null;
  const pct = found && next
    ? Math.min(100, ((cyp - getRank(cyp).min) / (next.min - getRank(cyp).min)) * 100)
    : 100;

  const myPendingOrder = found ? orders.find(o=>o.customerId===found.id && o.status==="pending") : null;
  // スタッフ・マネージャーリンク確認
  const linkedStaff = found ? staffAccounts.find(s=>s.linkedCustomerId===found.id) : null;
  const isStaffAccount = !!linkedStaff;
  const categories = [...new Set(menu.map(m=>m.category))];
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  // スタッフ割引：常に全品10%オフ
  const discountRate  = linkedStaff ? (linkedStaff.discountRate ?? 10) : 0;
  const staffDiscount = isStaffAccount ? Math.floor(subtotal * discountRate / 100) : 0;
  const discount = rank ? calcDiscount(rank, subtotal) : 0;
  const isSpecial = !!found?.isSpecial;
  const total    = isSpecial ? 0 : Math.max(0, subtotal - discount - staffDiscount);

  const addToCart = (item) => setCart(prev=>{
    const ex=prev.find(c=>c.id===item.id);
    return ex ? prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c) : [...prev,{...item,qty:1}];
  });
  const removeOne = (id) => setCart(prev=>{
    const ex=prev.find(c=>c.id===id);
    if(!ex) return prev;
    return ex.qty===1 ? prev.filter(c=>c.id!==id) : prev.map(c=>c.id===id?{...c,qty:c.qty-1}:c);
  });

  const placeOrder = () => {
    if ((cart.length===0 && benefitItems.length===0) || !found) return;
    const order = {
      orderId: `ord_${Date.now()}`,
      customerId: found.id, customerName: found.name,
      rankName: rank.name, rankColor: rank.color, rankGem: rank.gem,
      items: cart, benefitItems,
      subtotal, discount, staffDiscount: isSpecial ? 0 : staffDiscount, total,
      usedBenefit: benefitUsed,
      usedToppingCount: benefitItems.length,
      isSpecial: isSpecial || false,
      staffLinked: linkedStaff ? linkedStaff.name : null,
      status: "pending",
      createdAt: new Date().toLocaleString("ja-JP"),
    };
    saveOrders([order, ...orders.filter(o=>!(o.customerId===found.id && o.status==="pending"))]);

    let updated = { ...found };
    if (benefitUsed) {
      if (isToppingRank) {
        const newRemaining = availableTopping - benefitItems.length;
        updated = { ...updated, toppingRemaining: newRemaining, toppingRemainingMonth: currentMonth() };
      } else {
        updated = { ...updated, benefitUsedMonth: currentMonth() };
      }
      saveC(customers.map(c=>c.id===found.id ? updated : c));
      setFound(updated);
    }
    setCart([]); setBenefitItems([]); setBenefitUsed(false); setOrdered(true);
  };

  const cancelOrder = () => {
    if (!myPendingOrder) return;
    let updated = { ...found };
    if (myPendingOrder.usedBenefit) {
      if (isToppingRank) {
        const restored = (found.toppingRemaining ?? 0) + (myPendingOrder.usedToppingCount || 0);
        updated = { ...updated, toppingRemaining: Math.min(restored, toppingMax), toppingRemainingMonth: currentMonth() };
      } else {
        updated = { ...updated, benefitUsedMonth: null };
      }
      saveC(customers.map(c=>c.id===found.id ? updated : c));
      setFound(updated);
    }
    saveOrders(orders.filter(o=>o.orderId!==myPendingOrder.orderId));
    setOrdered(false);
  };

  return (
    <div style={S.page}>
      <button className="back-btn" onClick={()=>{setScreen("home");setFound(null);setInput("");}}>← 戻る</button>
      <h2 style={S.title}>チケット確認</h2>

      {!found ? (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <p style={S.hint}>暗証番号を入力してください</p>
          <input style={S.input} type="password" placeholder="暗証番号" value={input}
            onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()}/>
          {err && <p style={S.err}>{err}</p>}
          <button className="btn-gold" onClick={search}>確認する</button>
        </div>
      ) : (
        <div>
          <div style={{display:"flex",background:"#0d0d0d",borderRadius:12,padding:4,marginBottom:14,gap:4}}>
            {[
              ["ticket","🎫 チケット"],
              ["order","🛒 注文する"],
              ...(found.isVIP ? [["present","🎁 プレゼント"]] : []),
            ].map(([k,l])=>(
              <button key={k} className={`tab-btn ${cvTab===k?"active":""}`} onClick={()=>setCvTab(k)}
                style={{position:"relative"}}>
                {l}
                {k==="order" && myPendingOrder && (
                  <span style={{position:"absolute",top:4,right:6,background:"#e0115f",borderRadius:"50%",width:7,height:7,display:"block"}}/>
                )}
              </button>
            ))}
          </div>

          {cvTab==="ticket" && (
            <div>
              <div className="ticket-card" style={{background:rank.bg,boxShadow:`0 0 50px ${rank.glow}55`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
                  <div>
                    <div style={{...S.rankBadge,color:rank.color,borderColor:rank.color+"88"}}>{rank.gem} {rank.name}会員</div>
                    <div style={{fontSize:"1.05rem",fontWeight:700,color:"#f0ece0"}}>{found.name}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{color:"#aaa",fontSize:"0.72rem",marginBottom:2}}>残高</div>
                    <div style={{color:rank.color,fontSize:"1.7rem",fontWeight:800,letterSpacing:"-0.02em"}}>¥{found.balance.toLocaleString()}</div>
                  </div>
                </div>
                <div style={{...S.benefitBox,borderColor:rank.color+"55",background:rank.color+"11"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{color:rank.color,fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>
                        {isAlways?"✨ 自動特典":"🎁 今月の特典"}
                      </div>
                      <div style={{color:"#f0ece0",fontWeight:700,fontSize:"0.95rem"}}>{rank.benefit.icon} {rank.benefit.desc}</div>
                    </div>
                    {isAlways?<div style={S.benefitTagAlways}>毎回適用</div>
                      :used?<div style={S.benefitTagUsed}>使用済み</div>
                      :<div style={{...S.benefitTagAvail,borderColor:rank.color,color:rank.color}}>未使用</div>}
                  </div>
                  {!isAlways&&<div style={{color:"#555",fontSize:"0.72rem",marginTop:8}}>
                    {used?"来月またご利用いただけます":"スタッフにお申し付けください"}
                  </div>}
                </div>
                <div style={S.divider}/>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{color:"#aaa",fontSize:"0.8rem"}}>今年の購入回数</span>
                  <span style={{color:rank.color,fontWeight:700}}>{cyp}回</span>
                </div>
                <div style={{background:"#ffffff0a",borderRadius:8,padding:"7px 10px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:next?4:0}}>
                    <span style={{color:"#777",fontSize:"0.72rem"}}>来年のランク予測</span>
                    <span style={{color:nextYearRank.color,fontWeight:700,fontSize:"0.8rem"}}>{nextYearRank.gem} {nextYearRank.name}</span>
                  </div>
                  {next&&<><div style={{marginBottom:4}}><span style={{color:"#555",fontSize:"0.7rem"}}>あと{next.min-cyp}回で {next.gem}{next.name}</span></div>
                  <div style={S.bar}><div className="bar-fill" style={{width:`${pct}%`,background:nextYearRank.color}}/></div></>}
                  {!next&&<div style={{color:nextYearRank.color,fontSize:"0.72rem",marginTop:2}}>✨ 最高ランク達成！</div>}
                </div>
                <div style={{textAlign:"right",fontSize:"0.68rem",color:"#ffffff22",marginTop:10,letterSpacing:"0.15em"}}>虹カフェ</div>
              </div>
              <div style={{marginTop:14,background:"#0f0f0f",borderRadius:14,padding:"14px 16px"}}>
                <div style={{color:"#444",fontSize:"0.72rem",letterSpacing:"0.08em",marginBottom:10}}>ランク一覧</div>
                {RANKS.map(r=>{
                  const unlocked=found.rankBasis>=r.min, isCur=r.name===rank.name;
                  return (
                    <div key={r.name} style={{...S.rankRow,opacity:unlocked?1:0.35,background:isCur?rank.color+"18":"transparent",borderRadius:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                        <span style={{fontSize:"0.9rem"}}>{r.gem}</span>
                        <div>
                          <span style={{color:r.color,fontWeight:700,fontSize:"0.85rem"}}>{r.name}</span>
                          <span style={{color:"#555",fontSize:"0.7rem",marginLeft:6}}>{r.min}回〜</span>
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <span style={{color:"#aaa",fontSize:"0.78rem"}}>{r.benefit.icon} {r.benefit.desc}</span>
                        {r.benefit.type==="always_discount"&&<span style={{color:r.color,fontSize:"0.68rem",marginLeft:4,fontWeight:700}}>毎回</span>}
                      </div>
                      {isCur&&<div style={{...S.curDot,background:rank.color}}/>}
                    </div>
                  );
                })}
              </div>
              <button className="btn-ghost" style={{marginTop:14}} onClick={()=>{setFound(null);setInput("");}}>別の番号を確認</button>
              <RankingBoard customers={customers} myId={found.id}/>
            </div>
          )}

          {cvTab==="present" && found.isVIP && (
            <VipPresentTab
              found={found}
              vipGiftDrink={vipGiftDrink}
              orders={orders}
              saveOrders={saveOrders}
              saveC={saveC}
              customers={customers}
            />
          )}
            <div>
              {myPendingOrder ? (
                <div style={{background:"#0f1a0f",border:"1px solid #2a5a2a",borderRadius:14,padding:16}}>
                  <div style={{color:"#5ecf7f",fontWeight:700,fontSize:"0.95rem",marginBottom:10}}>✅ 注文受付済み — スタッフが準備中です</div>
                  {myPendingOrder.items.map((item,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
                      <span style={{color:"#ccc"}}>{item.emoji} {item.name} × {item.qty}</span>
                      <span style={{color:"#d4a853"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                    </div>
                  ))}
                  {(myPendingOrder.benefitItems||[]).map((item,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
                      <span style={{color:"#aaa"}}>{item.emoji} {item.name}</span>
                      <span style={{color:"#5ecf7f",fontSize:"0.8rem"}}>🎁 無料</span>
                    </div>
                  ))}
                  <div style={{borderTop:"1px solid #2a5a2a",paddingTop:8,marginTop:6,display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:"#888",fontSize:"0.85rem"}}>合計</span>
                    <span style={{color:"#5ecf7f",fontWeight:800}}>¥{myPendingOrder.total.toLocaleString()}</span>
                  </div>
                  <div style={{color:"#555",fontSize:"0.72rem",marginTop:6}}>{myPendingOrder.createdAt} に注文</div>
                  <button className="btn-danger" style={{marginTop:12,padding:"9px"}} onClick={cancelOrder}>注文をキャンセル</button>
                </div>
              ) : ordered ? (
                <div style={{textAlign:"center",padding:"32px 16px"}}>
                  <div style={{fontSize:"3rem",marginBottom:12}}>✅</div>
                  <div style={{color:"#5ecf7f",fontWeight:700,fontSize:"1.05rem",marginBottom:6}}>注文を受け付けました！</div>
                  <div style={{color:"#666",fontSize:"0.85rem"}}>スタッフが準備します。しばらくお待ちください。</div>
                  <button className="btn-ghost" style={{marginTop:20}} onClick={()=>setOrdered(false)}>続けて注文する</button>
                </div>
              ) : (
                <div>
                  {/* ── スペシャル無料バナー ── */}
                  {isSpecial && (
                    <div style={{background:"linear-gradient(135deg,#1a0a1a,#2a1030)",border:"1px solid #e040fb55",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:"1.1rem"}}>💜</span>
                      <div>
                        <div style={{color:"#e040fb",fontWeight:800,fontSize:"0.9rem"}}>スペシャル — 全品無料</div>
                        <div style={{color:"#888",fontSize:"0.72rem"}}>全ての注文が¥0になります</div>
                      </div>
                    </div>
                  )}

                  {/* ── スタッフ割引バナー ── */}
                  {isStaffAccount && (
                    <div style={{background:"#0a1a10",border:"1px solid #5ecf7f44",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:"1rem"}}>🟢</span>
                      <div>
                        <div style={{color:"#5ecf7f",fontWeight:700,fontSize:"0.88rem"}}>スタッフ割引 {discountRate}%OFF</div>
                        <div style={{color:"#555",fontSize:"0.72rem"}}>スタッフ紐付きアカウントは全商品10%オフ</div>
                      </div>
                    </div>
                  )}

                  {/* ── 月次特典セクション（未使用/残あり時のみ表示） ── */}
                  {showBenefit && (
                    <BenefitOrderSection
                      rank={rank}
                      menu={menu}
                      benefitUsed={benefitUsed}
                      benefitItems={benefitItems}
                      setBenefitItems={setBenefitItems}
                      setBenefitUsed={setBenefitUsed}
                      designatedDrink={designatedDrink}
                      availableTopping={availableTopping}
                    />
                  )}

                  {/* ── メニュー（カテゴリタブ） ── */}
                  <OrderMenuTabs
                    menu={menu}
                    cart={cart}
                    addToCart={addToCart}
                    removeOne={removeOne}
                  />

                  {/* ── カート ── */}
                  {(cart.length>0 || benefitItems.length>0) &&(
                    <div style={{background:"#0e0e0e",border:"1px solid #1e1e1e",borderRadius:14,padding:"12px 14px",marginTop:4}}>
                      {cart.map(item=>(
                        <div key={item.id} style={S.cartRow}>
                          <span style={{color:"#ccc",fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <button className="qty-btn" onClick={()=>removeOne(item.id)}>－</button>
                            <span style={{color:"#e8e0d0",minWidth:18,textAlign:"center",fontWeight:700}}>{item.qty}</span>
                            <button className="qty-btn" onClick={()=>addToCart(item)}>＋</button>
                            <span style={{color:"#d4a853",fontWeight:700,fontSize:"0.85rem",minWidth:56,textAlign:"right"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                      {benefitItems.map((item,i)=>(
                        <div key={i} style={{...S.cartRow,opacity:0.85}}>
                          <span style={{color:rank.color,fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
                          <span style={{color:rank.color,fontWeight:700,fontSize:"0.85rem"}}>🎁 無料</span>
                        </div>
                      ))}
                      <div style={{paddingTop:8,borderTop:"1px solid #222",marginTop:6}}>
                        {isSpecial&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"#e040fb",fontSize:"0.8rem"}}>💜 スペシャル割引</span>
                          <span style={{color:"#e040fb",fontSize:"0.8rem"}}>全品無料</span>
                        </div>}
                        {!isSpecial&&staffDiscount>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"#5ecf7f",fontSize:"0.8rem"}}>🟢 スタッフ割引 {discountRate}%</span>
                          <span style={{color:"#5ecf7f",fontSize:"0.8rem"}}>－¥{staffDiscount.toLocaleString()}</span>
                        </div>}
                        {!isSpecial&&discount>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:rank.color,fontSize:"0.8rem"}}>{rank.benefit.icon} ランク割引</span>
                          <span style={{color:rank.color,fontSize:"0.8rem"}}>－¥{discount.toLocaleString()}</span>
                        </div>}
                        {benefitItems.length>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:rank.color,fontSize:"0.8rem"}}>🎁 月次特典</span>
                          <span style={{color:rank.color,fontSize:"0.8rem"}}>無料</span>
                        </div>}
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                          <span style={{color:"#aaa",fontSize:"0.85rem"}}>合計</span>
                          <span style={{color:"#e8e0d0",fontWeight:800,fontSize:"1.3rem"}}>¥{total.toLocaleString()}</span>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <button className="btn-clear" onClick={()=>{setCart([]); setBenefitItems([]); setBenefitUsed(false);}}>クリア</button>
                          <button className="btn-pay"
                            disabled={cart.length===0 && benefitItems.length===0}
                            style={{opacity:(cart.length>0||benefitItems.length>0)&&total<=found.balance?1:0.35}}
                            onClick={placeOrder}>
                            {total<=found.balance?"注文する":"残高不足"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── VIP PRESENT TAB ──────────────────────
function VipPresentTab({ found, vipGiftDrink, orders, saveOrders, saveC, customers }) {
  const vipGiftUsed  = found.vipGiftUsedMonth === currentMonth();
  const pendingGift  = orders.find(o=>o.customerId===found.id && o.status==="pending" && o.isVipGift);

  const claimGift = () => {
    if (!vipGiftDrink || vipGiftUsed || pendingGift) return;
    const order = {
      orderId:      `ord_${Date.now()}`,
      customerId:   found.id,
      customerName: found.name,
      rankName:     "VIP", rankColor:"#ffd700", rankGem:"⭐",
      items:        [],
      benefitItems: [{ ...vipGiftDrink, price:0, qty:1 }],
      subtotal: 0, discount: 0, total: 0,
      isVipGift: true,
      staffLinked: null,
      status:   "pending",
      createdAt: new Date().toLocaleString("ja-JP"),
    };
    saveOrders([order, ...orders.filter(o=>!(o.customerId===found.id && o.status==="pending" && o.isVipGift))]);
    const updated = { ...found, vipGiftUsedMonth: currentMonth() };
    saveC(customers.map(c=>c.id===found.id ? updated : c));
  };

  const cancelGift = () => {
    if (!pendingGift) return;
    saveOrders(orders.filter(o=>o.orderId!==pendingGift.orderId));
    const updated = { ...found, vipGiftUsedMonth: null };
    saveC(customers.map(c=>c.id===found.id ? updated : c));
  };

  return (
    <div>
      {/* VIPバッジ */}
      <div style={{textAlign:"center",marginBottom:20,paddingTop:8}}>
        <div style={{fontSize:"2.5rem",marginBottom:8}}>⭐</div>
        <div style={{color:"#ffd700",fontWeight:800,fontSize:"1.1rem",letterSpacing:"0.08em"}}>VIP会員</div>
        <div style={{color:"#888",fontSize:"0.8rem",marginTop:4}}>{found.name} さん専用</div>
      </div>

      {/* 今月のプレゼント */}
      <div style={{background:"linear-gradient(135deg,#1a1400,#2a2000)",border:"1px solid #ffd70055",borderRadius:16,padding:"20px",marginBottom:16}}>
        <div style={{color:"#ffd700",fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>🎁 今月のプレゼント</div>

        {!vipGiftDrink ? (
          <div style={{textAlign:"center",color:"#555",fontSize:"0.88rem",padding:"16px 0"}}>
            今月のプレゼントは設定中です<br/>
            <span style={{fontSize:"0.75rem",color:"#444"}}>しばらくお待ちください</span>
          </div>
        ) : (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
              <span style={{fontSize:"2.5rem"}}>{vipGiftDrink.emoji}</span>
              <div>
                <div style={{color:"#e8e0d0",fontWeight:700,fontSize:"1.05rem"}}>{vipGiftDrink.name}</div>
                <div style={{color:"#ffd700",fontSize:"0.82rem",marginTop:2}}>無料プレゼント ✨</div>
              </div>
            </div>

            {pendingGift ? (
              <div>
                <div style={{background:"#0f2a0f",border:"1px solid #5ecf7f44",borderRadius:10,padding:"10px 14px",marginBottom:10,color:"#5ecf7f",fontWeight:700,fontSize:"0.88rem"}}>
                  ✅ スタッフが準備中です
                </div>
                <button className="btn-danger" style={{padding:"9px",fontSize:"0.82rem"}} onClick={cancelGift}>
                  キャンセル
                </button>
              </div>
            ) : vipGiftUsed ? (
              <div style={{background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
                <div style={{color:"#555",fontSize:"0.85rem"}}>今月は受け取り済みです</div>
                <div style={{color:"#444",fontSize:"0.75rem",marginTop:4}}>来月また受け取れます</div>
              </div>
            ) : (
              <button
                style={{width:"100%",background:"linear-gradient(135deg,#b8860b,#ffd700)",color:"#0a0a0a",
                  border:"none",borderRadius:12,padding:"15px",fontSize:"1rem",fontWeight:800,
                  cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.04em",
                  boxShadow:"0 4px 20px #ffd70044",transition:"transform 0.1s"}}
                onClick={claimGift}>
                🎁 プレゼントを受け取る
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{color:"#444",fontSize:"0.75rem",textAlign:"center"}}>
        プレゼントは月に1回受け取れます
      </div>
    </div>
  );
}

// ── BENEFIT ORDER SECTION ────────────────
function BenefitOrderSection({ rank, menu, benefitUsed, benefitItems, setBenefitItems, setBenefitUsed, designatedDrink, availableTopping }) {
  const [open, setOpen] = useState(false);

  const benefitName = rank.benefit.desc;
  const benefitIcon = rank.benefit.icon;

  const toppingMax     = getToppingMax(rank);
  const isToppingBenefit = toppingMax > 0;
  const selectable     = availableTopping; // 今回選べる残り回数
  const isCoffeeBenefit  = rank.name==="プラチナ";
  const isSpecificDrink  = rank.name==="チタン";
  const isAnyDrink       = rank.name==="サファイア";

  const toppingItems = menu.filter(m=>m.category==="トッピング");
  const coffeeItems  = menu.filter(m=>m.category==="コーヒー" && (m.name==="アイスコーヒー"||m.name==="ホットコーヒー"));
  const anyDrinkItems= menu.filter(m=>m.category==="コーヒー"||m.category==="ドリンク");

  const toggleTopping = (item) => {
    const already = benefitItems.find(b=>b.id===item.id);
    if (already) {
      const next = benefitItems.filter(b=>b.id!==item.id);
      setBenefitItems(next);
      if (next.length===0) setBenefitUsed(false);
    } else if (benefitItems.length < selectable) {
      setBenefitItems([...benefitItems, {...item, price:0, qty:1}]);
      setBenefitUsed(true);
    }
  };

  const selectDrink = (item) => {
    setBenefitItems([{...item, price:0, qty:1}]);
    setBenefitUsed(true);
    setOpen(false);
  };

  const clearBenefit = () => { setBenefitItems([]); setBenefitUsed(false); setOpen(false); };

  // ヘッダーのサブテキスト（残り回数表示）
  const subText = isToppingBenefit && selectable < toppingMax
    ? `（今月残り${selectable}回）`
    : isToppingBenefit
      ? `（${toppingMax}回分）`
      : "";

  return (
    <div style={{background:rank.color+"0e",border:`1px solid ${rank.color}44`,borderRadius:12,padding:"12px 14px",marginBottom:14}}>
      {/* ヘッダー */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(open||benefitUsed)?10:0}}>
        <div>
          <div style={{color:rank.color,fontSize:"0.7rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:2}}>🎁 今月の特典</div>
          <div style={{color:"#e8e0d0",fontWeight:700,fontSize:"0.88rem"}}>{benefitIcon} {benefitName}
            {subText && <span style={{color:rank.color,fontSize:"0.75rem",marginLeft:6,fontWeight:400}}>{subText}</span>}
          </div>
        </div>
        {benefitUsed ? (
          <button style={{background:"transparent",border:`1px solid ${rank.color}55`,borderRadius:20,
            padding:"4px 10px",color:rank.color,fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}}
            onClick={clearBenefit}>取り消す</button>
        ) : (
          <button style={{background:rank.color+"22",border:`1px solid ${rank.color}`,borderRadius:20,
            padding:"4px 12px",color:rank.color,fontWeight:700,fontSize:"0.8rem",cursor:"pointer",fontFamily:"inherit"}}
            onClick={()=>setOpen(p=>!p)}>
            {open?"閉じる":"使用する →"}
          </button>
        )}
      </div>

      {/* 選択済み表示 */}
      {benefitUsed && benefitItems.length>0 && (
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:open?8:0}}>
          {benefitItems.map((b,i)=>(
            <span key={i} style={{background:rank.color+"22",border:`1px solid ${rank.color}55`,
              borderRadius:20,padding:"3px 10px",color:rank.color,fontSize:"0.78rem",fontWeight:700}}>
              {b.emoji} {b.name} 🎁
            </span>
          ))}
          {isToppingBenefit && benefitItems.length < selectable && (
            <span style={{color:"#555",fontSize:"0.75rem",alignSelf:"center"}}>
              あと{selectable-benefitItems.length}つ選べます
            </span>
          )}
        </div>
      )}

      {open && isToppingBenefit && (
        <div>
          <div style={{color:"#777",fontSize:"0.75rem",marginBottom:8}}>
            トッピングを選択（あと{selectable - benefitItems.length}つ選べます）
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {toppingItems.map(item=>{
              const sel = !!benefitItems.find(b=>b.id===item.id);
              const disabled = !sel && benefitItems.length >= selectable;
              return (
                <button key={item.id}
                  disabled={disabled}
                  style={{background:sel?rank.color+"33":"#1a1a1a",
                    border:`1px solid ${sel?rank.color:"#2a2a2a"}`,
                    borderRadius:10,padding:"12px 18px",cursor:disabled?"default":"pointer",
                    fontFamily:"inherit",color:sel?rank.color:disabled?"#444":"#aaa",
                    fontWeight:sel?700:400,fontSize:"0.9rem",transition:"all 0.15s",opacity:disabled?0.4:1}}
                  onClick={()=>!disabled&&toggleTopping(item)}>
                  {item.emoji} {item.name}{sel&&" ✓"}
                </button>
              );
            })}
          </div>
          <div style={{color:"#555",fontSize:"0.72rem",marginTop:6}}>
            {benefitItems.length}/{selectable} 選択中
            {selectable < toppingMax && ` （今月の残り使用回数: ${selectable}回）`}
          </div>
        </div>
      )}

      {/* コーヒー選択（プラチナ） */}
      {open && isCoffeeBenefit && (
        <div>
          <div style={{color:"#777",fontSize:"0.75rem",marginBottom:8}}>アイスコーヒー / ホットコーヒーから1杯選択</div>
          <div style={{display:"flex",gap:8}}>
            {coffeeItems.length===0
              ? <div style={{color:"#555",fontSize:"0.82rem"}}>メニューにアイスコーヒー・ホットコーヒーがありません</div>
              : coffeeItems.map(item=>(
                <button key={item.id} className="menu-item"
                  style={{flex:1,border:`1px solid ${rank.color}44`,background:rank.color+"0a"}}
                  onClick={()=>selectDrink(item)}>
                  <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                  <span style={{fontSize:"0.78rem",fontWeight:600,color:"#ddd",lineHeight:1.2,marginTop:2}}>{item.name}</span>
                  <span style={{color:rank.color,fontWeight:700,fontSize:"0.75rem"}}>🎁 無料</span>
                </button>
              ))
            }
          </div>
        </div>
      )}

      {/* 指定ドリンク選択（チタン） */}
      {open && isSpecificDrink && (
        <div>
          <div style={{color:"#777",fontSize:"0.75rem",marginBottom:8}}>今月の指定ドリンク（1杯無料）</div>
          {!designatedDrink
            ? <div style={{color:"#555",fontSize:"0.85rem",background:"#111",borderRadius:8,padding:"10px 12px"}}>
                今月の指定ドリンクはスタッフが設定中です
              </div>
            : (
              <button className="menu-item" style={{width:"100%",border:`1px solid ${rank.color}55`,background:rank.color+"0a"}}
                onClick={()=>selectDrink(designatedDrink)}>
                <span style={{fontSize:"1.6rem"}}>{designatedDrink.emoji}</span>
                <span style={{fontSize:"0.85rem",fontWeight:700,color:"#ddd",marginTop:2}}>{designatedDrink.name}</span>
                <span style={{color:rank.color,fontWeight:700,fontSize:"0.78rem"}}>🎁 今月の指定ドリンク</span>
              </button>
            )
          }
        </div>
      )}

      {/* 好きなドリンク選択（サファイア） */}
      {open && isAnyDrink && (
        <div>
          <div style={{color:"#777",fontSize:"0.75rem",marginBottom:8}}>好きなドリンクを1杯選択（全て対象）</div>
          <div style={S.menuGrid}>
            {anyDrinkItems.map(item=>(
              <button key={item.id} className="menu-item"
                style={{border:`1px solid ${rank.color}44`,background:rank.color+"0a"}}
                onClick={()=>selectDrink(item)}>
                <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                <span style={{fontSize:"0.78rem",fontWeight:600,color:"#ddd",lineHeight:1.2,marginTop:2,textAlign:"center"}}>{item.name}</span>
                <span style={{color:rank.color,fontWeight:700,fontSize:"0.75rem"}}>🎁 無料</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ORDER MENU TABS ───────────────────────
function OrderMenuTabs({ menu, cart, addToCart, removeOne }) {
  const categories = [...new Set(menu.map(m=>m.category))];
  const [activeTab, setActiveTab] = useState(categories[0] || "");

  return (
    <div>
      {/* カテゴリタブ */}
      <div style={{display:"flex",gap:0,overflowX:"auto",background:"#0d0d0d",borderRadius:"10px 10px 0 0",marginBottom:0}}>
        {categories.map(cat=>(
          <button key={cat}
            style={{flexShrink:0,background:"transparent",border:"none",
              borderBottom:`2px solid ${activeTab===cat?"#d4a853":"transparent"}`,
              color:activeTab===cat?"#d4a853":"#555",padding:"9px 14px",fontSize:"0.8rem",
              fontWeight:activeTab===cat?700:400,cursor:"pointer",fontFamily:"inherit",
              transition:"all 0.15s",whiteSpace:"nowrap"}}
            onClick={()=>setActiveTab(cat)}>
            {cat}
          </button>
        ))}
      </div>
      {/* 選択カテゴリのメニュー */}
      <div style={{background:"#0d0d0d",borderRadius:"0 0 10px 10px",padding:"10px 8px",marginBottom:8}}>
        <div style={S.menuGrid}>
          {menu.filter(m=>m.category===activeTab).map(item=>{
            const inCart=cart.find(c=>c.id===item.id);
            return (
              <button key={item.id} className={`menu-item ${inCart?"menu-item-active":""}`} onClick={()=>addToCart(item)}>
                <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                <span style={{fontSize:"0.78rem",fontWeight:600,color:"#ddd",lineHeight:1.2,marginTop:2,textAlign:"center"}}>{item.name}</span>
                <span style={{color:"#d4a853",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                {inCart&&<div style={S.cartBadge}>{inCart.qty}</div>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── RANKING BOARD ────────────────────────
function RankingBoard({ customers, myId }) {
  // ランク順（rankBasis降順）→ 今年の購入回数降順 でソートしてTOP5
  const sorted = [...customers].sort((a, b) => {
    const ra = getEffectiveRank(a);
    const rb = getEffectiveRank(b);
    const ri = RANKS.findIndex(r=>r.name===ra.name);
    const rj = RANKS.findIndex(r=>r.name===rb.name);
    if (rj !== ri) return rj - ri;
    return (b.currentYearPurchases??0) - (a.currentYearPurchases??0);
  });

  const medals = ["🥇","🥈","🥉"];

  return (
    <div style={{marginTop:20,marginBottom:8}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <div style={{flex:1,height:1,background:"linear-gradient(90deg,transparent,#333)"}}/>
        <span style={{color:"#666",fontSize:"0.72rem",letterSpacing:"0.1em",whiteSpace:"nowrap"}}>🏆 メンバーズランキング</span>
        <div style={{flex:1,height:1,background:"linear-gradient(90deg,#333,transparent)"}}/>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {sorted.map((c, i) => {
          const r    = getEffectiveRank(c);
          const isMe = c.id === myId;
          return (
            <div key={c.id} style={{
              display:"flex", alignItems:"center", gap:10,
              background: isMe ? r.color+"18" : "#0f0f0f",
              border: `1px solid ${isMe ? r.color+"55" : "#1e1e1e"}`,
              borderRadius:10, padding:"9px 12px",
              boxShadow: isMe ? `0 0 12px ${r.color}22` : "none",
            }}>
              <span style={{fontSize:"1.1rem",flexShrink:0,minWidth:24,textAlign:"center"}}>
                {i < 3 ? medals[i] : <span style={{color:"#444",fontSize:"0.85rem",fontWeight:700}}>{i+1}</span>}
              </span>
              <span style={{fontSize:"0.95rem",flexShrink:0}}>{r.gem}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{
                    color: isMe ? r.color : "#e8e0d0",
                    fontWeight: isMe ? 800 : 600,
                    fontSize:"0.9rem",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                  }}>
                    {c.name}
                  </span>
                  {isMe && <span style={{color:r.color,fontSize:"0.65rem",fontWeight:700,background:r.color+"22",border:`1px solid ${r.color}44`,borderRadius:20,padding:"1px 6px",flexShrink:0}}>あなた</span>}
                </div>
                <span style={{color:"#555",fontSize:"0.72rem"}}>{r.name}</span>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{color: isMe ? r.color : "#888",fontWeight:700,fontSize:"0.88rem"}}>{c.currentYearPurchases??0}回</div>
                <div style={{color:"#444",fontSize:"0.68rem"}}>今年</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  STAFF LOGIN
// ══════════════════════════════════════════
function StaffLogin({ setScreen, setStaffRole, setStaffName, staffAccounts, managerAccounts }) {
  const [selected, setSelected] = useState(null);
  const [pw, setPw]   = useState("");
  const [err, setErr] = useState("");

  const login = () => {
    if (!selected) return;
    const isMgr = selected._role === "manager";
    if (pw === selected.password) {
      setStaffRole(isMgr ? "manager" : "staff");
      setStaffName(selected.name);
      setScreen("pos");
    } else setErr("パスワードが違います");
  };

  const allAccounts = [
    ...(managerAccounts||[]).map(a=>({...a, _role:"manager"})),
    ...(staffAccounts||[]).map(a=>({...a, _role:"staff"})),
  ];

  return (
    <div style={S.page}>
      <button className="back-btn" onClick={()=>{ if(selected){setSelected(null);setPw("");setErr("");}else setScreen("home"); }}>
        {selected ? "← 戻る" : "← ホームへ"}
      </button>
      <h2 style={S.title}>スタッフログイン</h2>

      {!selected ? (
        <div>
          <p style={S.hint}>アカウントを選択してください</p>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
            {allAccounts.map(acc=>(
              <button key={acc.id} className={`staff-select-btn${acc._role==="manager"?" manager":""}`}
                onClick={()=>{setSelected(acc);setPw("");setErr("");}}>
                <span style={{fontSize:"1.1rem"}}>{acc._role==="manager"?"👑":"👤"}</span>
                <span style={{fontWeight:700,color:acc._role==="manager"?"#d4a853":"#e8e0d0"}}>{acc.name}</span>
                <span style={{color:"#555",fontSize:"0.8rem",marginLeft:"auto"}}>→</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:10,padding:"12px 14px",marginBottom:4}}>
            <div style={{color:"#666",fontSize:"0.72rem",marginBottom:2}}>ログイン中のアカウント</div>
            <div style={{fontWeight:700,color:selected._role==="manager"?"#d4a853":"#e8e0d0",display:"flex",alignItems:"center",gap:6}}>
              <span>{selected._role==="manager"?"👑":"👤"}</span>
              <span>{selected.name}</span>
            </div>
          </div>
          <input style={S.input} type="password" placeholder="パスワード"
            value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&login()} autoFocus/>
          {err && <p style={S.err}>{err}</p>}
          <button className="btn-gold" onClick={login}>ログイン</button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  POS
// ══════════════════════════════════════════
function POS({ customers, menu, orders, staffRole, staffName, staffAccounts, saveStaffAccounts, managerAccounts, saveManagerAccounts, saveC, saveMenu, saveOrders, designatedDrink, saveDesignatedDrink, vipGiftDrink, saveVipGiftDrink, setScreen }) {
  const [customer,  setCustomer]  = useState(null);
  const [cart,      setCart]      = useState([]);
  const [query,     setQuery]     = useState("");
  const [flash,     setFlash]     = useState(null);
  const [showCode,       setShowCode]       = useState(false);
  const [showHistory,    setShowHistory]    = useState(false);
  const [showYearHistory,setShowYearHistory]= useState(false);
  const [posTab,         setPosTab]         = useState("order"); // "order" | "menu"
  const [pwPrompt,       setPwPrompt]       = useState(null);
  const [pwInput,   setPwInput]   = useState("");
  const [pwErr,     setPwErr]     = useState("");
  const [pwTarget,  setPwTarget]  = useState(null);

  const isManager = staffRole === "manager";
  const rank      = customer ? getEffectiveRank(customer) : null;
  const used      = customer ? isBenefitUsed(customer) : false;
  const isAlways  = rank?.benefit.type === "always_discount";
  const subtotal  = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const discount  = rank ? calcDiscount(rank, subtotal) : 0;
  const total     = subtotal - discount;

  const update = (updated) => {
    saveC(customers.map(c=>c.id===updated.id?updated:c));
    setCustomer(updated);
  };

  const addToCart = (item) => {
    setCart(prev=>{
      const ex=prev.find(c=>c.id===item.id);
      return ex ? prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c) : [...prev,{...item,qty:1}];
    });
  };
  const removeOne = (id) => {
    setCart(prev=>{
      const ex=prev.find(c=>c.id===id);
      if(!ex) return prev;
      return ex.qty===1 ? prev.filter(c=>c.id!==id) : prev.map(c=>c.id===id?{...c,qty:c.qty-1}:c);
    });
  };

  const trigFlash = (type, amount) => {
    setFlash({type,amount});
    setTimeout(()=>setFlash(null), 1000);
  };

  const doPayment = () => {
    if (!customer||total===0) return;
    if (total>customer.balance) { alert("残高が不足しています"); return; }
    const updated = {
      ...customer,
      balance: customer.balance - total,
      history: [{
        type:"use", amount:total, subtotal, discount,
        items:cart.map(c=>`${c.name}×${c.qty}`).join(", "),
        performer: staffName,
        date:new Date().toLocaleString("ja-JP")
      }, ...(customer.history||[])].slice(0,60),
    };
    update(updated);
    trigFlash("sub", total);
    setCart([]);
  };

  const doCharge = () => requireManager(()=>{
    const updated = {
      ...customer,
      balance:              customer.balance + 2200,
      currentYearPurchases: (customer.currentYearPurchases ?? 0) + 1,
      history:   [{type:"charge",amount:2200,performer:staffName,date:new Date().toLocaleString("ja-JP")}, ...(customer.history||[])].slice(0,60),
    };
    update(updated);
    trigFlash("add", 2200);
  });

  const useBenefit = () => {
    if (!customer || isAlways || used) return;
    const updated = {
      ...customer,
      benefitUsedMonth: currentMonth(),
      history: [{
        type:"benefit", desc:rank.benefit.desc,
        performer: staffName,
        date:new Date().toLocaleString("ja-JP")
      }, ...(customer.history||[])].slice(0,60),
    };
    update(updated);
  };

  const requireManager = (fn) => {
    if (isManager) { fn(); return; }
    setPwTarget(()=>fn); setPwPrompt("auth"); setPwInput(""); setPwErr("");
  };
  const confirmManager = () => {
    if ((managerAccounts||[]).some(a=>a.password===pwInput)) { setPwPrompt(null); pwTarget&&pwTarget(); }
    else setPwErr("マネージャーパスワードが違います");
  };

  const categories = [...new Set(menu.map(m=>m.category))];

  return (
    <div style={S.root}>
      {/* TOP BAR */}
      <div style={S.topbar}>
        {customer ? (
          <button className="back-btn" style={{margin:0,fontSize:"0.85rem",color:"#d4a853",fontWeight:700}}
            onClick={()=>{ setCustomer(null); setCart([]); }}>
            ← 客を変える
          </button>
        ) : (
          <button className="back-btn" style={{margin:0,fontSize:"0.8rem"}} onClick={()=>setScreen("home")}>← 退出</button>
        )}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {customer && (
            <button className="back-btn" style={{margin:0,fontSize:"0.75rem",color:"#555"}} onClick={()=>setScreen("home")}>退出</button>
          )}
          <span style={{fontSize:"0.75rem",color:isManager?"#d4a853":"#7ab8e8",background:"#181818",padding:"4px 12px",borderRadius:20}}>
            {isManager?"👑":"👤"} {staffName}
          </span>
        </div>
      </div>

      {/* TAB NAV（客未選択時のみ） */}
      {!customer && (
        <div style={{display:"flex",background:"#0d0d0d",borderBottom:"1px solid #1a1a1a",overflowX:"auto"}}>
          {[["order","👥 会員"],["menu","🍽 メニュー"],["orders","📋 注文"],["history","🗂 履歴"],
            ...(isManager?[["staffmgmt","🔐 スタッフ"]]:[])
          ].map(([k,l])=>(
            <button key={k} className={`pos-tab ${posTab===k?"pos-tab-active":""}`}
              onClick={()=>setPosTab(k)} style={{position:"relative",flexShrink:0}}>
              {l}
              {k==="orders" && orders.filter(o=>o.status==="pending").length>0 && (
                <span style={{position:"absolute",top:6,right:4,background:"#e0115f",color:"#fff",
                  borderRadius:10,padding:"1px 5px",fontSize:"0.6rem",fontWeight:700,lineHeight:1.4}}>
                  {orders.filter(o=>o.status==="pending").length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ── 客未選択: 検索 ── */}
      {!customer && posTab==="order" && (
        <div style={{...S.page,paddingTop:14}}>
          <h2 style={S.title}>お客様を検索</h2>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <input style={{...S.input,flex:1,marginBottom:0}} placeholder={isManager ? "名前 or 暗証番号で検索" : "名前で検索"}
              value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}/>
            <button className="btn-gold" style={{width:"auto",padding:"0 16px",fontSize:"0.9rem",flexShrink:0}} onClick={doSearch}>検索</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {customers.filter(c=>{
                if (!query) return true;
                if (isManager) return c.name.includes(query)||c.pin.includes(query);
                return c.name.includes(query);
              })
              .map(c=>{
                const r=getEffectiveRank(c);
                const u=isBenefitUsed(c);
                const isAl=r.benefit.type==="always_discount";
                return (
                  <div key={c.id} className="c-row" onClick={()=>setCustomer(c)}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:r.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:"0.95rem"}}>{c.name} {c.isVIP&&<span style={{color:"#ffd700",fontSize:"0.8rem"}}>⭐</span>}{c.isSpecial&&<span style={{color:"#e040fb",fontSize:"0.8rem"}}>💜</span>}</div>
                      {isManager
                        ? <div style={{color:"#555",fontSize:"0.75rem"}}>暗証: {c.pin} · {r.gem}{r.name}</div>
                        : <div style={{color:"#555",fontSize:"0.75rem"}}>{r.gem}{r.name}</div>
                      }
                    </div>
                    <div style={{textAlign:"right",display:"flex",flexDirection:"column",gap:2,alignItems:"flex-end"}}>
                      <div style={{color:r.color,fontWeight:700}}>¥{c.balance.toLocaleString()}</div>
                      {isAl
                        ? <div style={S.tagAuto}>{r.benefit.icon} 自動割引</div>
                        : u
                          ? <div style={S.tagUsed}>特典使用済み</div>
                          : <div style={S.tagAvail}>特典あり</div>
                      }
                    </div>
                  </div>
                );
              })}
          </div>
          {isManager && (
            <button className="btn-ghost" style={{marginTop:14}} onClick={()=>setPwPrompt("addCustomer")}>
              ＋ 新規会員登録
            </button>
          )}
        </div>
      )}

      {/* ── メニュー管理 ── */}
      {!customer && posTab==="menu" && (
        <MenuManager menu={menu} saveMenu={saveMenu} designatedDrink={designatedDrink} saveDesignatedDrink={saveDesignatedDrink}/>
      )}

      {/* ── 注文管理 ── */}
      {!customer && posTab==="orders" && (
        <OrdersPanel orders={orders} customers={customers} saveOrders={saveOrders} saveC={saveC} staffName={staffName}/>
      )}

      {/* ── スタッフ管理（マネージャーのみ） ── */}
      {!customer && posTab==="staffmgmt" && isManager && (
        <StaffMgmtPanel staffAccounts={staffAccounts} saveStaffAccounts={saveStaffAccounts} managerAccounts={managerAccounts} saveManagerAccounts={saveManagerAccounts} customers={customers} vipGiftDrink={vipGiftDrink} saveVipGiftDrink={saveVipGiftDrink} menu={menu}/>
      )}

      {/* ── 会計履歴 ── */}
      {!customer && posTab==="history" && (
        <SalesHistoryPanel customers={customers}/>
      )}
      {customer && (
        <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 44px)",overflow:"hidden"}}>

          {/* 客ストリップ */}
          <div style={{...S.customerStrip, borderColor:rank.color+"44"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{color:rank.color,fontSize:"0.82rem",fontWeight:700}}>{rank.gem} {rank.name}</span>
                  <span style={{color:"#e8e0d0",fontWeight:700,fontSize:"1rem"}}>{customer.name}</span>
                </div>
                {/* 特典ステータス */}
                <div style={{...S.benefitStripBox, borderColor:rank.color+"44"}}>
                  <span style={{color:rank.color,fontSize:"0.78rem"}}>{rank.benefit.icon} {rank.benefit.desc}</span>
                  {isAlways
                    ? <div style={S.tagAuto}>毎回自動</div>
                    : used
                      ? <div style={S.tagUsed}>使用済み</div>
                      : <button className="tag-use-btn" style={{borderColor:rank.color,color:rank.color}} onClick={useBenefit}>
                          ✓ 使用する
                        </button>
                  }
                </div>
              </div>
              <div style={{textAlign:"right",flexShrink:0,marginLeft:10}}>
                <div style={{position:"relative",display:"inline-block"}}>
                  <span style={{color:rank.color,fontWeight:800,fontSize:"1.15rem"}}>¥{customer.balance.toLocaleString()}</span>
                  {flash&&<div className={`flash flash-${flash.type}`}>{flash.type==="add"?"+":"-"}¥{flash.amount.toLocaleString()}</div>}
                </div>
                <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
                  <button className="pill-btn-hist" onClick={()=>setShowHistory(true)}>📋</button>
                  <button className="pill-btn-year" onClick={()=>setShowYearHistory(true)}>📅</button>
                  {isManager && <button className="pill-btn-code" onClick={()=>setShowCode(true)}>🔑</button>}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:6,marginTop:8}}>
              {isManager && <button className="pill-btn-gold" onClick={doCharge}>🎫 +¥2,200</button>}
              {isManager && <button className="pill-btn-dim" onClick={()=>setPwPrompt("editCustomer")}>✏️ 編集</button>}
            </div>
          </div>

          {/* メニューグリッド */}
          <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
            {categories.map(cat=>(
              <div key={cat} style={{marginBottom:14}}>
                <div style={S.catLabel}>{cat}</div>
                <div style={S.menuGrid}>
                  {menu.filter(m=>m.category===cat).map(item=>{
                    const inCart=cart.find(c=>c.id===item.id);
                    return (
                      <button key={item.id} className={`menu-item ${inCart?"menu-item-active":""}`} onClick={()=>addToCart(item)}>
                        <span style={{fontSize:"1.4rem"}}>{item.emoji}</span>
                        <span style={{fontSize:"0.78rem",fontWeight:600,color:"#ddd",lineHeight:1.2,marginTop:2,textAlign:"center"}}>{item.name}</span>
                        <span style={{color:"#d4a853",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price}</span>
                        {inCart&&<div style={S.cartBadge}>{inCart.qty}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* カート */}
          <div style={S.cartPanel}>
            {cart.length===0 ? (
              <div style={{color:"#333",textAlign:"center",fontSize:"0.85rem",padding:"8px 0"}}>商品を選んでください</div>
            ) : (
              <>
                <div style={{maxHeight:100,overflowY:"auto",marginBottom:6}}>
                  {cart.map(item=>(
                    <div key={item.id} style={S.cartRow}>
                      <span style={{color:"#ccc",fontSize:"0.85rem"}}>{item.emoji} {item.name}</span>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <button className="qty-btn" onClick={()=>removeOne(item.id)}>－</button>
                        <span style={{color:"#e8e0d0",minWidth:18,textAlign:"center",fontWeight:700}}>{item.qty}</span>
                        <button className="qty-btn" onClick={()=>addToCart(item)}>＋</button>
                        <span style={{color:"#d4a853",fontWeight:700,fontSize:"0.85rem",minWidth:56,textAlign:"right"}}>
                          ¥{(item.price*item.qty).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 割引・合計 */}
                <div style={{paddingTop:8,borderTop:"1px solid #222"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                    <span style={{color:"#666",fontSize:"0.8rem"}}>小計</span>
                    <span style={{color:"#888",fontSize:"0.8rem"}}>¥{subtotal.toLocaleString()}</span>
                  </div>
                  {discount>0 && (
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{color:rank.color,fontSize:"0.8rem"}}>{rank.benefit.icon} {rank.benefit.desc}</span>
                      <span style={{color:rank.color,fontWeight:700,fontSize:"0.8rem"}}>－¥{discount.toLocaleString()}</span>
                    </div>
                  )}
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                    <span style={{color:"#aaa",fontSize:"0.85rem"}}>合計</span>
                    <span style={{color:"#e8e0d0",fontWeight:800,fontSize:"1.3rem"}}>¥{total.toLocaleString()}</span>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn-clear" onClick={()=>setCart([])}>クリア</button>
                    <button className="btn-pay" onClick={doPayment}
                      disabled={total>customer.balance}
                      style={{opacity:total<=customer.balance?1:0.35}}>
                      {total<=customer.balance ? `¥${total.toLocaleString()} を決済` : "残高不足"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── モーダル群 ── */}
      {showCode        && customer && <CodeModal customer={customer} rank={rank} onClose={()=>setShowCode(false)}/>}
      {showHistory     && customer && <HistoryModal customer={customer} rank={rank} onClose={()=>setShowHistory(false)}/>}
      {showYearHistory && customer && <YearHistoryModal customer={customer} rank={rank} onClose={()=>setShowYearHistory(false)}/>}

      {pwPrompt==="auth" && (
        <ManagerPwModal onConfirm={confirmManager} onClose={()=>setPwPrompt(null)}
          pwInput={pwInput} setPwInput={setPwInput} err={pwErr}/>
      )}
      {pwPrompt==="editCustomer" && isManager && customer && (
        <EditCustomerModal customer={customer}
          onSave={updated=>{update(updated);setPwPrompt(null);}}
          onDelete={()=>{if(window.confirm(`${customer.name} を削除しますか？`)){saveC(customers.filter(c=>c.id!==customer.id));setCustomer(null);setPwPrompt(null);}}}
          onClose={()=>setPwPrompt(null)}/>
      )}
      {pwPrompt==="addCustomer" && (
        <AddCustomerModal
          onSave={c=>{saveC([...customers,c]);setPwPrompt(null);}}
          onClose={()=>setPwPrompt(null)}
          nextId={String(Math.max(...customers.map(c=>parseInt(c.id)||0))+1)}/>
      )}
    </div>
  );

  function doSearch() {
    const c = isManager
      ? customers.find(c=>c.pin===query.trim()||c.name.includes(query.trim()))
      : customers.find(c=>c.name.includes(query.trim()));
    if(c) setCustomer(c);
  }
}

// ── BACKUP PANEL ─────────────────────────
function BackupPanel({ customers }) {
  const [showJson,   setShowJson]   = useState(false);
  const [jsonText,   setJsonText]   = useState("");
  const [copied,     setCopied]     = useState(false);
  const [restoreMode,setRestoreMode]= useState(false);
  const [restoreText,setRestoreText]= useState("");
  const [restoreMsg, setRestoreMsg] = useState("");

  const generateBackup = () => {
    const now    = new Date();
    const backup = {
      version:    "1.0",
      exportedAt: now.toLocaleString("ja-JP"),
      customers:  customers.map(c => ({
        id:                   c.id,
        name:                 c.name,
        pin:                  c.pin,
        balance:              c.balance,
        currentYearPurchases: c.currentYearPurchases ?? 0,
        rankBasis:            c.rankBasis ?? 0,
        dataYear:             c.dataYear,
        isVIP:                c.isVIP || false,
        isSpecial:            c.isSpecial || false,
        joined:               c.joined,
        benefitUsedMonth:     c.benefitUsedMonth || null,
        toppingRemaining:     c.toppingRemaining ?? null,
        toppingRemainingMonth:c.toppingRemainingMonth || null,
        vipGiftUsedMonth:     c.vipGiftUsedMonth || null,
        yearlyStats:          c.yearlyStats || [],
        history:              c.history || [],
      })),
      summary: {
        totalMembers: customers.length,
        vipCount:     customers.filter(c=>c.isVIP).length,
        specialCount: customers.filter(c=>c.isSpecial).length,
        totalBalance: customers.reduce((s,c)=>s+(c.balance||0),0),
      }
    };
    return JSON.stringify(backup, null, 2);
  };

  const openBackup = () => {
    setJsonText(generateBackup());
    setShowJson(true);
    setCopied(false);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(jsonText).then(()=>{
      setCopied(true);
      setTimeout(()=>setCopied(false), 2500);
    }).catch(()=>{
      // fallback: select the textarea
      const el = document.getElementById("backup-textarea");
      if (el) { el.select(); document.execCommand("copy"); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    });
  };

  const doRestore = () => {
    setRestoreMsg("");
    try {
      const data = JSON.parse(restoreText);
      if (!data.customers || !Array.isArray(data.customers)) {
        setRestoreMsg("❌ 形式が正しくありません"); return;
      }
      if (!window.confirm(`${data.customers.length}件の会員データを復元しますか？\n現在のデータは上書きされます。`)) return;
      dbSet("cafe_v4_customers", data.customers);
        Promise.resolve().then(()=>setRestoreMsg(`✅ ${data.customers.length}件を復元しました。ページを再読み込みしてください。`))
        .catch(()=>setRestoreMsg("❌ 復元に失敗しました"));
    } catch { setRestoreMsg("❌ JSON の解析に失敗しました"); }
  };

  return (
    <div style={{background:"#0d1a20",border:"1px solid #4fa3e844",borderRadius:12,padding:"14px",marginBottom:14}}>
      <div style={{color:"#4fa3e8",fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:10}}>
        💾 バックアップ & リストア
      </div>

      {/* バックアップ */}
      <div style={{marginBottom:12}}>
        <div style={{color:"#888",fontSize:"0.78rem",marginBottom:8}}>
          全会員データをテキストとして表示→コピーして保存できます
        </div>
        <button onClick={openBackup}
          style={{width:"100%",background:"linear-gradient(135deg,#1a3a4a,#1e5070)",
            border:"1px solid #4fa3e855",borderRadius:10,padding:"13px",
            color:"#4fa3e8",fontWeight:700,fontSize:"0.92rem",cursor:"pointer",
            fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span>📋</span> バックアップデータを表示
        </button>
        <div style={{color:"#444",fontSize:"0.7rem",marginTop:6,textAlign:"center"}}>
          表示されたテキストをコピーしてメモ帳やメールに保存してください
        </div>
      </div>

      {/* リストア */}
      <div style={{borderTop:"1px solid #1e2e38",paddingTop:12}}>
        <button onClick={()=>setRestoreMode(p=>!p)}
          style={{background:"transparent",border:"1px solid #2a3a44",borderRadius:8,padding:"8px 14px",
            color:"#666",fontSize:"0.8rem",cursor:"pointer",fontFamily:"inherit",width:"100%"}}>
          {restoreMode?"▲ リストアを閉じる":"▼ バックアップから復元する"}
        </button>
        {restoreMode && (
          <div style={{marginTop:10}}>
            <div style={{color:"#888",fontSize:"0.78rem",marginBottom:6}}>
              保存済みのJSONテキストを貼り付けてください
            </div>
            <textarea
              style={{...S.input,height:100,resize:"vertical",fontSize:"0.72rem",fontFamily:"monospace"}}
              placeholder='{"version":"1.0","customers":[...]}'
              value={restoreText}
              onChange={e=>setRestoreText(e.target.value)}/>
            {restoreMsg && (
              <div style={{color:restoreMsg.startsWith("✅")?"#5ecf7f":"#e06655",
                fontSize:"0.82rem",fontWeight:600,margin:"6px 0"}}>
                {restoreMsg}
              </div>
            )}
            <button onClick={doRestore} className="btn-save" style={{marginTop:8}}>
              復元する
            </button>
          </div>
        )}
      </div>

      {/* JSON表示モーダル */}
      {showJson && (
        <div style={S.overlay}>
          <div style={{...S.modal,maxHeight:"88vh"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div>
                <h3 style={{color:"#4fa3e8",margin:0,fontSize:"1rem"}}>📋 バックアップデータ</h3>
                <div style={{color:"#555",fontSize:"0.72rem",marginTop:2}}>
                  全文をコピーしてメモ帳・メール等に保存
                </div>
              </div>
              <button className="close-btn" onClick={()=>setShowJson(false)}>✕</button>
            </div>

            <textarea
              id="backup-textarea"
              readOnly
              value={jsonText}
              style={{...S.input,height:260,resize:"none",fontSize:"0.65rem",
                fontFamily:"monospace",lineHeight:1.4,overflowY:"auto"}}/>

            <button onClick={copyToClipboard}
              style={{width:"100%",marginTop:10,background:copied?"#1a3a1a":"linear-gradient(135deg,#1a3a4a,#1e5070)",
                border:`1px solid ${copied?"#5ecf7f55":"#4fa3e855"}`,borderRadius:10,padding:"13px",
                color:copied?"#5ecf7f":"#4fa3e8",fontWeight:700,fontSize:"0.95rem",
                cursor:"pointer",fontFamily:"inherit",transition:"all 0.3s"}}>
              {copied ? "✅ コピーしました！" : "📋 全てコピーする"}
            </button>
            <div style={{color:"#444",fontSize:"0.7rem",marginTop:8,textAlign:"center"}}>
              コピー後、メモ帳・メール・Googleドキュメント等に貼り付けて保存してください
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── STAFF MGMT PANEL ─────────────────────
function StaffMgmtPanel({ staffAccounts, saveStaffAccounts, managerAccounts, saveManagerAccounts, customers, vipGiftDrink, saveVipGiftDrink, menu }) {
  const [editingStaff,  setEditingStaff]  = useState(null);
  const [editingMgr,    setEditingMgr]    = useState(null);
  const [form,          setForm]          = useState({});
  const [linkTarget,    setLinkTarget]    = useState(null);
  const [linkTargetMgr, setLinkTargetMgr] = useState(null);
  const upd = (f,v) => setForm(p=>({...p,[f]:v}));

  const openNewStaff  = () => { setForm({id:`st_${Date.now()}`,name:"",password:"",linkedCustomerId:null}); setEditingStaff("new"); };
  const openEditStaff = (acc) => { setForm({...acc}); setEditingStaff(acc.id); };
  const saveStaff = () => {
    if (!form.name.trim()||!form.password.trim()) return;
    if (editingStaff==="new") saveStaffAccounts([...staffAccounts, form]);
    else saveStaffAccounts(staffAccounts.map(a=>a.id===editingStaff?form:a));
    setEditingStaff(null);
  };
  const delStaff = (id) => { if(window.confirm("削除しますか？")) saveStaffAccounts(staffAccounts.filter(a=>a.id!==id)); };

  const openNewMgr  = () => { setForm({id:`mg_${Date.now()}`,name:"",password:"",linkedCustomerId:null}); setEditingMgr("new"); };
  const openEditMgr = (acc) => { setForm({...acc}); setEditingMgr(acc.id); };
  const saveMgr = () => {
    if (!form.name.trim()||!form.password.trim()) return;
    if (editingMgr==="new") saveManagerAccounts([...managerAccounts, form]);
    else saveManagerAccounts(managerAccounts.map(a=>a.id===editingMgr?form:a));
    setEditingMgr(null);
  };
  const delMgr = (id) => {
    if (managerAccounts.length<=1) { alert("マネージャーは最低1人必要です"); return; }
    if(window.confirm("削除しますか？")) saveManagerAccounts(managerAccounts.filter(a=>a.id!==id));
  };

  const linkStaff  = (sid, cid) => { saveStaffAccounts(staffAccounts.map(a=>a.id===sid?{...a,linkedCustomerId:cid}:a)); setLinkTarget(null); };
  const unlinkStaff= (sid) => saveStaffAccounts(staffAccounts.map(a=>a.id===sid?{...a,linkedCustomerId:null}:a));
  const linkMgr    = (mid, cid) => { saveManagerAccounts(managerAccounts.map(a=>a.id===mid?{...a,linkedCustomerId:cid}:a)); setLinkTargetMgr(null); };
  const unlinkMgr  = (mid) => saveManagerAccounts(managerAccounts.map(a=>a.id===mid?{...a,linkedCustomerId:null}:a));

  const AccCard = ({acc, isManager, onEdit, onDel, ltId, setLtId, onLink, onUnlink}) => {
    const linked = acc.linkedCustomerId ? customers.find(c=>c.id===acc.linkedCustomerId) : null;
    return (
      <div style={{background:"#111",border:`1px solid ${isManager?"#d4a85333":"#1e1e1e"}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <span style={{fontSize:"1.2rem"}}>{isManager?"👑":"👤"}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:"0.95rem",color:isManager?"#d4a853":"#e8e0d0"}}>{acc.name}</div>
            <div style={{color:"#888",fontSize:"0.75rem",marginTop:2}}>PW: {acc.password}</div>
          </div>
          <button className="btn-tiny-edit" onClick={()=>onEdit(acc)}>✏️</button>
          <button className="btn-tiny-del"  onClick={()=>onDel(acc.id)}>🗑</button>
        </div>
        <div style={{borderTop:"1px solid #1a1a1a",paddingTop:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{color:"#555",fontSize:"0.72rem"}}>🔗 客アカウントリンク</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{color:"#555",fontSize:"0.72rem"}}>割引率:</span>
              <input
                type="number" min="0" max="100"
                value={acc.discountRate ?? 10}
                onChange={e=>{
                  const rate = Math.min(100, Math.max(0, parseInt(e.target.value)||0));
                  if (isManager) saveManagerAccounts(managerAccounts.map(a=>a.id===acc.id?{...a,discountRate:rate}:a));
                  else saveStaffAccounts(staffAccounts.map(a=>a.id===acc.id?{...a,discountRate:rate}:a));
                }}
                style={{width:52,background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:6,padding:"3px 6px",color:"#5ecf7f",fontSize:"0.82rem",fontWeight:700,fontFamily:"inherit",textAlign:"center"}}
              />
              <span style={{color:"#5ecf7f",fontSize:"0.72rem"}}>%</span>
            </div>
          </div>
          {linked ? (
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{color:"#7be8c8",fontSize:"0.82rem",fontWeight:600}}>{linked.name}</span>
              <div style={{display:"flex",gap:6}}>
                <button style={{background:"transparent",border:"1px solid #2a2a2a",borderRadius:20,padding:"3px 10px",color:"#888",fontSize:"0.72rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>setLtId(ltId===acc.id?null:acc.id)}>変更</button>
                <button style={{background:"transparent",border:"1px solid #3a2020",borderRadius:20,padding:"3px 10px",color:"#e06655",fontSize:"0.72rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>onUnlink(acc.id)}>解除</button>
              </div>
            </div>
          ) : (
            <button style={{background:"#111820",border:"1px solid #7be8c833",borderRadius:20,padding:"4px 12px",color:"#7be8c8",fontSize:"0.78rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>setLtId(ltId===acc.id?null:acc.id)}>
              {ltId===acc.id?"閉じる ↑":"客アカウントを紐付ける"}
            </button>
          )}
          {ltId===acc.id && (
            <div style={{marginTop:8,maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {customers.map(c=>(
                <button key={c.id} style={{background:acc.linkedCustomerId===c.id?"#1a2a20":"#141414",border:`1px solid ${acc.linkedCustomerId===c.id?"#7be8c855":"#222"}`,borderRadius:8,padding:"8px 12px",cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between"}}
                  onClick={()=>onLink(acc.id, c.id)}>
                  <span style={{color:"#e8e0d0",fontSize:"0.85rem"}}>{c.name}</span>
                  <span style={{color:"#555",fontSize:"0.72rem"}}>No.{c.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{...S.page, paddingTop:14, paddingBottom:40}}>
      <BackupPanel customers={customers}/>

      {/* マネージャーアカウント */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <h2 style={{...S.title,margin:0,color:"#d4a853"}}>👑 マネージャー</h2>
        <button className="btn-sm-gold" onClick={openNewMgr}>＋ 追加</button>
      </div>
      {(managerAccounts||[]).map(acc=>(
        <AccCard key={acc.id} acc={acc} isManager={true} onEdit={openEditMgr} onDel={delMgr}
          ltId={linkTargetMgr} setLtId={setLinkTargetMgr} onLink={linkMgr} onUnlink={unlinkMgr}/>
      ))}

      {/* VIPプレゼントドリンク設定 */}
      <div style={{background:"linear-gradient(135deg,#1a1400,#2a2000)",border:"1px solid #ffd70044",borderRadius:12,padding:"14px",marginBottom:14,marginTop:10}}>
        <div style={{color:"#ffd700",fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:6}}>⭐ VIPプレゼント — 今月のドリンク</div>
        {vipGiftDrink ? (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{color:"#e8e0d0",fontWeight:700}}>{vipGiftDrink.emoji} {vipGiftDrink.name}</span>
            <button style={{background:"transparent",border:"1px solid #3a3a3a",borderRadius:20,padding:"3px 10px",color:"#666",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}} onClick={()=>saveVipGiftDrink(null)}>解除</button>
          </div>
        ) : <div style={{color:"#555",fontSize:"0.82rem",marginBottom:10}}>未設定</div>}
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {menu.map(item=>(
            <button key={item.id}
              style={{background:vipGiftDrink?.id===item.id?"#2a2000":"#141414",border:`1px solid ${vipGiftDrink?.id===item.id?"#ffd700":"#2a2a2a"}`,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",color:vipGiftDrink?.id===item.id?"#ffd700":"#888",fontSize:"0.8rem",fontWeight:vipGiftDrink?.id===item.id?700:400,transition:"all 0.15s"}}
              onClick={()=>saveVipGiftDrink(item)}>
              {item.emoji} {item.name}
            </button>
          ))}
        </div>
      </div>

      {/* スタッフアカウント */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <h2 style={{...S.title,margin:0}}>👤 スタッフ</h2>
        <button className="btn-sm-gold" onClick={openNewStaff}>＋ 追加</button>
      </div>
      {staffAccounts.map(acc=>(
        <AccCard key={acc.id} acc={acc} isManager={false} onEdit={openEditStaff} onDel={delStaff}
          ltId={linkTarget} setLtId={setLinkTarget} onLink={linkStaff} onUnlink={unlinkStaff}/>
      ))}
      {staffAccounts.length===0&&<div style={{textAlign:"center",color:"#333",padding:"20px",background:"#0f0f0f",borderRadius:12}}>スタッフアカウントがありません</div>}

      {/* マネージャー編集モーダル */}
      {editingMgr && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"#d4a853",margin:0}}>{editingMgr==="new"?"マネージャー追加":"マネージャー編集"}</h3>
              <button className="close-btn" onClick={()=>setEditingMgr(null)}>✕</button>
            </div>
            <div style={{marginBottom:12}}><label style={S.label}>名前 *</label><input style={S.input} placeholder="例: 田中 店長" value={form.name||""} onChange={e=>upd("name",e.target.value)}/></div>
            <div style={{marginBottom:16}}><label style={S.label}>パスワード *</label><input style={S.input} type="text" value={form.password||""} onChange={e=>upd("password",e.target.value)}/></div>
            <button className="btn-save" style={{opacity:(form.name?.trim()&&form.password?.trim())?1:0.4}} onClick={saveMgr}>{editingMgr==="new"?"追加する":"保存する"}</button>
          </div>
        </div>
      )}

      {/* スタッフ編集モーダル */}
      {editingStaff && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"#d4a853",margin:0}}>{editingStaff==="new"?"スタッフ追加":"スタッフ編集"}</h3>
              <button className="close-btn" onClick={()=>setEditingStaff(null)}>✕</button>
            </div>
            <div style={{marginBottom:12}}><label style={S.label}>名前 *</label><input style={S.input} placeholder="例: 山田 花子" value={form.name||""} onChange={e=>upd("name",e.target.value)}/></div>
            <div style={{marginBottom:16}}><label style={S.label}>パスワード *</label><input style={S.input} type="text" value={form.password||""} onChange={e=>upd("password",e.target.value)}/></div>
            <button className="btn-save" style={{opacity:(form.name?.trim()&&form.password?.trim())?1:0.4}} onClick={saveStaff}>{editingStaff==="new"?"追加する":"保存する"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SalesHistoryPanel({ customers }) {
  // 全会員のhistoryからtype:"use"を集めて日付でグループ化
  const allEntries = [];
  customers.forEach(c => {
    (c.history || []).forEach(h => {
      if (h.type === "use") {
        allEntries.push({ ...h, customerName: c.name });
      }
    });
  });

  // 日付文字列のパース（"2026/5/6 12:34:56" → "2026/5/6"）
  const getDay = (dateStr) => dateStr ? dateStr.split(" ")[0] : "不明";

  // 日付でソート（新しい順）してグループ化
  allEntries.sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);

  const groups = {};
  allEntries.forEach(h => {
    const day = getDay(h.date);
    if (!groups[day]) groups[day] = [];
    groups[day].push(h);
  });

  const days = Object.keys(groups); // 既にソート済み

  return (
    <div style={{...S.page, paddingTop:14, paddingBottom:40}}>
      <h2 style={{...S.title, margin:"0 0 14px"}}>会計履歴</h2>

      {days.length === 0 ? (
        <div style={{textAlign:"center",color:"#333",padding:"40px 0",fontSize:"0.88rem",
          background:"#0f0f0f",borderRadius:12}}>
          まだ会計履歴がありません
        </div>
      ) : days.map(day => {
        const entries = groups[day];
        const dayTotal = entries.reduce((s, h) => s + (h.amount || 0), 0);
        const dayCount = entries.length;

        return (
          <div key={day} style={{marginBottom:20}}>
            {/* 日付ヘッダー */}
            <div style={{
              display:"flex", justifyContent:"space-between", alignItems:"center",
              background:"#141414", border:"1px solid #222", borderRadius:10,
              padding:"10px 14px", marginBottom:8,
              position:"sticky", top:0, zIndex:2,
            }}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{color:"#d4a853",fontSize:"0.9rem"}}>📅</span>
                <span style={{color:"#e8e0d0",fontWeight:700,fontSize:"0.92rem"}}>{day}</span>
                <span style={{color:"#555",fontSize:"0.75rem"}}>({dayCount}件)</span>
              </div>
              <div style={{textAlign:"right"}}>
                <span style={{color:"#555",fontSize:"0.72rem",marginRight:4}}>合計</span>
                <span style={{color:"#d4a853",fontWeight:800,fontSize:"1.05rem"}}>¥{dayTotal.toLocaleString()}</span>
              </div>
            </div>

            {/* その日の会計一覧 */}
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {entries.map((h, i) => {
                const time = h.date ? h.date.split(" ")[1] : "";
                return (
                  <div key={i} style={{
                    background:"#0f0f0f", border:"1px solid #1a1a1a",
                    borderRadius:10, padding:"10px 14px",
                    display:"flex", gap:10, alignItems:"flex-start",
                  }}>
                    <div style={{flexShrink:0,marginTop:2}}>
                      <div style={{color:"#444",fontSize:"0.7rem"}}>{time}</div>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                        <span style={{color:"#e8e0d0",fontWeight:700,fontSize:"0.88rem"}}>{h.customerName}</span>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <span style={{color:"#e8e0d0",fontWeight:800,fontSize:"0.95rem"}}>¥{(h.amount||0).toLocaleString()}</span>
                          {h.discount>0 && (
                            <div style={{color:"#888",fontSize:"0.7rem"}}>割引 -¥{h.discount.toLocaleString()}</div>
                          )}
                        </div>
                      </div>
                      {h.items && (
                        <div style={{color:"#555",fontSize:"0.75rem",marginTop:3,
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {h.items}
                        </div>
                      )}
                      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                        <span style={{
                          color: h.performer==="マネージャー" ? "#d4a853" : "#7ab8e8",
                          background: h.performer==="マネージャー" ? "#1a1400" : "#111820",
                          border: `1px solid ${h.performer==="マネージャー"?"#d4a85333":"#7ab8e833"}`,
                          borderRadius:20, padding:"1px 7px", fontSize:"0.68rem",
                        }}>
                          {h.performer==="マネージャー" ? "👑" : "👤"} {h.performer || "スタッフ"}
                        </span>
                        {h.subtotal && h.subtotal !== h.amount && (
                          <span style={{color:"#3a3a3a",fontSize:"0.7rem"}}>小計 ¥{h.subtotal.toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ORDERS PANEL ─────────────────────────
function OrdersPanel({ orders, customers, saveOrders, saveC, staffName }) {
  const pending   = orders.filter(o=>o.status==="pending").sort((a,b)=>a.createdAt>b.createdAt?1:-1);
  const completed = orders.filter(o=>o.status==="completed").sort((a,b)=>a.completedAt<b.completedAt?1:-1).slice(0,10);

  const completeOrder = (order) => {
    const customer = customers.find(c=>c.id===order.customerId);
    if (!customer) { alert("会員が見つかりません"); return; }
    if (order.total > customer.balance) {
      if (!window.confirm(`残高不足です（残高: ¥${customer.balance.toLocaleString()} / 合計: ¥${order.total.toLocaleString()}）\n続行しますか？`)) return;
    }
    const now = new Date().toLocaleString("ja-JP");
    const updatedCustomer = {
      ...customer,
      balance: (order.isSpecial || order.isVipGift) ? customer.balance : Math.max(0, customer.balance - order.total),
      currentYearPurchases: (customer.currentYearPurchases ?? 0) + 1,
      history: [{
        type:"use", amount:order.total, subtotal:order.subtotal, discount:order.discount,
        items:[
          ...order.items.map(i=>`${i.name}×${i.qty}`),
          ...(order.benefitItems||[]).map(i=>`${i.name}(特典)`),
          ...(order.makaiItem ? [`${order.makaiItem.name}(賄い)`] : []),
        ].join(", "),
        performer: staffName || "スタッフ（注文完了）", date:now,
      }, ...(customer.history||[])].slice(0,60),
    };
    saveC(customers.map(c=>c.id===customer.id ? updatedCustomer : c));
    saveOrders(orders.map(o=>o.orderId===order.orderId
      ? {...o, status:"completed", completedAt:now, completedBy: staffName || "スタッフ"}
      : o
    ));
  };

  const deleteOrder = (orderId) => {
    if (window.confirm("この注文を削除しますか？")) {
      saveOrders(orders.filter(o=>o.orderId!==orderId));
    }
  };

  return (
    <div style={{...S.page, paddingTop:14}}>
      <h2 style={{...S.title,margin:"0 0 14px"}}>注文管理</h2>

      {/* 受付中 */}
      <div style={{color:"#555",fontSize:"0.72rem",letterSpacing:"0.08em",marginBottom:8}}>
        受付中 {pending.length>0&&<span style={{color:"#e0115f",fontWeight:700}}>({pending.length}件)</span>}
      </div>

      {pending.length===0 ? (
        <div style={{textAlign:"center",color:"#333",padding:"24px 0",fontSize:"0.85rem",
          background:"#0f0f0f",borderRadius:12,marginBottom:20}}>
          現在注文はありません
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
          {pending.map(order=>(
            <div key={order.orderId} style={{
              background:"#0f1808",border:`1px solid ${order.rankColor}55`,
              borderRadius:14,padding:"12px 14px",
              boxShadow:`0 0 12px ${order.rankColor}18`,
            }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    <span style={{fontSize:"0.9rem"}}>{order.rankGem}</span>
                    <span style={{color:"#e8e0d0",fontWeight:700,fontSize:"1rem"}}>{order.customerName}</span>
                    {order.isVipGift
                      ? <span style={{color:"#ffd700",fontSize:"0.72rem",border:"1px solid #ffd70055",borderRadius:20,padding:"1px 8px",fontWeight:700}}>⭐ VIPギフト</span>
                      : order.isSpecial
                        ? <span style={{color:"#e040fb",fontSize:"0.72rem",border:"1px solid #e040fb55",borderRadius:20,padding:"1px 8px",fontWeight:700}}>💜 スペシャル</span>
                        : <span style={{color:order.rankColor,fontSize:"0.72rem",border:`1px solid ${order.rankColor}55`,borderRadius:20,padding:"1px 7px"}}>{order.rankName}</span>
                    }
                  </div>
                  <div style={{color:"#555",fontSize:"0.72rem"}}>{order.createdAt}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{color:"#e8e0d0",fontWeight:800,fontSize:"1.15rem"}}>¥{order.total.toLocaleString()}</div>
                  {order.discount>0&&<div style={{color:order.rankColor,fontSize:"0.72rem"}}>割引 -¥{order.discount.toLocaleString()}</div>}
                </div>
              </div>
              <div style={{borderTop:"1px solid #1e2a10",paddingTop:8,marginBottom:10}}>
                {order.items.map((item,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:"0.82rem",marginBottom:3}}>
                    <span style={{color:"#aaa"}}>{item.emoji} {item.name} × {item.qty}</span>
                    <span style={{color:"#888"}}>¥{(item.price*item.qty).toLocaleString()}</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button className="btn-danger" style={{padding:"8px",fontSize:"0.8rem"}}
                  onClick={()=>deleteOrder(order.orderId)}>キャンセル</button>
                {order.staffLinked && order.staffLinked===staffName ? (
                  <div style={{flex:1,background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:10,padding:"10px",
                    color:"#555",fontSize:"0.82rem",textAlign:"center"}}>
                    🔒 自分の注文は完了できません
                  </div>
                ) : (
                  <button className="btn-complete" onClick={()=>completeOrder(order)}>
                    ✓ 作成完了・決済する
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 完了済み */}
      {completed.length>0&&(
        <>
          <div style={{color:"#555",fontSize:"0.72rem",letterSpacing:"0.08em",marginBottom:8}}>完了済み（直近10件）</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {completed.map(order=>(
              <div key={order.orderId} style={{background:"#111",border:"1px solid #1e1e1e",borderRadius:10,padding:"10px 12px",opacity:0.7}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <span style={{color:"#888",fontSize:"0.88rem"}}>{order.customerName}</span>
                    <span style={{color:"#444",fontSize:"0.72rem",marginLeft:8}}>{order.completedAt}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:"#5ecf7f",fontSize:"0.85rem",fontWeight:700}}>¥{order.total.toLocaleString()}</span>
                    <span style={{color:"#555",fontSize:"0.72rem"}}>{order.completedBy || "スタッフ"}</span>
                    <span style={{color:"#5ecf7f",fontSize:"0.72rem"}}>✓ 完了</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── MENU MANAGER ─────────────────────────
const EMOJIS = ["☕","🥛","☁️","🫖","🍵","🍊","🥐","🍰","🥪","🫓","🧁","🍩","🥗","🍜","🧃","🫗","🍋","🍓","🥤","🍫","🥞","🍮"];

function MenuManager({ menu, saveMenu, designatedDrink, saveDesignatedDrink }) {
  const [editing,    setEditing]    = useState(null); // item id or "new"
  const [form,       setForm]       = useState({});
  const [emojiPick,  setEmojiPick]  = useState(false);
  const categories = [...new Set(menu.map(m=>m.category))];

  const openNew = () => {
    setForm({ id:`m${Date.now()}`, name:"", category:"コーヒー", price:"", emoji:"☕" });
    setEditing("new");
    setEmojiPick(false);
  };
  const openEdit = (item) => {
    setForm({...item, price:String(item.price)});
    setEditing(item.id);
    setEmojiPick(false);
  };
  const upd = (f,v) => setForm(p=>({...p,[f]:v}));

  const save = () => {
    if (!form.name.trim() || !form.price || !form.category.trim()) return;
    const item = { ...form, price: parseInt(form.price)||0 };
    if (editing === "new") saveMenu([...menu, item]);
    else saveMenu(menu.map(m=>m.id===editing ? item : m));
    setEditing(null);
  };
  const del = (id) => {
    if (window.confirm("このメニューを削除しますか？")) saveMenu(menu.filter(m=>m.id!==id));
  };

  return (
    <div style={{...S.page, paddingTop:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h2 style={{...S.title,margin:0}}>メニュー管理</h2>
        <button className="btn-sm-gold" onClick={openNew}>＋ 追加</button>
      </div>

      {/* ── 今月の指定ドリンク設定（チタン特典用） ── */}
      <div style={{background:"#0e1a1e",border:"1px solid #9da8b044",borderRadius:12,padding:"12px 14px",marginBottom:18}}>
        <div style={{color:"#9da8b0",fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.06em",marginBottom:6}}>
          🩶 チタン特典 — 今月の指定ドリンク
        </div>
        {designatedDrink ? (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{color:"#e8e0d0",fontWeight:700}}>{designatedDrink.emoji} {designatedDrink.name}</span>
            <button style={{background:"transparent",border:"1px solid #3a3a3a",borderRadius:20,
              padding:"4px 10px",color:"#666",fontSize:"0.75rem",cursor:"pointer",fontFamily:"inherit"}}
              onClick={()=>saveDesignatedDrink(null)}>解除</button>
          </div>
        ) : (
          <div style={{color:"#555",fontSize:"0.82rem"}}>未設定 — 下のドリンクから選んで設定してください</div>
        )}
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
          {menu.map(item=>(
            <button key={item.id}
              style={{background:designatedDrink?.id===item.id?"#1e2a30":"#141414",
                border:`1px solid ${designatedDrink?.id===item.id?"#9da8b0":"#2a2a2a"}`,
                borderRadius:8,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",
                color:designatedDrink?.id===item.id?"#9da8b0":"#888",fontSize:"0.8rem",
                transition:"all 0.15s"}}
              onClick={()=>saveDesignatedDrink(item)}>
              {item.emoji} {item.name}
            </button>
          ))}
        </div>
      </div>

      {categories.map(cat=>(
        <div key={cat} style={{marginBottom:18}}>
          <div style={S.catLabel}>{cat}</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {menu.filter(m=>m.category===cat).map(item=>(
              <div key={item.id} style={{background:"#111",border:"1px solid #1e1e1e",borderRadius:10,
                padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:"1.4rem",flexShrink:0}}>{item.emoji}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:"0.95rem"}}>{item.name}</div>
                  <div style={{color:"#d4a853",fontWeight:700,fontSize:"0.85rem"}}>¥{item.price.toLocaleString()}</div>
                </div>
                <button className="btn-tiny-edit" onClick={()=>openEdit(item)}>✏️</button>
                <button className="btn-tiny-del"  onClick={()=>del(item.id)}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 編集・追加モーダル */}
      {editing && (
        <div style={S.overlay}>
          <div style={{...S.modal,paddingBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:"#d4a853",margin:0}}>{editing==="new"?"メニュー追加":"メニュー編集"}</h3>
              <button className="close-btn" onClick={()=>setEditing(null)}>✕</button>
            </div>

            {/* 絵文字ピッカー */}
            <div style={{marginBottom:14}}>
              <label style={S.label}>絵文字</label>
              <button style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,
                padding:"10px 16px",fontSize:"1.6rem",cursor:"pointer",display:"block"}}
                onClick={()=>setEmojiPick(p=>!p)}>
                {form.emoji || "☕"}
              </button>
              {emojiPick && (
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8,background:"#0e0e0e",
                  border:"1px solid #2a2a2a",borderRadius:10,padding:10}}>
                  {EMOJIS.map(e=>(
                    <button key={e} style={{background:form.emoji===e?"#2a2a1a":"#1a1a1a",
                      border:`1px solid ${form.emoji===e?"#d4a853":"#2a2a2a"}`,borderRadius:6,
                      padding:"6px 8px",fontSize:"1.2rem",cursor:"pointer"}}
                      onClick={()=>{ upd("emoji",e); setEmojiPick(false); }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{marginBottom:12}}>
              <label style={S.label}>商品名 *</label>
              <input style={S.input} placeholder="例: カフェラテ" value={form.name||""}
                onChange={e=>upd("name",e.target.value)}/>
            </div>

            <div style={{marginBottom:12}}>
              <label style={S.label}>カテゴリ *</label>
              <input style={S.input} placeholder="例: コーヒー" value={form.category||""}
                onChange={e=>upd("category",e.target.value)}/>
              {/* 既存カテゴリをサジェスト */}
              {categories.length > 0 && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
                  {categories.map(c=>(
                    <button key={c} className="preset-btn" style={{flex:"none",padding:"4px 10px",fontSize:"0.76rem"}}
                      onClick={()=>upd("category",c)}>{c}</button>
                  ))}
                </div>
              )}
            </div>

            <div style={{marginBottom:16}}>
              <label style={S.label}>価格 (¥) *</label>
              <input style={S.input} type="number" placeholder="例: 550" value={form.price||""}
                onChange={e=>upd("price",e.target.value)}/>
            </div>

            <button className="btn-save"
              style={{opacity:(form.name?.trim()&&form.price&&form.category?.trim())?1:0.4}}
              onClick={save}>
              {editing==="new"?"追加する":"保存する"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── YEAR HISTORY MODAL ───────────────────
function YearHistoryModal({ customer, rank, onClose }) {
  const year       = new Date().getFullYear();
  const yearStats  = customer.yearlyStats || [];

  // 今年のデータを先頭に追加（currentYearPurchasesから）
  const currentStat = {
    year,
    purchases: customer.currentYearPurchases ?? 0,
    rankName:  rank.name,
    rankGem:   rank.gem,
    rankColor: rank.color,
    isCurrent: true,
  };
  // 来年のランク予測
  const nextYearRankObj = getRank(customer.currentYearPurchases ?? 0);

  const allStats = [currentStat, ...yearStats.filter(s => s.year !== year)];
  const maxPurchases = Math.max(...allStats.map(s => s.purchases), 1);

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, maxHeight:"90vh"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <h3 style={{color:"#d4a853",margin:0,fontSize:"1rem"}}>📅 年度別履歴</h3>
            <div style={{color:"#555",fontSize:"0.75rem",marginTop:2}}>
              <span style={{color:rank.color}}>{rank.gem} {rank.name}</span> · {customer.name}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {/* 来年のランク予測バナー */}
        <div style={{background:`${nextYearRankObj.color}18`, border:`1px solid ${nextYearRankObj.color}44`,
          borderRadius:10, padding:"10px 14px", marginBottom:14, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <div>
            <div style={{color:"#666",fontSize:"0.7rem",marginBottom:2}}>来年のランク予測（今年の購入回数ベース）</div>
            <div style={{color:nextYearRankObj.color,fontWeight:700,fontSize:"0.9rem"}}>
              {nextYearRankObj.gem} {nextYearRankObj.name}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{color:"#666",fontSize:"0.7rem",marginBottom:2}}>今年の購入</div>
            <div style={{color:nextYearRankObj.color,fontWeight:800,fontSize:"1.2rem"}}>{customer.currentYearPurchases ?? 0}回</div>
          </div>
        </div>

        {/* 年度別カード一覧 */}
        <div style={{overflowY:"auto",maxHeight:"calc(90vh - 200px)",display:"flex",flexDirection:"column",gap:10}}>
          {allStats.length === 0 ? (
            <div style={{textAlign:"center",color:"#333",padding:"32px 0",fontSize:"0.88rem"}}>履歴がありません</div>
          ) : allStats.map((s, i) => {
            const barPct = Math.round((s.purchases / maxPurchases) * 100);
            const isCur  = s.isCurrent;
            return (
              <div key={s.year} style={{
                background: isCur ? "#161620" : "#111",
                border: `1px solid ${isCur ? s.rankColor+"55" : "#1e1e1e"}`,
                borderRadius:12, padding:"14px 16px",
                boxShadow: isCur ? `0 0 16px ${s.rankColor}22` : "none",
              }}>
                {/* 年 & ランク */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{
                      background: isCur ? s.rankColor+"22" : "#1a1a1a",
                      border:`1px solid ${s.rankColor}55`,
                      borderRadius:8, padding:"4px 10px",
                      color:"#888", fontSize:"0.78rem", fontWeight:700,
                    }}>
                      {s.year}年
                      {isCur && <span style={{color:s.rankColor,marginLeft:4,fontSize:"0.68rem"}}>（今年）</span>}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <span style={{fontSize:"1rem"}}>{s.rankGem}</span>
                      <span style={{color:s.rankColor,fontWeight:700,fontSize:"0.88rem"}}>{s.rankName}</span>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span style={{color:s.rankColor,fontWeight:800,fontSize:"1.3rem"}}>{s.purchases}</span>
                    <span style={{color:"#555",fontSize:"0.75rem",marginLeft:3}}>回</span>
                  </div>
                </div>

                {/* 棒グラフ */}
                <div style={{background:"#1a1a1a",borderRadius:6,height:8,overflow:"hidden",marginBottom:8}}>
                  <div style={{
                    height:"100%", borderRadius:6,
                    width:`${barPct}%`,
                    background:`linear-gradient(90deg,${s.rankColor}99,${s.rankColor})`,
                    transition:"width 0.6s ease",
                    minWidth: s.purchases > 0 ? 8 : 0,
                  }}/>
                </div>

                {/* 特典 */}
                {(() => {
                  const r = RANKS.find(r=>r.name===s.rankName) || RANKS[0];
                  return (
                    <div style={{color:"#555",fontSize:"0.75rem"}}>
                      {r.benefit.icon} {r.benefit.desc}
                      <span style={{marginLeft:6,color:r.benefit.type==="always_discount"?"#7ab8e8":"#888",fontSize:"0.68rem"}}>
                        {r.benefit.type==="always_discount"?"毎回自動":"月1回"}
                      </span>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <button className="btn-ghost" style={{marginTop:16}} onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

// ── HISTORY MODAL ────────────────────────
const HIST_CONFIG = {
  use:            { icon:"💳", label:"決済",          color:"#e06655" },
  charge:         { icon:"🎫", label:"チャージ",       color:"#5ecf7f" },
  benefit:        { icon:"🎁", label:"特典使用",       color:"#d4a853" },
  edit_balance:   { icon:"✏️", label:"残高編集",       color:"#7ab8e8" },
  edit_purchases: { icon:"✏️", label:"購入回数変更",   color:"#7ab8e8" },
  benefit_reset:  { icon:"🔄", label:"特典リセット",   color:"#9da8b0" },
  year_reset:     { icon:"🎉", label:"年次リセット",   color:"#a29bfe" },
};

function HistoryModal({ customer, rank, onClose }) {
  const history = customer.history || [];

  const groups = history.reduce((acc, h) => {
    const day = h.date ? h.date.split(" ")[0] : "不明";
    if (!acc[day]) acc[day] = [];
    acc[day].push(h);
    return acc;
  }, {});

  const formatDetail = (h) => {
    if (h.type === "use") {
      const parts = [`¥${h.amount.toLocaleString()}`];
      if (h.discount > 0) parts.push(`(割引 -¥${h.discount.toLocaleString()})`);
      if (h.items) parts.push(`| ${h.items}`);
      return parts.join(" ");
    }
    if (h.type === "charge")         return `+¥2,200 · 購入回数+1`;
    if (h.type === "benefit")        return h.desc || "特典使用";
    if (h.type === "edit_balance")   return `¥${h.before?.toLocaleString()} → ¥${h.after?.toLocaleString()}`;
    if (h.type === "edit_purchases") return `${h.label ? h.label+": " : ""}${h.before}回 → ${h.after}回`;
    if (h.type === "benefit_reset")  return "今月の特典を未使用に戻した";
    if (h.type === "year_reset")     return `年次リセット: 前年${h.prevPurchases}回 → ランク: ${h.newRank} で新年スタート`;
    return "";
  };

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, maxHeight:"88vh"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div>
            <h3 style={{color:"#d4a853",margin:0,fontSize:"1rem"}}>📋 操作履歴</h3>
            <div style={{color:"#555",fontSize:"0.75rem",marginTop:2}}>
              <span style={{color:rank.color}}>{rank.gem} {rank.name}</span> · {customer.name}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {history.length === 0 ? (
          <div style={{textAlign:"center",color:"#333",padding:"32px 0",fontSize:"0.88rem"}}>
            履歴がありません
          </div>
        ) : (
          <div style={{marginTop:14,overflowY:"auto",maxHeight:"calc(88vh - 100px)"}}>
            {Object.entries(groups).map(([day, entries]) => (
              <div key={day} style={{marginBottom:18}}>
                <div style={{color:"#555",fontSize:"0.72rem",letterSpacing:"0.08em",
                  borderBottom:"1px solid #1e1e1e",paddingBottom:4,marginBottom:8}}>
                  📅 {day}
                </div>
                {entries.map((h, i) => {
                  const cfg = HIST_CONFIG[h.type] || {icon:"•",label:h.type,color:"#888"};
                  const time = h.date?.split(" ")[1] || "";
                  return (
                    <div key={i} style={{display:"flex",gap:10,marginBottom:10,alignItems:"flex-start"}}>
                      <div style={{fontSize:"1rem",flexShrink:0,marginTop:1}}>{cfg.icon}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}>
                          <span style={{color:cfg.color,fontWeight:700,fontSize:"0.85rem"}}>{cfg.label}</span>
                          <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                            <span style={{
                              fontSize:"0.68rem",
                              color: h.performer==="マネージャー" ? "#d4a853" : "#666",
                              background: h.performer==="マネージャー" ? "#1a1400" : "#1a1a1a",
                              border: `1px solid ${h.performer==="マネージャー"?"#d4a85344":"#2a2a2a"}`,
                              borderRadius:20, padding:"1px 7px",
                            }}>
                              {h.performer==="マネージャー" ? "👑 MG" : "👤 ST"}
                            </span>
                            <span style={{color:"#444",fontSize:"0.72rem"}}>{time}</span>
                          </div>
                        </div>
                        <div style={{color:"#777",fontSize:"0.78rem",marginTop:2,wordBreak:"break-all"}}>
                          {formatDetail(h)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── CODE MODAL ──────────────────────────
function CodeModal({ customer, rank, onClose }) {
  return (
    <div style={S.overlay}>
      <div style={{...S.modal,paddingBottom:28}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <h3 style={{color:"#d4a853",margin:0,fontSize:"1rem"}}>🔑 お客様確認コード</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{textAlign:"center",marginBottom:16}}>
          <span style={{color:rank.color,fontSize:"0.85rem",fontWeight:700}}>{rank.gem} {rank.name}会員</span>
          <div style={{color:"#e8e0d0",fontWeight:700,fontSize:"1.05rem",marginTop:4}}>{customer.name}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[["会員番号",customer.id,"会員番号欄に入力"],["暗証番号",customer.pin,"暗証番号欄に入力"]].map(([l,v,h])=>(
            <div key={l} style={{background:"#0e0e0e",border:"1px solid #2a2a2a",borderRadius:12,padding:"14px 18px",textAlign:"center"}}>
              <div style={{color:"#555",fontSize:"0.72rem",letterSpacing:"0.08em",marginBottom:6}}>{l}</div>
              <div style={{color:"#e8e0d0",fontSize:"2.2rem",fontWeight:800,letterSpacing:"0.25em"}}>{v}</div>
              <div style={{color:"#3a3a3a",fontSize:"0.7rem",marginTop:6}}>{h}</div>
            </div>
          ))}
        </div>
        <button className="btn-ghost" style={{marginTop:18}} onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

// ── MANAGER PW MODAL ─────────────────────
function ManagerPwModal({ onConfirm, onClose, pwInput, setPwInput, err }) {
  return (
    <div style={S.overlay}>
      <div style={{...S.modal,paddingBottom:28}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h3 style={{color:"#d4a853",margin:0,fontSize:"1rem"}}>🔒 マネージャー認証</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <p style={{color:"#555",fontSize:"0.82rem",marginBottom:12}}>この操作にはマネージャーパスワードが必要です</p>
        <input style={{...S.input,marginBottom:8}} type="password" placeholder="マネージャーパスワード"
          value={pwInput} onChange={e=>setPwInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&onConfirm()} autoFocus/>
        {err && <p style={S.err}>{err}</p>}
        <button className="btn-gold" style={{marginTop:10}} onClick={onConfirm}>認証する</button>
      </div>
    </div>
  );
}

// ── EDIT CUSTOMER ────────────────────────
function EditCustomerModal({ customer, onSave, onDelete, onClose }) {
  const [bal,  setBal]  = useState(String(customer.balance));
  const [pin,  setPin]  = useState(customer.pin || "");
  const [cyp,  setCyp]  = useState(String(customer.currentYearPurchases ?? customer.purchases ?? 0));
  const [rb,   setRb]   = useState(String(customer.rankBasis ?? customer.purchases ?? 0));
  const [isVIP,    setIsVIP]    = useState(!!customer.isVIP);
  const [isSpecial,setIsSpecial]= useState(!!customer.isSpecial);
  const [resetBenefit, setResetBenefit] = useState(false);
  const rankPreview = getRank(parseInt(rb)||0);

  const save = () => {
    const newBal = Math.max(0, parseInt(bal)||0);
    const newCyp = Math.max(0, parseInt(cyp)||0);
    const newRb  = Math.max(0, parseInt(rb)||0);
    const logs = [];
    if (newBal !== customer.balance)
      logs.push({ type:"edit_balance", before:customer.balance, after:newBal, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    if (newCyp !== (customer.currentYearPurchases ?? 0))
      logs.push({ type:"edit_purchases", label:"今年の購入回数", before:customer.currentYearPurchases??0, after:newCyp, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    if (newRb !== (customer.rankBasis ?? 0))
      logs.push({ type:"edit_purchases", label:"ランク基準値", before:customer.rankBasis??0, after:newRb, performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    if (resetBenefit && isBenefitUsed(customer))
      logs.push({ type:"benefit_reset", performer:"マネージャー", date:new Date().toLocaleString("ja-JP") });
    onSave({
      ...customer,
      balance:              newBal,
      pin:                  pin.trim() || customer.pin,
      currentYearPurchases: newCyp,
      rankBasis:            newRb,
      isVIP,
      isSpecial,
      dataYear:             new Date().getFullYear(),
      benefitUsedMonth:     resetBenefit ? null : customer.benefitUsedMonth,
      history: [...logs, ...(customer.history||[])].slice(0,60),
    });
  };

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h3 style={{color:"#d4a853",margin:0}}>会員情報の編集</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>暗証番号（お客様ログイン用）</label>
          <input style={S.input} value={pin} onChange={e=>setPin(e.target.value)} placeholder="例: 1234"/>
          <div style={{color:"#555",fontSize:"0.72rem",marginTop:4}}>お客様が確認画面でこの番号を使用します</div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>残高 (¥)</label>
          <input style={S.input} type="number" value={bal} onChange={e=>setBal(e.target.value)}/>
          <div style={{display:"flex",gap:6,marginTop:8}}>
            {[2200,4400,6600].map(v=>(
              <button key={v} className="preset-btn" onClick={()=>setBal(String((parseInt(bal)||0)+v))}>+¥{(v/1000).toFixed(1)}k</button>
            ))}
            <button className="preset-btn" style={{color:"#e06655"}} onClick={()=>setBal("0")}>リセット</button>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={S.label}>今年の購入回数（来年のランク判定に使用）</label>
          <input style={S.input} type="number" value={cyp} onChange={e=>setCyp(e.target.value)}/>
          <div style={{color:"#555",fontSize:"0.72rem",marginTop:4}}>
            来年のランク予測: <span style={{color:getRank(parseInt(cyp)||0).color,fontWeight:700}}>{getRank(parseInt(cyp)||0).gem} {getRank(parseInt(cyp)||0).name}</span>
          </div>
        </div>
        <div style={{marginBottom:14,background:"#0e0e0e",border:"1px solid #2a2a2a",borderRadius:10,padding:"12px 14px"}}>
          <label style={S.label}>現在のランク基準値（前年の購入回数）</label>
          <input style={S.input} type="number" value={rb} onChange={e=>setRb(e.target.value)}/>
          <div style={{color:rankPreview.color,fontSize:"0.75rem",marginTop:4,fontWeight:700}}>
            {rankPreview.gem} {rankPreview.name} → {rankPreview.benefit.icon} {rankPreview.benefit.desc}
          </div>
        </div>
        {/* 月次特典リセット */}
        {rankPreview.benefit.type === "monthly" && (
          <div style={{marginBottom:14,background:"#0e0e0e",border:"1px solid #2a2a2a",borderRadius:10,padding:"12px 14px"}}>
            <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
              <input type="checkbox" checked={resetBenefit} onChange={e=>setResetBenefit(e.target.checked)}
                style={{width:16,height:16,accentColor:"#d4a853"}}/>
              <div>
                <div style={{color:"#e8e0d0",fontSize:"0.85rem",fontWeight:600}}>今月の特典をリセット</div>
                <div style={{color:"#555",fontSize:"0.75rem"}}>
                  {isBenefitUsed(customer) ? "現在: 使用済み → 未使用に戻す" : "現在: 未使用（変更不要）"}
                </div>
              </div>
            </label>
          </div>
        )}
        {/* VIPステータス */}
        <div style={{marginBottom:10,background:"#0e1218",border:`1px solid ${isVIP?"#ffd70055":"#2a2a2a"}`,borderRadius:10,padding:"12px 14px"}}>
          <label style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
            <div style={{position:"relative",width:44,height:24,background:isVIP?"#b8860b":"#2a2a2a",borderRadius:12,transition:"background 0.2s",flexShrink:0}}
              onClick={()=>setIsVIP(p=>!p)}>
              <div style={{position:"absolute",top:3,left:isVIP?22:3,width:18,height:18,background:"#fff",borderRadius:"50%",transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{color:isVIP?"#ffd700":"#888",fontWeight:700,fontSize:"0.88rem"}}>⭐ VIP会員</div>
              <div style={{color:"#555",fontSize:"0.72rem",marginTop:2}}>毎月プレゼントドリンクが受け取れます</div>
            </div>
          </label>
        </div>
        {/* スペシャルステータス */}
        <div style={{marginBottom:14,background:`${isSpecial?"#1a0a1a":"#0e0e0e"}`,border:`1px solid ${isSpecial?"#e040fb55":"#2a2a2a"}`,borderRadius:10,padding:"12px 14px"}}>
          <label style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
            <div style={{position:"relative",width:44,height:24,background:isSpecial?"#9c27b0":"#2a2a2a",borderRadius:12,transition:"background 0.2s",flexShrink:0}}
              onClick={()=>setIsSpecial(p=>!p)}>
              <div style={{position:"absolute",top:3,left:isSpecial?22:3,width:18,height:18,background:"#fff",borderRadius:"50%",transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{color:isSpecial?"#e040fb":"#888",fontWeight:700,fontSize:"0.88rem"}}>💜 スペシャル</div>
              <div style={{color:"#555",fontSize:"0.72rem",marginTop:2}}>全ての注文が常に無料になります</div>
            </div>
          </label>
        </div>
        <button className="btn-save" onClick={save}>保存する</button>
        <button className="btn-danger" style={{marginTop:8}} onClick={onDelete}>この会員を削除</button>
      </div>
    </div>
  );
}

// ── ADD CUSTOMER ─────────────────────────
function AddCustomerModal({ onSave, onClose, nextId }) {
  const year = new Date().getFullYear();
  const [c,setC]=useState({id:nextId,name:"",pin:"",balance:2000,currentYearPurchases:1,rankBasis:0,dataYear:year,joined:new Date().toISOString().slice(0,10),history:[],benefitUsedMonth:null});
  const upd=(f,v)=>setC(p=>({...p,[f]:v}));
  const ok=c.name.trim()&&c.pin.trim();
  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h3 style={{color:"#ffd700",margin:0}}>新規会員登録</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        {[["name","お名前（ひらがな）*","例: たなか みさき"],["pin","暗証番号 *","数字4桁など（例: 1234）"]].map(([f,l,p])=>(
          <div key={f} style={{marginBottom:12}}>
            <label style={S.label}>{l}</label>
            <input style={S.input} placeholder={p} value={c[f]} onChange={e=>upd(f,e.target.value)}/>
          </div>
        ))}
        <div style={{marginBottom:14}}>
          <label style={S.label}>初回残高 (¥)</label>
          <input style={S.input} type="number" value={c.balance} onChange={e=>upd("balance",parseInt(e.target.value)||0)}/>
        </div>
        <button className="btn-save" style={{opacity:ok?1:0.4}} onClick={()=>ok&&onSave(c)}>登録する</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════
const S = {
  root:          { fontFamily:"'Noto Serif JP',Georgia,serif", background:"#0a0a0a", minHeight:"100vh", color:"#e8e0d0" },
  loading:       { color:"#aaa", textAlign:"center", padding:40 },
  page:          { maxWidth:480, margin:"0 auto", padding:"24px 16px" },

  // HOME
  homeOuter:     { minHeight:"100vh", maxWidth:480, margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", overflow:"hidden", padding:"24px 16px" },
  homeBgCircle1: { position:"absolute", width:340, height:340, borderRadius:"50%", background:"radial-gradient(circle,#ff6b9d22,transparent 70%)", top:-80, right:-80, pointerEvents:"none" },
  homeBgCircle2: { position:"absolute", width:280, height:280, borderRadius:"50%", background:"radial-gradient(circle,#70a1ff22,transparent 70%)", bottom:-60, left:-60, pointerEvents:"none" },
  homeBgCircle3: { position:"absolute", width:200, height:200, borderRadius:"50%", background:"radial-gradient(circle,#ffd70018,transparent 70%)", top:"40%", left:"50%", transform:"translateX(-50%)", pointerEvents:"none" },
  homeWrap:      { display:"flex", flexDirection:"column", alignItems:"center", gap:14, textAlign:"center", position:"relative", zIndex:1, width:"100%" },
  rainbowLogoWrap:{ position:"relative", marginBottom:4 },
  rainbowLogoInner:{ width:100, height:100, borderRadius:"50%", background:"linear-gradient(135deg,#1a1a2a,#0f0f1a)", border:"2px solid transparent", backgroundClip:"padding-box", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 0 2px transparent, 0 8px 32px rgba(0,0,0,0.5)", position:"relative", zIndex:1 },
  rainbowGlow:   { position:"absolute", inset:-3, borderRadius:"50%", background:"linear-gradient(135deg,#ff6b9d,#ff9f43,#ffd700,#7bed9f,#70a1ff,#a29bfe,#ff6b9d)", zIndex:0, filter:"blur(2px)", opacity:0.85 },
  brandRainbow:  { margin:0, fontSize:"2.6rem", fontWeight:800, letterSpacing:"0.08em", lineHeight:1 },
  brandUnderline:{ height:3, borderRadius:2, background:"linear-gradient(90deg,#ff6b9d,#ff9f43,#ffd700,#7bed9f,#70a1ff,#a29bfe)", marginTop:6, width:"100%" },
  taglineRainbow:{ color:"#a0a0b8", fontSize:"0.82rem", letterSpacing:"0.04em", margin:"0" },
  homeBtns:      { display:"flex", flexDirection:"column", gap:12, width:"100%", maxWidth:300 },
  decoRow:       { display:"flex", gap:14, marginTop:4 },
  title:         { fontSize:"1.15rem", color:"#d4a853", letterSpacing:"0.08em", marginBottom:18, fontWeight:700 },
  hint:          { color:"#777", fontSize:"0.85rem", lineHeight:1.7, marginBottom:4 },
  input:         { background:"#141414", border:"1px solid #2a2a2a", borderRadius:8, padding:"12px 14px", color:"#e8e0d0", fontSize:"1rem", width:"100%", outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  err:           { color:"#e05555", fontSize:"0.85rem", margin:"4px 0 0" },
  rankBadge:     { display:"inline-block", border:"1px solid", borderRadius:20, padding:"3px 10px", fontSize:"0.76rem", fontWeight:700, letterSpacing:"0.05em", marginBottom:7 },
  divider:       { borderTop:"1px dashed #ffffff22", margin:"12px 0" },
  bar:           { background:"#ffffff22", borderRadius:4, height:6, overflow:"hidden" },
  benefitBox:    { border:"1px solid", borderRadius:10, padding:"10px 12px", marginTop:12 },
  benefitTagUsed:{ background:"#2a1a1a", color:"#e06655", border:"1px solid #e0665544", borderRadius:20, padding:"3px 10px", fontSize:"0.72rem", fontWeight:700, whiteSpace:"nowrap" },
  benefitTagAvail:{ border:"1px solid", borderRadius:20, padding:"3px 10px", fontSize:"0.72rem", fontWeight:700, whiteSpace:"nowrap" },
  benefitTagAlways:{ background:"#1a1a2a", color:"#7ab8e8", border:"1px solid #7ab8e844", borderRadius:20, padding:"3px 10px", fontSize:"0.72rem", fontWeight:700, whiteSpace:"nowrap" },
  rankRow:       { display:"flex", alignItems:"center", padding:"7px 8px", marginBottom:2, position:"relative" },
  curDot:        { width:6, height:6, borderRadius:"50%", marginLeft:8, flexShrink:0 },
  topbar:        { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", background:"#0e0e0e", borderBottom:"1px solid #1a1a1a", height:44 },
  customerStrip: { padding:"10px 14px", background:"#0f0f0f", borderBottom:"2px solid", flexShrink:0 },
  benefitStripBox:{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0a0a0a", border:"1px solid", borderRadius:8, padding:"6px 10px", marginTop:6, gap:8 },
  catLabel:      { color:"#555", fontSize:"0.75rem", letterSpacing:"0.08em", marginBottom:8, paddingLeft:2 },
  menuGrid:      { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 },
  cartPanel:     { background:"#0e0e0e", borderTop:"1px solid #1e1e1e", padding:"10px 14px", flexShrink:0 },
  cartRow:       { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #181818" },
  cartBadge:     { position:"absolute", top:4, right:4, background:"#d4a853", color:"#0a0a0a", borderRadius:"50%", width:18, height:18, fontSize:"0.7rem", fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center" },
  overlay:       { position:"fixed", inset:0, background:"#000000d8", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:100, backdropFilter:"blur(4px)" },
  modal:         { background:"#111", borderRadius:"20px 20px 0 0", padding:20, width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" },
  label:         { display:"block", color:"#555", fontSize:"0.76rem", marginBottom:5, letterSpacing:"0.05em" },
  tagUsed:       { background:"#2a1a1a", color:"#e06655", border:"1px solid #e0665533", borderRadius:20, padding:"2px 8px", fontSize:"0.7rem", fontWeight:700, whiteSpace:"nowrap" },
  tagAvail:      { background:"#1a2a1a", color:"#5ecf7f", border:"1px solid #5ecf7f44", borderRadius:20, padding:"2px 8px", fontSize:"0.7rem", fontWeight:700, whiteSpace:"nowrap" },
  tagAuto:       { background:"#111820", color:"#7ab8e8", border:"1px solid #7ab8e844", borderRadius:20, padding:"2px 8px", fontSize:"0.7rem", fontWeight:700, whiteSpace:"nowrap" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700;800&display=swap');
* { -webkit-tap-highlight-color:transparent; box-sizing:border-box; }
input:focus { border-color:#d4a853 !important; outline:none; }

.btn-gold  { background:linear-gradient(135deg,#c8922a,#e8b840); color:#0a0a0a; border:none; border-radius:10px; padding:13px 20px; font-size:1rem; font-weight:700; cursor:pointer; width:100%; font-family:inherit; letter-spacing:0.05em; transition:opacity 0.15s,transform 0.1s; }
.btn-gold:hover { opacity:.9; transform:translateY(-1px); }

.btn-rainbow {
  display:flex; align-items:center; justify-content:center; gap:10px;
  width:100%; border:none; border-radius:16px; padding:15px 20px;
  font-size:1rem; font-weight:800; cursor:pointer; font-family:inherit;
  letter-spacing:0.04em; color:#fff; position:relative; overflow:hidden;
  background:linear-gradient(135deg,#ff6b9d,#ff9f43,#ffd700,#7bed9f,#70a1ff,#a29bfe);
  background-size:200% 200%; animation:rainbowShift 4s ease infinite;
  box-shadow:0 4px 24px rgba(255,107,157,0.35); transition:transform 0.15s,box-shadow 0.15s;
  text-shadow:0 1px 4px rgba(0,0,0,0.25);
}
.btn-rainbow:hover { transform:translateY(-2px); box-shadow:0 8px 32px rgba(255,107,157,0.5); }
.btn-rainbow:active { transform:scale(0.97); }

.btn-crystal {
  display:flex; align-items:center; justify-content:center; gap:10px;
  width:100%; border-radius:16px; padding:14px 20px;
  font-size:0.95rem; font-weight:700; cursor:pointer; font-family:inherit;
  letter-spacing:0.04em; color:#c8d8f8;
  background:linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02));
  border:1px solid rgba(255,255,255,0.15);
  box-shadow:0 2px 16px rgba(112,161,255,0.15),inset 0 1px 0 rgba(255,255,255,0.1);
  backdrop-filter:blur(8px); transition:all 0.2s;
}
.btn-crystal:hover { background:linear-gradient(135deg,rgba(255,255,255,0.1),rgba(255,255,255,0.04)); border-color:rgba(255,255,255,0.28); box-shadow:0 4px 24px rgba(112,161,255,0.28); }

@keyframes rainbowShift {
  0%   { background-position:0% 50%; }
  50%  { background-position:100% 50%; }
  100% { background-position:0% 50%; }
}
@keyframes letterFloat {
  from { transform:translateY(0px); }
  to   { transform:translateY(-4px); }
}
@keyframes floatDeco {
  from { transform:translateY(0) rotate(-5deg); opacity:0.5; }
  to   { transform:translateY(-6px) rotate(5deg); opacity:0.9; }
}

.btn-ghost { background:transparent; color:#666; border:1px solid #2a2a2a; border-radius:10px; padding:12px 20px; font-size:0.9rem; font-weight:600; cursor:pointer; width:100%; font-family:inherit; transition:border-color 0.2s,color 0.2s; }
.btn-ghost:hover { border-color:#555; color:#bbb; }

.back-btn  { background:transparent; color:#555; border:none; padding:0; font-size:0.85rem; cursor:pointer; font-family:inherit; }
.close-btn { background:#1e1e1e; color:#777; border:none; border-radius:50%; width:28px; height:28px; cursor:pointer; font-size:0.78rem; display:flex; align-items:center; justify-content:center; flex-shrink:0; }

.ticket-card { border-radius:16px; padding:20px; margin-bottom:8px; }
.bar-fill    { height:100%; border-radius:4px; transition:width 0.6s ease; }

.c-row { background:#111; border:1px solid #1e1e1e; border-radius:12px; padding:12px 14px; display:flex; align-items:center; gap:10px; cursor:pointer; transition:background 0.15s; }
.c-row:hover { background:#161616; }

.pill-btn      { background:#1e1e1e; color:#888; border:1px solid #2a2a2a; border-radius:20px; padding:4px 10px; font-size:0.75rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-gold { background:#1a1400; color:#d4a853; border:1px solid #d4a85344; border-radius:20px; padding:5px 12px; font-size:0.78rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-gold:hover { background:#221b00; }
.pill-btn-dim  { background:#1a1a1a; color:#666; border:1px solid #2a2a2a; border-radius:20px; padding:5px 12px; font-size:0.78rem; cursor:pointer; font-family:inherit; white-space:nowrap; }
.pill-btn-code { background:#111820; color:#7ab8e8; border:1px solid #7ab8e844; border-radius:20px; padding:4px 10px; font-size:0.78rem; cursor:pointer; font-family:inherit; }
.pill-btn-hist { background:#181218; color:#b87ab8; border:1px solid #b87ab844; border-radius:20px; padding:4px 10px; font-size:0.78rem; cursor:pointer; font-family:inherit; }
.pill-btn-year { background:#121820; color:#7be8c8; border:1px solid #7be8c844; border-radius:20px; padding:4px 10px; font-size:0.78rem; cursor:pointer; font-family:inherit; }

.tag-use-btn { border:1px solid; border-radius:20px; padding:3px 10px; font-size:0.72rem; font-weight:700; background:transparent; cursor:pointer; font-family:inherit; white-space:nowrap; transition:opacity 0.15s; }
.tag-use-btn:hover { opacity:0.75; }

.menu-item { background:#141414; border:1px solid #222; border-radius:12px; padding:10px 6px; display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer; font-family:inherit; position:relative; transition:background 0.12s,border-color 0.12s,transform 0.08s; }
.menu-item:hover { background:#1a1a1a; border-color:#333; }
.menu-item:active { transform:scale(0.94); }
.menu-item-active { background:#1e1800 !important; border-color:#d4a85366 !important; }

.btn-pay   { flex:1; background:linear-gradient(135deg,#c8922a,#e8b840); color:#0a0a0a; border:none; border-radius:10px; padding:13px; font-size:0.95rem; font-weight:700; cursor:pointer; font-family:inherit; }
.btn-clear { background:#1a1a1a; color:#666; border:1px solid #2a2a2a; border-radius:10px; padding:13px 16px; font-size:0.9rem; cursor:pointer; font-family:inherit; }
.qty-btn   { background:#222; color:#aaa; border:1px solid #333; border-radius:6px; width:26px; height:26px; font-size:1rem; cursor:pointer; display:flex; align-items:center; justify-content:center; font-family:inherit; }
.qty-btn:hover { background:#2e2e2e; color:#e8e0d0; }

.preset-btn { flex:1; background:#161616; border:1px solid #252525; border-radius:8px; color:#999; font-size:0.8rem; padding:8px 0; cursor:pointer; font-family:inherit; }
.preset-btn:hover { background:#202020; color:#e8e0d0; }

.btn-save   { width:100%; background:linear-gradient(135deg,#c8922a,#e8b840); color:#0a0a0a; border:none; border-radius:10px; padding:14px; font-size:1rem; font-weight:700; cursor:pointer; font-family:inherit; }
.btn-danger { width:100%; background:transparent; color:#e05555; border:1px solid #e0555533; border-radius:10px; padding:11px; font-size:0.88rem; cursor:pointer; font-family:inherit; }
.btn-complete { flex:1; background:linear-gradient(135deg,#1a4a1a,#2a7a2a); color:#7ef07e; border:1px solid #3a7a3a; border-radius:10px; padding:10px; font-size:0.9rem; font-weight:700; cursor:pointer; font-family:inherit; transition:background 0.15s; }
.btn-complete:hover { background:linear-gradient(135deg,#1f5a1f,#307a30); }
.btn-sm-gold { background:#1a1400; color:#d4a853; border:1px solid #d4a85344; border-radius:8px; padding:7px 13px; font-size:0.82rem; cursor:pointer; font-family:inherit; }

.pos-tab { flex:1; background:transparent; border:none; color:#555; padding:10px 0; font-size:0.82rem; cursor:pointer; font-family:inherit; border-bottom:2px solid transparent; transition:color 0.15s,border-color 0.15s; }
.pos-tab-active { color:#d4a853 !important; border-bottom:2px solid #d4a853 !important; font-weight:700; }

.staff-select-btn { display:flex; align-items:center; gap:10px; width:100%; background:#111; border:1px solid #1e1e1e; border-radius:12px; padding:14px 16px; cursor:pointer; font-family:inherit; color:#e8e0d0; font-size:0.95rem; transition:background 0.15s,border-color 0.15s; }
.staff-select-btn:hover { background:#161616; border-color:#2e2e2e; }
.staff-select-btn.manager { border-color:#d4a85333; }
.staff-select-btn.manager:hover { background:#1a1400; border-color:#d4a85366; }

.btn-tiny-edit { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:6px; padding:5px 9px; font-size:0.88rem; cursor:pointer; transition:background 0.15s; flex-shrink:0; }
.btn-tiny-edit:hover { background:#252525; }
.btn-tiny-del  { background:#1a1010; border:1px solid #3a2020; border-radius:6px; padding:5px 9px; font-size:0.88rem; cursor:pointer; transition:background 0.15s; flex-shrink:0; }
.btn-tiny-del:hover { background:#2a1515; }

.flash { position:absolute; right:0; top:-4px; font-size:1rem; font-weight:800; animation:flashPop 1s ease forwards; pointer-events:none; white-space:nowrap; }
.flash-add { color:#7ef07e; }
.flash-sub { color:#e06655; }
@keyframes flashPop {
  0%   { opacity:0; transform:translateY(0) scale(0.7); }
  20%  { opacity:1; transform:translateY(-10px) scale(1.15); }
  70%  { opacity:1; transform:translateY(-14px) scale(1.0); }
  100% { opacity:0; transform:translateY(-22px) scale(0.9); }
}
`;
