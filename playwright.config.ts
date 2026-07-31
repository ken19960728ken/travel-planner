import { defineConfig } from '@playwright/test'

try {
  process.loadEnvFile('.env.test.local')
} catch {
  // 無此檔（如 CI 環境）時靜默跳過，測試內的清理邏輯會自行判斷
}

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
