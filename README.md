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
- プロセス内でのレート制限と同時実行数制限が適用されます
- ネットワークエラー等の一時的な失敗時には `pseudo` モードへのフォールバックが可能です

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
- `INTERPRETER_SHADOW_MODE`: Phase 2 shadow transportを有効化する（デフォルト: `false`）
- `INTERPRETER_VALIDATION_MODE`: Phase 3 authoritative candidate validationを有効化する（デフォルト: `false`）
- `PLAYER_CONVERSATION_COMMIT_MODE`: Phase 4 atomic player conversation commitを有効化する（デフォルト: `false`、`INTERPRETER_VALIDATION_MODE=true`が必須）
- `PLAYER_STRUCTURED_CONSUMER_MODE`: Phase 5のbrowser/CLI requested consumer modeを選択する（デフォルト: `false`、`PLAYER_CONVERSATION_COMMIT_MODE=true`が必須）
- `NPC_STRUCTURED_REACTION_MODE`: Phase 6 structured NPC reaction route用の基盤flag（デフォルト: `false`、`PLAYER_CONVERSATION_COMMIT_MODE=true`が必須）。現段階ではbrowser/CLIのengine instanceへ値を渡すだけで、provider、commit、publicationの経路は変更しない

Phase 3はvalidationとredacted diagnosticsのみを行い、Interpreter結果をゲームへ適用しません。両方のInterpreter flagが`true`の場合はPhase 3だけが1リクエストを送り、Phase 2 shadow送信は抑止されます。Phase 3をrollbackするには`INTERPRETER_VALIDATION_MODE=false`へ戻します。authoritative session/turn/version lifecycleはengine invariantとしてflagに依存せず維持され、データmigrationは不要です。

Phase 4を有効にすると、検証済みplayer input、AcceptedSpeechAct、semantic event、canonical claim、display plan、publication、legacy player表示entry、idempotency resultを1回の`N -> N+1` transactionで保存します。その後の既存NPC response effectsは成功時だけ別の`N+1 -> N+2` transactionで公開されます。structured publicationはPhase 4では表示consumerに接続されず、legacy entryだけがvisible triggerです。rollbackは`PLAYER_CONVERSATION_COMMIT_MODE=false`へ戻します。既存structured recordは保持され、backfillやdata migrationは不要です。

Phase 5を有効にすると、browser/CLIはrequested consumer modeとしてstructured modeを要求します。初回のOFF→ON切替ではexplicit pre-cutover drainを実行し、必要なlegacy delivery evidenceがすべて揃うまではeffective modeをlegacyのまま維持します。rollbackは`PLAYER_STRUCTURED_CONSUMER_MODE=false`へ戻します。rollbackや切替によってstructured recordsまたはlegacy storageが削除されることはありません。persistence/reload recoveryとmulti-tab coordinationは対象外です。

**注意**: OpenAI APIの利用には別途料金が発生します。自動テストでは引き続き実APIを呼び出さず、本物のHTTPレスポンス形状を模したモックのみを使用します。

2026-07-01にリポジトリ所有者によって、制御された実OpenAIスモークテストが1回成功しました。このテストでは、再試行と `pseudo` フォールバックを無効化した状態で、本番のローカルサーバーおよびプロバイダーのパスを介して正確に1回の実リクエストが行われ、正常終了を確認しました。APIキーはコミットされず、検証後にローカルシェル環境から削除されています。これは制御されたローカル環境での統合を確認するものであり、本プロジェクトを本番環境対応（認証や分散レート制限の実装など）とするものではありません。

### 手動検証用ツール (Mock Server)

本物の OpenAI API を呼び出さずにブラウザ UI を確認するために、モックサーバーが利用可能です。

```bash
node scripts/mock-openai-server.mjs
```

起動後、`http://127.0.0.1:4174/` にアクセスしてください。

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

### 制御された実OpenAIスモークテスト

本物のOpenAI APIとの接続を、最小限のコスト（1リクエスト）で安全に確認するためのコマンドが用意されています。

**注意**: 本コマンドを実行すると、実際にOpenAIの利用料金が発生します。また、実行はローカル環境で開発者自身が行うことを想定しています。

#### 実行手順

