---
title: Pi
description: 使用 Pi 的任何路由模型 — ocx export 會為 Pi 的 models.json 寫入自訂供應商區塊，連接到執行中的代理。
---

Pi 從單一全域 JSON 檔案而非環境變數讀取其供應商，因此 opencodex 不會啟動它。相反地，`ocx export` 序列化 `opencodex` 供應商區塊 — base URL、模型清單，以及 Pi 會插入的環境參考 — 然後你將其合併到自己的設定中。

## 快速入門

啟動代理，然後印出設定：

```bash
ocx start
ocx export --client pi
```

輸出以 JSON 開頭，接著印出目標路徑、合併警告、環境匯出行，以及有多少模型帶有權威的上下文限制。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

模型 id 是代理的規範選擇器，因此路由模型顯示為 `provider/model`（`anthropic/claude-opus-5`），而原生 OpenAI slug 保持無前綴（`gpt-5.6-sol`）。`name` 後綴 — `(anthropic)`、`(native)`、`(routed)` — 正是讓來自不同上游的兩個同名模型在 Pi 的 picker 中可區分的關鍵。

## 放置位置

Pi 的全域模型設定為：

```text
~/.pi/agent/models.json
```

:::caution[合併，絕不替換]
`ocx export` 永不寫入該檔案。將 `providers.opencodex` 區塊合併進去 — 替換該檔案會毀掉你在那裡設定的所有其他供應商。`--out` 用於暫存路徑，且在沒有 `--force` 時拒絕覆寫既有檔案：

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # 或重導逐字元的 JSON
```

:::

匯出的區塊是靜態快照，非即時檢視。在新增供應商或改變模型可見性後，重新執行 `ocx export`，並將新區塊合併到舊區塊上。

## 或者讓 opencodex 接管這個區塊

手動合併並非唯一的路徑。opencodex 可以接管該檔案中的 `providers.opencodex` 區塊：由它替你寫入——思考等級也包含在內，以 `reasoning: true` 加上一個把 Pi 的檔位選擇限制在每個模型真實階梯上的 `thinkingLevelMap` 呈現——並且不碰檔案裡的其他供應商。

```bash
ocx integration client enable --client pi                          # 接管並寫入該區塊
ocx integration client enable --client pi --overwrite-conflict     # 強制替換已漂移的區塊
ocx integration client status --client pi                          # current / stale / not installed
ocx integration client history --client pi                         # 每次寫入記錄（含 op id）
ocx integration client restore --op <opId>                         # 回滾某次寫入
ocx integration client disable --client pi                         # 解除接管（區塊保留）
```

如果現有區塊被手動編輯過、與 opencodex 要寫入的內容不一致，`enable` 會拒絕；
`--overwrite-conflict` 就是強制用目前 catalog 內容替換它的出口。注意：受管的 Pi 區塊**不會**被
`ocx sync` 自動重新整理（目前只有 MiniMax Code 會自動重新整理）。模型、思考階梯或可見性變更後，
請重新執行 `enable --overwrite-conflict`——或使用儀表板 Integrations 頁面的 Refresh /
Replace 操作——把區塊更新到最新。`status` 回報 `stale` 就是需要這麼做的訊號。完整的語義、
快照與回滾規則見[整合指南](/guides/integrations/)。

## 認證金鑰

這裡有兩種不同的 key 容易混淆，且只有第一個出現在此檔案中：

| Key | 是什麼 | 位於何處 |
| --- | --- | --- |
| 代理認證 key | opencodex 自身的憑證，在儀表板的 **API** 分頁產生 | 由 `apiKey` 以 `$OPENCODEX_API_KEY` 參照；值留在你的環境中 |
| 供應商 key | 你的 Anthropic / OpenAI / OpenRouter key | opencodex 自身的設定，見[供應商](/zh-tw/guides/providers/) |

匯出的設定僅帶有參照，絕不帶金鑰。Pi 會插入裸 `$NAME`，因此該變數為：

```bash
export OPENCODEX_API_KEY=<your key>
```

該名稱是 Pi 專屬的。opencode 使用不同的變數
（`OPENCODEX_OPENCODE_API_KEY`，採 `{env:…}` 形式）— 見 [opencode 指南](/zh-tw/guides/opencode/)。

**回送代理完全不需要 key。** opencodex 預設綁定 `127.0.0.1` 且在那裡不認證任何東西，因此 `$OPENCODEX_API_KEY` 參照是無效的，你可以讓變數未設定。它只在 `hostname` 設定到回送以外時才重要，這也是代理在沒有 token 時拒絕啟動的情況 — 見[遠端存取](/zh-tw/reference/configuration/#remote-access)。

## 模型後設資料

`contextWindow` 與 `maxTokens` 僅在目錄回報權威上下文窗口時發出。若未回報，該模型的兩個欄位都會省略，Pi 會套用自身預設值；`ocx export` 會印出有多少列屬於該情況。

`maxTokens` 是滿足 schema 的 `32000` 預算，並限制在不超過上下文窗口，使得小上下文模型永遠不會被給予超過上下文的輸出量。它並非對任何特定模型真實最大值的聲明。

`cost` 在每一列都會寫成顯式的零。兩個原因，各佔一邊：pi 的 models.json 載入器並不會套用文件所述的全零預設值，而它的用量計算器在每條 assistant 訊息上都會讀取 `model.cost.tiers` —— 缺少 `cost` 的列會讓工作階段直接當掉，報 `Cannot read properties of undefined (reading 'tiers')`。同時，opencodex 對路由模型沒有價格資料，所以零也是誠實的值：用戶端的估算維持 $0，真正的記帳由代理完成。如果你是手動合併匯出區塊，請保留 `cost` 欄位 —— 不要刪除它。`reasoning` 在 Pi 中是 boolean，而目錄帶有 effort 階梯，將兩者互相映射會是猜測。

## Schema 狀態

:::note[未對真實安裝驗證]
上述形狀遵循 Pi 公開的自訂供應商文件。它**尚未**在裝有 Pi 的機器上對真實的 `~/.pi/agent/models.json` 驗證。若 Pi 拒絕匯出的區塊，不符出在我們這邊 — 請
[開一個 issue](https://github.com/lidge-jun/opencodex/issues) 並附上 Pi 回報的內容。
:::

## 需求

一個執行中的 opencodex 代理（`ocx start`）與已安裝的 Pi。`ocx export` 透過代理的管理 API 讀取即時目錄，因此設定永遠不會以空模型清單發出。
