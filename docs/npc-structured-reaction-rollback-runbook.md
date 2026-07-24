# NPC Structured Reaction Rollback Runbook

## 1. 目的

このrunbookは、`NPC_STRUCTURED_REACTION_MODE=true`で稼働しているPhase 6 NPC Structured Routeを、安全に`false`へ戻すoperator手順を定める。rollbackは新しく作られるBrowser／CLI gameをlegacy NPC Provider／表示経路へ戻すものであり、既にauthoritative commit済みのNPC graphを巻き戻す操作ではない。

rollbackには2つの目的がある。

- Objective A — Structured Routeだけを停止する: `NPC_STRUCTURED_REACTION_MODE=false`とし、`PLAYER_CONVERSATION_COMMIT_MODE`などのPlayer-side flagsと`LLM_PROVIDER`は変更しない。`LLM_PROVIDER=openai`ならlegacy OpenAI response trafficは継続し得る。
- Objective B — このprocessからのOpenAI trafficを止める: `NPC_STRUCTURED_REACTION_MODE=false`、`LLM_PROVIDER=pseudo`、`OPENAI_API_KEY`未設定を同時に成立させる。

`NPC_STRUCTURED_REACTION_MODE=false`だけでは「OpenAIを全面停止した」ことにならない。

## 2. 対象と非対象

対象は、単一process／単一in-memory sessionで動く現在のBrowser serverとCLI、`WerewolfGame`、Structured Route、Player display handoff、NPC Delivery retry、session-local observation ledgerである。

対象外は、authoritative graphの削除・書換え、`stateVersion`の巻戻し、database migration、cross-process recovery、multi-tab coordination、remote telemetry、Provider retry policy変更、API keyの作成・表示・記録、実OpenAI API smokeである。rollbackのためにschema、Commit、Coordinator、Delivery、Providerを変更しない。

## 3. 重要な安全原則

1. 稼働中のflag hot toggleは提供しない。環境変数を書き換えただけでは、既存Server handler、Browser page、CLI、`WerewolfGame`は切り替わらない。
2. graceful rollbackでは、まず新しいPlayer actionを止め、現在のPlayer表示／NPC Deliveryをclosed terminalへdrainしてからprocess／sessionを終了する。
3. emergency rollbackでは、現在sessionをabandonし、同じlogical reactionをlegacyへ再送しない。旧sessionの回復や再利用を試みない。
4. 同じlogical reactionについてStructured Routeとlegacy Provider／表示fallbackを混在させない。
5. `stateVersion`を減らさず、committed graphを削除・書換えない。rollback境界はold in-memory sessionの破棄とfresh `gameSessionId`の作成である。
6. operator evidenceとして共有できるのは、このrunbookのprivacy条件を満たすredacted `NPC Structured Observations` linesだけである。

## 4. 実装上のflag取得タイミング

| Surface | Flag取得時点 | 稼働中再読込 | rollbackに必要な操作 |
| --- | --- | --- | --- |
| Server | `parseConfig()`／request-handler construction | 0 | server process restart |
| Browser page | 初回`GET /api/runtime-config` | 0 | server restart後のfull reload／tab reopen |
| Browser New Game | pageが保持するcached runtime configを再利用 | 0 | New Gameだけでは不十分 |
| CLI | `runCli()` start | 0 | process exit後にrestart |
| `WerewolfGame` | instance construction | 0 | fresh instance作成 |
| Candidate budget | candidate invoker construction | 0 | process restartでfresh budget |
| Observation ledger | enabled game／session creation | 0 | session destroyでdiscard |

次はrollback完了ではない。

- Serverを`false`へrestartしたが、古いBrowser pageがcached `true`を保持している。古いpageはStructured Routeを選び、candidate endpointの`404`でfail closedし、legacy fallbackしない。
- Serverがまだ`true`のままBrowserだけをreloadした。新pageも`true`を取得する。
- 環境変数を変えたが、既存CLI processを終了していない。既存CLIは起動時configを使い続ける。

