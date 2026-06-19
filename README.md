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

自動テスト:

```powershell
npm.cmd test
```

## 構成

- `src/gameEngine.mjs`
  - `GameState` と `PlayerState` を作成、管理します。
  - フェーズ、投票、処刑、占い、襲撃、勝敗判定をコード側で処理します。
  - UIからの非同期操作入口として `dispatchPlayerAction(action)` を提供します。
  - 表示用の公開状態として `getPublicSnapshot()` を提供します。
- `src/responseGenerator.mjs`
  - NPCに許可された情報から、応答要求とプロンプトを組み立てます。
- `src/responseProvider.mjs`
  - `generateResponse(request)` を持つ応答プロバイダーの既定実装を提供します。
  - 現在は `PseudoResponseProvider` を使用し、将来は実LLMプロバイダーへ差し替えられます。
- `src/audit.mjs`
  - サンプルプレイ後の最低限の検証を行います。
- `scripts/sample-play.mjs`
  - 固定シナリオで1ゲーム分のサンプルを実行します。

## 設計メモ

LLMにゲーム状態は変更させません。役職、生死、投票、占い結果、襲撃結果、勝敗判定は `WerewolfGame` が管理します。

応答プロバイダーは発言文と診断用メタデータだけを返します。役職COの許可、公開情報、記憶更新は `WerewolfGame` が処理します。開発者ログでは `knownInfo`、`hiddenInfo`、`suspicionScores`、投票理由、占い対象、襲撃対象、応答生成時の根拠を確認できます。

## UI非依存アクションAPI

CLIや将来のブラウザUIは、次のように共通の入口からゲームを操作します。

```js
await game.dispatchPlayerAction({
  type: "ask_npc",
  target: "npc1",
  input: "Chikaの発言は怪しくない？",
  logCursor: 0
});
```

現在のアクション種別:

- `ask_npc`
- `advance_vote`
- `run_night`
- `get_state`

戻り値には、処理結果、表示用の `publicSnapshot`、新規プレイヤーログ、次の `logCursor` が含まれます。

## 応答プロバイダー

```js
const responseProvider = {
  name: "custom-provider",
  async generateResponse(request) {
    return {
      text: "NPCの発言文",
      providerName: "custom-provider",
      model: "model-name",
      usage: null,
      notes: []
    };
  }
};

const game = WerewolfGame.create({ responseProvider });
```

プロバイダーにはゲーム状態そのものではなく、読み取り専用の応答要求だけが渡されます。例外、空応答、不正な戻り値が発生した場合、その質問への回答だけを中止し、ゲームは継続します。