1. 必要な環境変数をセットします（APIキーをリポジトリやチャットに貼り付けないでください）。
2. 明示的なオプトインフラグ `I_ACCEPT_API_CHARGES` を指定します。

**Windows (PowerShell):**
```powershell
$env:OPENAI_LIVE_SMOKE_TEST="I_ACCEPT_API_CHARGES"
$env:LLM_PROVIDER="openai"
$env:OPENAI_API_KEY="<your-api-key>"
$env:OPENAI_MODEL="gpt-5.4-mini"
npm.cmd run smoke:openai
```

**macOS / Linux:**
```bash
OPENAI_LIVE_SMOKE_TEST=I_ACCEPT_API_CHARGES \
LLM_PROVIDER=openai \
OPENAI_API_KEY="<your-api-key>" \
OPENAI_MODEL="gpt-5.4-mini" \
npm run smoke:openai
```

#### クリーンアップ (Windows):
```powershell
Remove-Item Env:OPENAI_API_KEY
Remove-Item Env:OPENAI_LIVE_SMOKE_TEST
Remove-Item Env:LLM_PROVIDER
Remove-Item Env:OPENAI_MODEL
```

#### 特徴と制限
- **1リクエスト制限**: プロセス実行につき最大1回のリクエストしか行いません。
- **再試行なし**: 一時的なエラーが発生してもリトライしません。
- **フォールバックなし**: `pseudo` モードへの自動フォールバックは無効化されています。
- **トークン制限**: 最大出力トークン数は120に制限されています。
- **機密保護**: APIキーや生のレスポンス全文はコンソールに出力されません。
- **プロダクションパス**: 本番と同じゲーム生成、検証、サーバーロジックを介して実行されます。

Julesや自動テスト環境では実APIを呼び出しません。

#### 終了コード (Exit Codes)
- `1`: 設定エラーまたはオプトイン未完了
- `2`: ローカルリクエストのバリデーション失敗
- `3`: プロバイダー（OpenAI API）または通信エラー
- `4`: スモークテストのアサーション失敗
- `5`: 予期せぬローカルエラー
- `130`: ユーザーによる中断 (SIGINT)

#### 注意事項
- **環境変数の管理**: macOSやLinuxでコマンドラインに直接APIキーを含めて実行すると、シェルの履歴に残る可能性があります。現在のシェルセッションでのみ有効な環境変数として設定することを推奨します。
- **ファイル出力**: 本テストの結果やログがファイルに書き出されることはありません。
- **安全性**: Julesや自動テスト環境が実APIを呼び出すことは決してありません。

## 構成

- `src/gameEngine.mjs`
  - `GameState` と `PlayerState` を作成、管理します。
  - フェーズ、投票、処刑、占い、襲撃、勝敗判定をコード側で処理します。
  - UIからの非同期操作入口として `dispatchPlayerAction(action)` を提供します。
  - 表示用の公開状態として `getPublicSnapshot()` を提供します。
- `src/responseGenerator.mjs`
  - NPCに許可された情報から、応答要求とプロンプトを組み立てます。
- `src/responseProvider.mjs`
  - `generateResponse(request)` を持つ応答プロバイダーの共通インターフェースを定義します。
  - ブラウザUIでは `HttpResponseProvider` を使用し、サーバー側で設定に応じて `PseudoResponseProvider` または `OpenAIResponseProvider` が選択されます。
- `src/audit.mjs`
  - サンプルプレイ後の最低限の検証を行います。
- `scripts/sample-play.mjs`
  - 固定シナリオで1ゲーム分のサンプルを実行します。

## 設計メモ

### 安全なLLM接続

本プロトタイプは、セキュリティと整合性のために以下の設計を採用しています。

- **サーバーサイド接続**: ブラウザから OpenAI API へ直接接続せず、Node.js サーバーがプロキシとして動作します。これにより、API キーをブラウザへ渡すことなく安全に管理できます。
- **データ最小化**: OpenAI への入力データからは `privateStanceEvidence`（占い結果等の非公開情報）が完全に除外されます。NPC はコード側で決定された `responsePlan.baseText` を事実上の根拠として発言を生成します。
- **状態管理の分離**: LLMにゲーム状態は変更させません。役職、生死、投票、占い結果、襲撃結果、勝敗判定は `WerewolfGame` が管理します。

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
