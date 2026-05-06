# 虹カフェ デジタルチケットシステム（Firebase版）

## Firebase設定手順（初回のみ・10分程度）

### ① Firebaseプロジェクト作成
1. https://console.firebase.google.com にアクセス
2. Googleアカウントでログイン
3. 「プロジェクトを作成」→ 名前「niji-cafe」→ 作成

### ② Realtime Databaseを有効化
1. 左メニューの「構築」→「Realtime Database」
2. 「データベースを作成」→ 「ロックモード」で開始
3. 「ルール」タブをクリックして以下に書き換えて「公開」:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### ③ アプリの設定情報を取得
1. 左上の歯車アイコン「プロジェクトの設定」
2. 「マイアプリ」→ 「</>（ウェブ）」アイコンをクリック
3. アプリ名「niji-cafe-web」で登録
4. 表示される firebaseConfig の中身をコピー

### ④ src/App.jsx を編集
ファイル上部の FIREBASE_CONFIG を書き換える:
```js
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",       // ← コピーした値
  authDomain:        "niji-cafe-xxx.firebaseapp.com",
  databaseURL:       "https://niji-cafe-xxx-default-rtdb.firebaseio.com",
  projectId:         "niji-cafe-xxx",
  storageBucket:     "niji-cafe-xxx.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",
};
```

## GitHubへのアップロード

1. https://github.com でリポジトリ「niji-cafe」を作成
2. このフォルダの中身を全てアップロード

## Vercelへのデプロイ

1. https://vercel.com にGitHubでログイン
2. 「New Project」→「niji-cafe」を選択
3. そのまま「Deploy」
4. URLが発行される（例：https://niji-cafe-xxx.vercel.app）

## 使い方
- 全端末から同じURLにアクセス
- データはFirebaseにリアルタイム同期される
- 1台で決済すると他の全端末に即反映

## デモ用パスワード（本番前に必ず変更）
- マネージャー: 5678
- スタッフ（山田 花子）: 1234
- スタッフ（田中 一郎）: 2345