## 5. rollback目的の選択

### Objective A: Structured Routeだけを停止

`NPC_STRUCTURED_REACTION_MODE=false`だけを変更する。Player-side flagsと`LLM_PROVIDER`は現在値を維持する。

PowerShell:

```powershell
$env:NPC_STRUCTURED_REACTION_MODE = "false"
```

POSIX shell:

```sh
export NPC_STRUCTURED_REACTION_MODE=false
```

`LLM_PROVIDER=openai`ならlegacy `/api/npc-response`経路からOpenAI trafficが発生し得る。Objective AはOpenAI全面停止ではない。

### Objective B: このprocessのOpenAI trafficを停止

PowerShell:

```powershell
$env:NPC_STRUCTURED_REACTION_MODE = "false"
$env:LLM_PROVIDER = "pseudo"
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
```

POSIX shell:

```sh
export NPC_STRUCTURED_REACTION_MODE=false
export LLM_PROVIDER=pseudo
unset OPENAI_API_KEY
```

`OPENAI_FALLBACK_TO_PSEUDO=true`だけでは不十分である。fallbackはlegacy error時の挙動であり、OpenAI invocationそのものを禁止しない。API keyをecho、表示、shell historyへ再入力、log、incident record、PRへ記録しない。

## 6. rollback前の状態判定

新しいPlayer actionを止め、redacted observationとUI／CLI controlから現在sessionを次のclosed unionのどれかへ分類する。

| 判定 | 意味 | 次の操作 |
| --- | --- | --- |
| `idle` | pending handoffなし | graceful rollbackを続行 |
| `route_in_progress` | Provider／Validation／Preparation／Commitがbounded execution中 | bounded completionを待つ |
| `player_display_pending` | Commit後、同じfrozen actionのPlayer表示待ち |同じ表示だけを完了 |
| `delivery_retry_pending` | NPC Deliveryの明示retry待ち | `Retry Display`／`retry`で同じhandoffを再開 |
| `terminal_delivery` | `delivered`、`acknowledged_existing`、`failed_terminal`、`pending_none`、`reset` | graceful rollbackを続行 |
| `unknown` | 上記へ一意に分類不能 | 新actionを止め、emergency rollback |

Developer Mode全体、CLI `dev`全体、raw provider response、prompt、private question、Known Information、role／teamはincident evidenceとして共有しない。

## 7. Browserのgraceful rollback

1. Browserから新しい`ask`、`vote`、`night`を送らない。
2. 必要ならDeveloper Modeでredacted `NPC Structured Observations`だけを確認する。
3. `route_in_progress`なら既存bounded deadlineの範囲で完了を待つ。新しいreactionを開始しない。
4. `player_display_pending`なら同じfrozen actionのPlayer表示だけを完了する。
5. `delivery_retry_pending`なら同じAsk controlの`Retry Display`を明示実行する。`repeat_sink`は必要なsinkだけ、`ack_only`はacknowledgementだけを再試行し、Provider、Validation、Preparation、Commit、Player action dispatchは0回である。
6. Deliveryが`delivered`、`acknowledged_existing`、`failed_terminal`、`pending_none`、`reset`のいずれかであることを確認する。
7. pending handoffがなく、新しいmutationを受けられるidle状態であることを確認する。
8. 必要ならredacted observation linesだけをlocal incident recordへ記録する。
9. Browser tabを閉じ、server processを停止する。New Gameでpendingを隠してはならない。
10. Objective AまたはBの環境変数を設定する。
11. `npm.cmd run web`（POSIXでは`npm run web`）で新しいserver processを起動する。
12. Browserをfull reloadするか、新しいtabを開く。古いpageを再利用しない。
13. 「rollback後の検証」を順番に実施する。

Serverだけを先にrestartして古い`true` pageから質問してはならない。古いpageは新Serverの`404`をlegacy fallbackへ変換しない。

## 8. Browserのemergency rollback

