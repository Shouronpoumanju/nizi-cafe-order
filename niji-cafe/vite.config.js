import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// __APP_VER__ … 公開のたびに Vercel が付ける番号（コミットの印）。サーバーも同じ番号を返すので、
// 開きっぱなしの古い画面に「アプリが新しくなりました」と知らせられる。
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VER__: JSON.stringify(String(process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7)),
  },
})
