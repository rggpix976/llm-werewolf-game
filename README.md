# LLM Werewolf Prototype

5人村の一人用・自由対話型人狼ゲームの最小プロトタイプです。

## 実行

```powershell
npm run start
```

PowerShellの実行ポリシーで `npm.ps1` が止まる場合は、次のように実行してください。

```powershell
npm.cmd run start
```

CLIでは以下を使います。

```text
ask <npcId|name|alias> <質問文>
vote
state
log
dev
quit
```

サンプルプレイと監査ログは次で実行できます。

```powershell
npm run sample
```

または:

```powershell
node scripts/sample-play.mjs
```

## 構成

- `src/gameEngine.mjs`
  - `GameState` と `PlayerState` を作成、管理します。
  - フェーズ、投票、処刑、占い、襲撃、勝敗判定をコード側で処理します。
- `src/responseGenerator.mjs`
  - 疑似LLM応答生成器です。
  - 将来はこの `generateNpcResponse(npc, gameState, playerInput)` をLLM接続に差し替えます。
- `src/audit.mjs`
  - サンプルプレイ後の最低限の検証を行います。
- `scripts/sample-play.mjs`
  - 固定シナリオで1ゲーム分のサンプルを実行します。

## 設計メモ

LLMにゲーム状態は変更させません。役職、生死、投票、占い結果、襲撃結果、勝敗判定は `WerewolfGame` が管理します。

応答生成器は発言文、参照した根拠、将来LLMへ渡す想定のプロンプトプレビューだけを返します。開発者ログでは `knownInfo`、`hiddenInfo`、`suspicionScores`、投票理由、占い対象、襲撃対象、応答生成時の根拠を確認できます。