`unknown`、wedged、privacy concern、cost incident、bounded drain不能、またはOpenAI trafficを即時停止すべき場合に使用する。

1. 新しいPlayer actionを停止する。
2. 安全に取得できる場合だけredacted observation linesを記録する。取得不能なら診断を省略する。
3. retry／legacy resendを行わず、Browser tabを閉じる。
4. server processを停止する。old sessionはdestroy／abandonされるものとして扱う。
5. Objective AまたはBの環境変数を設定する。
6. serverをrestartし、新しいtabで開く。
7. 「rollback後の検証」を実施する。

pending Player display／NPC Deliveryはabandonされる。old sessionのlate callbackは新sessionのauthority、DOM、CLI outputを変更してはならない。old instanceでcommit済みのgraphをrollbackせず、in-memory session全体を破棄する。persistenceとcross-process recoveryは0なので、old sessionを新processで回復しない。

## 9. CLIのgraceful rollback

1. 新しい`ask`、`vote`、`night` commandを入力しない。
2. 必要なら`dev`でredacted observationだけを確認する。
3. route中ならbounded completionを待つ。
4. Player表示またはDelivery retry待ちなら、同じCLI processで明示`retry`を実行してterminal化する。`repeat_sink`／`ack_only`の境界を維持し、Provider／Commitを再実行しない。
5. pending handoffなしを確認して`quit`する。
6. Objective AまたはBの環境変数を設定する。
7. `npm.cmd run start`（POSIXでは`npm run start`）で新しいCLI processを起動する。
8. 「rollback後の検証」を実施する。

稼働中CLIへの環境変数変更やServer restartはCLIのcaptured configを変更しない。

## 10. CLIのemergency rollback

1. 新しいcommandを停止する。
2. 安全に取得できる場合だけredacted observation linesを記録する。
3. retry、legacy resend、同じquestionの再投入を行わず、CLI processを終了する。
4. Objective AまたはBの環境変数を設定する。
5. fresh CLI processを起動する。
6. 「rollback後の検証」を実施する。

終了時の`destroy()`によりactive reaction、handoff、Delivery runtime、observation ledgerはold sessionとともに無効化される。old CLI processの継続やold session recoveryは行わない。

## 11. rollback後の検証

### Server／Browser

次の順序を変えない。

1. target環境変数で新server processが起動している。
2. `GET /api/runtime-config`が`200`を返す。
3. responseの`npcStructuredReactionMode`が`false`である。
4. runtime configにAPI key、internal request／concurrency／token limitsが含まれない。
5. `POST /api/generate-npc-reaction-candidate`が`404`を返す。bodyへprivate questionやcredentialを入れない。
6. Browserをfull reloadし、fresh `gameSessionId`のNew Gameを開始する。
7. 有効な質問を1件だけ実行し、legacy NPC Provider／表示経路が使われることを確認する。
8. legacy requestの成功だけで終えず、legacy NPC回答が最終DOM reconciliation後もexactly once visibleであり、次のpublic render後も消えないことを確認する。自動回帰は`tests/browserLegacyDisplayReconciliationCorrectionPhase6.test.mjs`のBLR-006を参照する。
9. NPC structured observation ledgerが`unavailable`であることを確認する。
10. `Retry Display`が残っていないことを確認する。

localhostでの非billable確認では、実際にserverを起動したprocessと同じ`PORT`を使う。`PORT`が未設定ならproduction serverのdefault `4173`を使う。別portを固定してはならない。

PowerShell:

```powershell
$port = if ($env:PORT) { $env:PORT } else { "4173" }
$baseUrl = "http://127.0.0.1:$port"

# このendpointの成功responseは200だけであり、非2xxならInvoke-RestMethodがthrowする。
$config = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUrl/api/runtime-config"

if ($config.npcStructuredReactionMode -ne $false) {
  throw "NPC Structured Reaction rollback verification failed."
}

$candidateStatus = $null
try {
  $candidateResponse = Invoke-WebRequest `
    -Method Post `
    -Uri "$baseUrl/api/generate-npc-reaction-candidate" `
    -ContentType "application/json" `
    -Body "{}"
  $candidateStatus = [int]$candidateResponse.StatusCode
} catch {
  if ($null -eq $_.Exception.Response) {
    throw
  }
  $candidateStatus = [int]$_.Exception.Response.StatusCode
}

if ($candidateStatus -ne 404) {
  throw "NPC candidate endpoint remained enabled after rollback."
}
```

POSIX shell:

```bash
(
  set -eu

  port="${PORT:-4173}"
  base_url="http://127.0.0.1:${port}"
  config_file="$(mktemp)"
  trap 'rm -f "$config_file"' EXIT

  config_status="$(
    curl --silent \
      --show-error \
      --output "$config_file" \
      --write-out '%{http_code}' \
      "${base_url}/api/runtime-config"
  )"

  test "$config_status" = "200"
  node --input-type=module --eval '
    const config = JSON.parse(process.argv[1]);
    if (config.npcStructuredReactionMode !== false) {
      throw new Error("NPC Structured Reaction rollback verification failed.");
    }
  ' "$(cat "$config_file")"

  candidate_status="$(
    curl --silent \
      --show-error \
      --output /dev/null \
      --write-out '%{http_code}' \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{}' \
      "${base_url}/api/generate-npc-reaction-candidate"
  )"

  test "$candidate_status" = "404"
)
```

POSIX例は`set -eu`をscoped subshell内だけで有効化する。runtime-config request、status、JSON parse、`npcStructuredReactionMode`、candidate request、statusのいずれかが失敗した時点でsubshellはnonzeroで終了し、後続の成功で上書きしない。temporary-fileの`EXIT` trapもsubshell終了時に実行され、operatorのparent shellへ残らない。全条件が成功した場合だけsubshellは`0`を返す。

どちらの例もcandidate検証bodyは空のJSON objectだけであり、credential、private question、role、team、Known Informationを含めない。commandが失敗した場合や期待statusと異なる場合はrollback完了と判定しない。

### CLI

1. old CLI processが終了済みである。
2. fresh CLIがtarget環境変数を取得している。
3. 有効な`ask`を1件だけ実行し、legacy responseを確認する。
4. Structured candidate invocationとstructured handoffが0である。
5. `dev`のNPC Structured Observationsが`unavailable`である。

Objective Bではさらに、current processが`LLM_PROVIDER=pseudo`であり、API keyが未設定であり、OpenAI fetchが0であることを、credentialを表示せず確認する。実OpenAI APIは呼ばない。

## 12. in-flight／commit／deliveryの扱い

| 状態 | graceful | emergency | 禁止事項 |
| --- | --- | --- | --- |
| `idle` | process／sessionを終了 | 直ちに終了可 | 不要なtest action |
| `route_in_progress` | bounded completionを待つ | old sessionをabandon | 同じreactionのlegacy送信 |
| `player_display_pending` | 同じPlayer表示を完了 | old sessionをabandon | Player action再dispatch |
| `delivery_retry_pending` | 明示retryでterminal化 | retryせずabandon | Provider／Commit再実行 |
| NPC committed／未表示 | Player→NPC順を維持してdrain | graphを巻き戻さずsession破棄 | state rewrite／legacy fallback |
| terminal delivery | idle確認後に終了 | 終了可 | 二重表示／二重ack |
| `unknown` | 使用しない | emergencyへ移行 | 推測でterminal扱い |

どの状態でも`stateVersion` decrementは0、authoritative graph rewrite／deleteは0である。fresh process／gameはfresh `gameSessionId`を持ち、old in-memory identityを継承しない。

## 13. 診断情報の取得とprivacy

共有可能なのはformatter済みのredacted `NPC Structured Observations` linesだけである。session-local ledgerはremote telemetryでもpersistent audit logでもない。Browserでは必要なlineだけ、CLIでは必要な`dev` lineだけをlocalに記録する。

