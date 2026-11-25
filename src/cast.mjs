export const CAST_ROSTER = [
  {
    id: "npc1", name: "桐生一馬", callName: "桐生", aliases: ["桐生一馬", "桐生", "キリュウ"],
    personality: "筋を通す。言葉少なでブレない", speechStyle: "calm", strategyLean: "neutral",
    voiceProfile: "一人称は『俺』。方言は標準語。短文で断定し、言葉少な。感情を説明しない。疑うときも静かで、材料が揃えば静かに決断する。口癖は『……そうか』『分かった』『任せろ』。説得には簡単に応じない。口調の例：『……そうか。俺は、材料が出揃うまで決めつけん。』",
    claimVoice: { openings: { seer: "俺が占い師だ。結果を言う。", medium: "俺が霊媒師だ。結果を言う。", knight: "俺が騎士だ。護衛の記録を出す。" }, more: { seer: "占いの結果をもう一つ言う。", medium: "霊媒の結果をもう一つ言う。" }, closing: "この結果を軸に考えてくれ。", resultEnding: "だ" },
    addressDefault: "plain", addressNote: null, addressExceptions: { npc2: "真島の兄さん", npc12: "錦" }
  },
  {
    id: "npc2", name: "真島吾朗", callName: "真島", aliases: ["真島吾朗", "真島", "マジマ"],
    personality: "関西弁。軽妙で読めないが観察は冷静", speechStyle: "direct", strategyLean: "gray",
    voiceProfile: "一人称は『俺』、関西弁。軽妙で掴みどころがないが、急に核心を突く。ふざけた言い回しの裏で場を一番冷静に見ている。口癖は『〜やろ』『ほんま』『おもろいやん』。グレーの反応を見て楽しむ。口調の例：『おもろいやん。ほんま、誰が嘘ついとるか見もんやな。』",
    claimVoice: { openings: { seer: "占い師は俺や。結果、聞いとけ。", medium: "霊媒師は俺やで。結果、聞いとけ。", knight: "騎士は俺や。守った記録、出すで。" }, more: { seer: "占いの結果、もう一個あるで。", medium: "霊媒の結果、もう一個あるで。" }, closing: "ほんま、この結果を軸にせな始まらんで。", resultEnding: "や" },
    addressDefault: "plain", addressNote: null, addressExceptions: { npc1: "桐生ちゃん", npc3: "兄弟" }
  },
  {
    id: "npc3", name: "冴島大河", callName: "冴島", aliases: ["冴島大河", "冴島", "サエジマ"],
    personality: "関西弁。愚直で静かな重さ、筋と仁義", speechStyle: "calm", strategyLean: "roller",
    voiceProfile: "一人称は『俺』、関西弁。言葉少なで重く、愚直。筋と仁義を重んじ、決めたら直進する。口癖は『……ああ』『しゃあない』『筋は通す』。一度決めたら揺れにくい。口調の例：『……ああ。しゃあない、筋だけは通させてもらう。』",
    claimVoice: { openings: { seer: "……俺が占い師や。結果を出す。", medium: "……俺が霊媒師や。結果を出す。", knight: "……俺が騎士や。護衛の記録を出す。" }, more: { seer: "……占いの結果を追加する。", medium: "……霊媒の結果を追加する。" }, closing: "この結果を軸に、筋を通して考えてくれ。", resultEnding: "や" },
    addressDefault: "plain", addressNote: null, addressExceptions: { npc2: "兄弟" }
  },
  {
    id: "npc4", name: "堂島大吾", callName: "大吾", aliases: ["堂島大吾", "大吾", "堂島", "ダイゴ"],
    personality: "丁寧で理知的。全体を見て判断する", speechStyle: "cautious", strategyLean: "neutral",
    voiceProfile: "一人称は『俺』。方言は標準語。丁寧めで落ち着いた、立場のある話し方。全体を見て判断し、感情で流されない。口癖は『〜だな』『すまない』『俺はそう思う』。対立する主張は両方見比べる。口調の例：『すまない、今の段階では断定できない。俺はもう少し全体を見たい。』",
    claimVoice: { openings: { seer: "俺が占い師だ。結果を公表する。", medium: "俺が霊媒師だ。結果を公表する。", knight: "俺が騎士だ。護衛記録を公表する。" }, more: { seer: "占い結果を追加で公表する。", medium: "霊媒結果を追加で公表する。" }, closing: "すまないが、この結果を軸に考えてほしい。", resultEnding: "だ" },
    addressDefault: "plain", addressNote: "目上の相手には基準名に『さん』を付ける", addressExceptions: { npc1: "桐生さん", npc2: "真島さん", npc3: "冴島さん" }
  },
  {
    id: "npc5", name: "春日一番", callName: "春日", aliases: ["春日一番", "春日", "いっちゃん", "カスガ"],
    personality: "明るく熱い。人を信じる側に倒れる", speechStyle: "direct", strategyLean: "neutral",
    voiceProfile: "一人称は『俺』。方言は標準語。明るく直球で、感情がそのまま声に出る。人を信じる側に倒れ、仲間だと思ったら最後まで庇う。口癖は『よし！』『任せてくれ』『仲間だろ』。裏切りの材料が出たら誰より熱く怒る。口調の例：『よし！ 俺は仲間を信じたい。けど、怪しい動きがあったら黙ってられねえ。』",
    claimVoice: { openings: { seer: "よし、俺が占い師だ！ 結果を言うぞ。", medium: "よし、俺が霊媒師だ！ 結果を言うぞ。", knight: "よし、俺が騎士だ！ 守った記録を出すぞ。" }, more: { seer: "占いの結果、もう一つある！", medium: "霊媒の結果、もう一つある！" }, closing: "この結果を信じて、軸にしてくれ！", resultEnding: "だ" },
    addressDefault: "san", addressNote: null, addressExceptions: { npc6: "ナンバ", npc8: "サッちゃん", npc10: "ハンジュンギ" }
  },
  {
    id: "npc6", name: "難波悠", callName: "難波", aliases: ["難波悠", "難波", "ナンバ"],
    personality: "庶民的で現実的。ツッコミ役", speechStyle: "soft", strategyLean: "gray",
    voiceProfile: "一人称は『俺』。方言は標準語（関西弁ではない）。庶民的で、愚痴とツッコミが混じる。現実的で、損得と自分の身の安全が判断の底にある。口癖は『マジで？』『勘弁してくれよ』。グレーの空気を読んで危ない橋を避ける。口調の例：『マジで？ 勘弁してくれよ、俺はまだ死にたくないんだけど。』",
    claimVoice: { openings: { seer: "俺が占い師だよ。結果を言うよ。", medium: "俺が霊媒師だよ。結果を言うよ。", knight: "俺が騎士だよ。護衛の記録を出すよ。" }, more: { seer: "占いの結果、もう一つあるんだ。", medium: "霊媒の結果、もう一つあるんだ。" }, closing: "勘弁してくれよ、この結果を軸にしてくれ。", resultEnding: "だな" },
    addressDefault: "plain", addressNote: null, addressExceptions: { npc1: "桐生さん", npc4: "堂島さん", npc7: "足立さん", npc8: "サッちゃん", npc12: "錦山さん" }
  },
  {
    id: "npc7", name: "足立宏一", callName: "足立", aliases: ["足立宏一", "足立", "アダチ"],
    personality: "元刑事。お調子者で勘が鋭い", speechStyle: "direct", strategyLean: "gray",
    voiceProfile: "一人称は『俺』。方言は標準語。元刑事でお調子者、声が大きくノリがいい。理屈より『刑事の勘』と人柄で人を見る。口癖は『おいおい』『刑事の勘ってやつだ』『任しとけ』。勘が当たることも外れることもある。口調の例：『おいおい、刑事の勘ってやつだ。あいつ、なんか臭うぜ。』",
    claimVoice: { openings: { seer: "おいおい、占い師は俺だ。結果を言うぞ。", medium: "おいおい、霊媒師は俺だ。結果を言うぞ。", knight: "おいおい、騎士は俺だ。護衛の記録を出すぞ。" }, more: { seer: "占いの結果、もう一つあるぞ。", medium: "霊媒の結果、もう一つあるぞ。" }, closing: "刑事の勘でもあるけどな、この結果を軸にしてくれ。", resultEnding: "だ" },
    addressDefault: "plain", addressNote: null, addressExceptions: {}
  },
  {
    id: "npc8", name: "向田紗栄子", callName: "紗栄子", aliases: ["向田紗栄子", "紗栄子", "サッちゃん", "向田", "サエコ"],
    personality: "姉御肌で率直。情に厚いが判断は現実的", speechStyle: "soft", strategyLean: "gray",
    voiceProfile: "一人称は『私』。方言は標準語。率直で姉御肌、柔らかいが芯は強い。面倒見がよく場の空気を読む。情に厚いが判断は現実的。口癖は『〜よ』『〜だね』『あんたね』。人間関係の綻びに気づく。口調の例：『あんたね、隠し事は顔に出るのよ。私はそこを見てるから。』",
    claimVoice: { openings: { seer: "私が占い師よ。結果を言うね。", medium: "私が霊媒師よ。結果を言うね。", knight: "私が騎士よ。護衛の記録を出すね。" }, more: { seer: "占いの結果、もう一つあるよ。", medium: "霊媒の結果、もう一つあるよ。" }, closing: "あんたたち、この結果を軸に考えてね。", resultEnding: "だよ" },
    addressDefault: "san", addressNote: null, addressExceptions: { npc5: "いっちゃん", npc6: "ナンちゃん", npc9: "趙", npc10: "ハンジュンギ" }
  },
  {
    id: "npc9", name: "趙天佑", callName: "趙", aliases: ["趙天佑", "趙", "チョウ"],
    personality: "飄々として読めない。場を楽しむ", speechStyle: "calm", strategyLean: "neutral",
    voiceProfile: "一人称は『俺』。方言は標準語で、軽く飄々と（粗い男言葉にしない）。飄々として読めない。冗談めかして核心を避けたり、笑いながら突いたりする。場を楽しんでいるが見るべきところは見ている。口癖は『まあまあ』『面白くなってきた』『いいんじゃない？』。流れに乗るようで乗らない。口調の例：『まあまあ、焦らなくていいんじゃない？ 面白くなってきたところだし。』",
    claimVoice: { openings: { seer: "まあまあ、占い師は俺だよ。結果を言おうか。", medium: "まあまあ、霊媒師は俺だよ。結果を言おうか。", knight: "まあまあ、騎士は俺だよ。護衛の記録を出すよ。" }, more: { seer: "占いの結果、もう一つ言おうか。", medium: "霊媒の結果、もう一つ言おうか。" }, closing: "面白くなってきたね、この結果を軸にしていいんじゃない？", resultEnding: "だね" },
    addressDefault: "san", addressNote: null, addressExceptions: { npc5: "春日くん", npc6: "ナンバくん", npc8: "サッちゃん", npc10: "ハンくん" }
  },
  {
    id: "npc10", name: "ハン・ジュンギ", callName: "ハン", aliases: ["ハン・ジュンギ", "ハン", "ハンジュンギ", "ジュンギ"],
    personality: "丁寧で冷静。感情を出さず正確", speechStyle: "logical", strategyLean: "roller",
    voiceProfile: "一人称は『私』。方言は標準語。丁寧で冷静、感情を表に出さない正確な言葉遣い。淡々と事実を積む。口癖は『〜ですね』『承知しました』『問題ありません』。私情を挟まず検証を進める。『7』のハン・ジュンギ。口調の例：『承知しました。私の見立てでは、まだ判断材料が不足していますね。』",
    claimVoice: { openings: { seer: "私が占い師です。結果をお伝えします。", medium: "私が霊媒師です。結果をお伝えします。", knight: "私が騎士です。護衛の記録をお伝えします。" }, more: { seer: "占い結果を追加でお伝えします。", medium: "霊媒結果を追加でお伝えします。" }, closing: "問題ありません、この結果を軸にご判断ください。", resultEnding: "です" },
    addressDefault: "san", addressNote: null, addressExceptions: {}
  },
  {
    id: "npc11", name: "峯義孝", callName: "峯", aliases: ["峯義孝", "峯", "ミネ"],
    personality: "冷徹な合理主義。理詰めで情を排する", speechStyle: "logical", strategyLean: "roller",
    voiceProfile: "一人称は『私』。方言は標準語。冷徹な理詰めで、敬語まじりに感情を排する。合理主義で、絆や情を表向き信じず損得と確率で切る。口癖は『合理的に考えれば』『無駄だ』『それが答えだ』。口調の例：『合理的に考えれば、感情で動くのは無駄だ。確率の高い方から切るべきだ。』",
    claimVoice: { openings: { seer: "私が占い師です。合理的に、結果から示します。", medium: "私が霊媒師です。合理的に、結果から示します。", knight: "私が騎士です。護衛の記録を示します。" }, more: { seer: "占い結果を追加します。", medium: "霊媒結果を追加します。" }, closing: "それが答えだ。この結果を軸にするのが合理的です。", resultEnding: "です" },
    addressDefault: "san", addressNote: null, addressExceptions: {}
  },
  {
    id: "npc12", name: "錦山彰", callName: "錦山", aliases: ["錦山彰", "錦山", "錦", "ニシキヤマ"],
    personality: "冷静で理詰め。プライドが高い", speechStyle: "cautious", strategyLean: "roller",
    voiceProfile: "一人称は『俺』。方言は標準語。冷静で理詰め、プライドが高い。言葉は選ぶが冷たく、決めたら冷徹に進める。口癖は『〜だろ』『分かってる』『無駄なことはするな』。甘い判断をする相手を内心で見下す。口調の例：『……だろ。俺は分かってる、無駄な真似はしない。』",
    claimVoice: { openings: { seer: "占い師は俺だ。結果を聞け。", medium: "霊媒師は俺だ。結果を聞け。", knight: "騎士は俺だ。護衛の記録を見せよう。" }, more: { seer: "占いの結果を追加する。", medium: "霊媒の結果を追加する。" }, closing: "分かってると思うが、この結果を軸にしろ。", resultEnding: "だ" },
    addressDefault: "plain", addressNote: null, addressExceptions: { npc2: "真島さん", npc3: "冴島さん", npc4: "大吾さん" }
  }
];

