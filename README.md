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

Browser UI:

```powershell
npm.cmd run web
```

Then open `http://127.0.0.1:4173/`. The browser UI starts a separate in-memory session from the CLI. Reloading the page or starting a new game resets that session.

### LLM Providers

現在は2つのモードをサポートしています。

#### 1. pseudoモード (デフォルト)

- APIキー不要
- 決定論的な応答を生成します
- 開発やテストに使用します

#### 2. openaiモード

- OpenAI Responses APIをサーバー経由で呼び出します
- 環境変数で有効化し、APIキーが必要です
- APIキーはブラウザへ送信されず、サーバー側で安全に管理されます

起動例 (PowerShell):

```powershell
$env:LLM_PROVIDER="openai"
$env:OPENAI_API_KEY="sk-..."
npm.cmd run web
```

起動例 (macOS/Linux):

```bash
LLM_PROVIDER=openai OPENAI_API_KEY="sk-..." npm run web
```

**セキュリティ上の注意**:
- APIキーをフロントエンドのコードや `localStorage` 等に保存しないでください。
- APIキーをリポジトリへコミットしないでください。
- `.env` ファイルなどを使用する場合は、必ず `.gitignore` に追加されていることを確認してください。

#### 設定項目 (環境変数)

- `LLM_PROVIDER`: `pseudo` または `openai` (デフォルト: `pseudo`)
- `OPENAI_API_KEY`: OpenAI APIキー (`openai` モードで必須)
- `OPENAI_MODEL`: 使用するモデル (デフォルト: `gpt-5.4-mini`)
- `OPENAI_TIMEOUT_MS`: タイムアウト時間 (ms) (デフォルト: `15000`)
- `OPENAI_MAX_RETRIES`: 失敗時の再試行回数 (デフォルト: `1`)
- `OPENAI_MAX_OUTPUT_TOKENS`: 最大出力トークン数 (デフォルト: `220`)
- `OPENAI_MAX_REQUESTS_PER_MINUTE`: 1分間あたりの最大リクエスト数 (デフォルト: `10`)
- `OPENAI_FALLBACK_TO_PSEUDO`: 一時的なエラー時に `pseudo` モードへ切り替えるか (デフォルト: `true`)

**注意**: OpenAI APIの利用には別途料金が発生します。自動テストでは実APIを呼び出さず、本物のHTTPレスポンス形状を模したモックを使用します。本機能は制御されたローカル環境でのモック応答を用いたテストが完了した状態です。実APIの確認は利用者が明示的に設定を行ってから実施してください。

### Developer Mode

ブラウザUIには「Developer Mode」が搭載されています。画面上部のトグルボタンで切り替えることができます。

- **Developer Modeで確認できる情報**:
  - ゲーム診断サマリー（日、フェーズ、生存者、ログ件数など）
  - 各NPCの内部状態（役職、陣営、既知の情報、秘密の情報、疑念スコア、記憶、ポリシーなど）
  - 開発者イベントログ（全NPCの行動、内部判定の履歴）
  - LLM/プロバイダー診断（プロンプトのプレビュー、使用された根拠、使用トークン、エラー詳細）
- **注意点**:
  - 初期状態はOFFです。
  - ローカルでの診断およびデバッグ用であり、認証・認可の境界ではありません。
  - 公開用のUIは引き続き `getPublicSnapshot()` を介して取得される制限された情報のみを使用します。

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

## ゲーム状態の保持

ゲーム状態は実行中のメモリ内だけで保持します。CLIの終了、ブラウザの更新、アプリケーションの終了後にゲームを再開することはできません。

セーブファイル、`localStorage`、IndexedDB、サーバー保存は使用せず、新しいセッションでは新しいゲームを開始します。