次を記録・共有しない。

- API key、`Authorization` header、cookie
- raw provider response、prompt、private question
- Known Information、role、team
- retry token、receipt capability
- stack、cause、local absolute path
- Developer ModeまたはCLI `dev`の無関係な全量dump

診断取得がthrowまたはprivacy boundary不明なら、固定のunavailable状態として扱い、emergency rollbackを続行する。

## 14. 失敗時の停止条件

次のいずれかなら新しいaction、retry、再有効化を停止し、incident ownerへescalateする。

- pre-stateをclosed unionへ分類できない。
- graceful drainがbounded deadline内に終わらない。
- Player表示とNPC Deliveryの順序またはretry identityを確認できない。
- runtime configが`false`でない、またはcandidate endpointが`404`でない。
- Browserをfull reloadしていない、CLIをrestartしていない。
- flag-off sessionでStructured candidate／handoff／observation ledgerが現れる。
- old session callbackがfresh DOM／CLI／authorityへ作用する。
- Objective Bで`LLM_PROVIDER=pseudo`またはAPI key未設定をsecret非表示で確認できない。
- redacted evidenceだけでは調査できず、private dataの共有が必要になりそうである。

停止後も、同じlogical reactionをlegacyへ再送したり、committed graphを手動削除したりしない。

## 15. 既知の制約

- state、Coordinator、Delivery、ledgerはin-memoryであり、process終了後のrecovery／persistenceはない。
- Browser runtime configはpage lifetimeでcachedされ、New Gameでは再取得しない。
- 複数server process、multi-tab、distributed rate limit、cross-process candidate budget coordinationはない。
- Objective Aではlegacy OpenAI trafficが継続し得る。
- Slice 6 candidate routeのbillable live smokeは未実施である。
- このrunbookと決定的なmock／localhost testsはflag-on readinessまたはproduction readinessを宣言しない。F-06 acceptanceと明示的なenable判断は別工程である。

## 16. 再有効化について

rollback後に`NPC_STRUCTURED_REACTION_MODE=true`へ戻す操作はrollbackの一部ではない。F-06 acceptance、独立レビュー、risk ownerの明示承認、最新HEADのCI、必要なcontrolled validationを別途完了してから、新しいprocess／page／gameで行う。

old sessionを再利用せず、Server restart、Browser full reload／new tab、CLI restart、fresh `WerewolfGame`を必須とする。再有効化のためにlegacy reactionをStructured Routeへbackfillしない。

## 17. operator checklist

- [ ] Objective AまたはObjective Bを選択し、Objective AがOpenAI全面停止ではないと理解した。
- [ ] 新しい`ask`／`vote`／`night`を停止した。
- [ ] current stateをclosed unionへ分類した。`unknown`ならemergencyを選んだ。
- [ ] gracefulではPlayer表示とNPC Deliveryを同じhandoffでterminal化した。
- [ ] emergencyではretry／legacy resendをせずold sessionをabandonした。
- [ ] API key、raw provider data、private game dataを表示・記録していない。
- [ ] Browser tab／CLI processとServerを必要な順序で停止した。
- [ ] target環境変数を設定し、新processを起動した。
- [ ] Browserはfull reload／new tab、CLIはfresh process、gameはfresh instanceである。
- [ ] runtime configが`npcStructuredReactionMode: false`である。
- [ ] candidate endpointが`404`であり、flag-offのlegacy questionが1件成功し、legacy NPC回答が最終reconciliationと次のpublic render後もexactly once visibleである。
- [ ] structured ledgerは`unavailable`、pending `Retry Display`／handoffは0である。
- [ ] Objective Bでは`LLM_PROVIDER=pseudo`、API key未設定、OpenAI fetch 0をsecret非表示で確認した。
- [ ] `stateVersion`／committed graphを手動変更していない。
- [ ] 再有効化とF-06をこのrollback作業へ混入していない。