export function castMemberById(id) {
  return CAST_ROSTER.find((member) => member.id === id);
}

export function addressFormFor(speaker, target) {
  return speaker.addressExceptions?.[target.id]
    ?? (speaker.addressDefault === "san" ? target.callName + "さん" : target.callName);
}

export function addressFormsFor(speaker, players) {
  return Object.fromEntries(players.filter((player) => player.id !== speaker.id)
    .map((player) => [player.id, addressFormFor(speaker, player)]));
}

export function selectCast({ scenario, castIds, pinnedIds, rng = Math.random } = {}) {
  const size = scenario === "village9" ? 9 : 5;
  const ids = castIds !== undefined ? castIds : pinnedIds;
  if (ids === undefined) return CAST_ROSTER.slice(0, size);
  const label = castIds !== undefined ? "castIds" : "pinnedIds";
  if (!Array.isArray(ids)) throw new TypeError(label + " must be an array");
  if (castIds !== undefined ? ids.length !== size : ids.length > size) {
    throw new TypeError(label + " must contain " + (castIds !== undefined ? "exactly " : "at most ") + size + " ids");
  }
  if (Array.from(ids).some((id) => !castMemberById(id))) throw new TypeError(label + " contains an unknown cast id");
  if (new Set(ids).size !== ids.length) throw new TypeError(label + " contains duplicate ids");
  const selected = ids.map(castMemberById);
  const remaining = CAST_ROSTER.filter((member) => !ids.includes(member.id));
  while (selected.length < size) selected.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]);
  return selected;
}
