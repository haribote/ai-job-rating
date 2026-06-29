import { describe, expect, it } from "vitest";
import {
	isStatedUnquantified,
	isUnknown,
	NORMALIZED_KEYS,
	type NormalizedKey,
} from "../../shared/job-schema";
import { DEFAULT_SCORING_CONFIG, scoreJob } from "../scoring/score";
import type { AiRunner } from "./ai";
import {
	buildExtractionJsonSchema,
	buildExtractionMessages,
	buildExtractionTool,
	EXTRACTION_MODEL,
	EXTRACTION_TOOL_NAME,
	extractJob,
	extractJobFromHtml,
	MAX_EXTRACTION_ATTEMPTS,
	rawFieldsToNormalizedJob,
	resolveExtractionModel,
} from "./extract";

// プロンプト組立（決定的）: trim 済み本文を含む messages を組み立てる。
describe("buildExtractionMessages", () => {
	it("system と user の 2 メッセージを返し、user に本文を含める", () => {
		const messages = buildExtractionMessages("年収: 700万〜900万");
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("system");
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toContain("年収: 700万〜900万");
	});

	it("同一入力は常に同一 messages（決定的）", () => {
		const a = buildExtractionMessages("本文");
		const b = buildExtractionMessages("本文");
		expect(a).toEqual(b);
	});

	// #88: 要約・翻訳・補完を禁じ原文厳守を促す（モデル非依存の構造的誤りの抑制）。
	it("system プロンプトは原文厳守（要約・翻訳しない）を指示する", () => {
		const system = buildExtractionMessages("本文")[0].content;
		expect(system).toContain("要約");
		expect(system).toContain("原文");
	});

	// #147: 一部モデル（gpt-oss 等）は response_format.json_schema を見ず「schema が無い」と迷走して
	// 504/content=null になる。全正規キーを prompt に明示し、response_format を見ないモデルでも抽出できるようにする。
	it("system プロンプトに全正規キー（schema）を埋め込む", () => {
		const system = buildExtractionMessages("本文")[0].content;
		for (const key of NORMALIZED_KEYS) {
			expect(system).toContain(key);
		}
	});

	// #153: schema description は prompt にも展開される。flexWork のフレックス誘導文言が
	// prompt 経由でも届くこと（response_format を見ないモデルへの recall 底上げ）を固定する。
	// 別箇所の偶然一致で緑になるのを避け、flexWork のキー行に紐付けて検証する。
	it("system プロンプトの flexWork キー行にフレックス誘導文言を含める", () => {
		const system = buildExtractionMessages("本文")[0].content;
		const flexLine = system
			.split("\n")
			.find((line) => line.startsWith("- flexWork:"));
		expect(flexLine).toBeDefined();
		expect(flexLine).toContain("フレックス");
	});

	// #106: companySize の単体優先誘導が prompt 経由でも届くことを、キー行に紐付けて固定する。
	it("system プロンプトの companySize キー行に単体優先の誘導文言を含める", () => {
		const system = buildExtractionMessages("本文")[0].content;
		const sizeLine = system
			.split("\n")
			.find((line) => line.startsWith("- companySize:"));
		expect(sizeLine).toBeDefined();
		expect(sizeLine).toContain("単体");
	});
});

// JSON Schema 定義（決定的）: 全正規キーを property に持つ object schema を返す。
describe("buildExtractionJsonSchema", () => {
	it("全正規キーを properties に持つ object schema を返す", () => {
		const schema = buildExtractionJsonSchema();
		expect(schema.type).toBe("object");
		for (const key of NORMALIZED_KEYS) {
			expect(schema.properties).toHaveProperty(key);
		}
	});

	it("正規スキーマ外のキーを含まない（ラベル正規化の責務をコードに保つ）", () => {
		const schema = buildExtractionJsonSchema();
		const props = Object.keys(schema.properties);
		expect(props.sort()).toEqual([...NORMALIZED_KEYS].sort());
	});

	// #88: 構造的に誤りやすいキーは「何を抜き出すか」を description で明示し曖昧さを潰す。
	it("曖昧になりやすいキーに description を持たせる（skillMatch/benefitsCoverage/annualHolidays/capital）", () => {
		const schema = buildExtractionJsonSchema();
		const keysNeedingGuidance: NormalizedKey[] = [
			"skillMatch",
			"benefitsCoverage",
			"annualHolidays",
			"capital",
		];
		for (const key of keysNeedingGuidance) {
			const prop = schema.properties[key];
			expect(prop.description).toBeDefined();
			expect((prop.description ?? "").length).toBeGreaterThan(0);
		}
	});

	it("skillMatch の description は原文厳守（要約/翻訳しない）を含意する", () => {
		// 文言の完全一致ではなく、要約禁止の方針が読み取れるキーワードを含むことだけ固定する。
		const schema = buildExtractionJsonSchema();
		expect(schema.properties.skillMatch.description).toContain("原文");
	});

	it("overtime の description は定量優先（平均→みなし）を含意する", () => {
		// 設計 §5.2 の優先順位（①平均残業 → ②みなし残業）を抽出指示に明示していることを固定する。
		const schema = buildExtractionJsonSchema();
		const desc = schema.properties.overtime.description ?? "";
		expect(desc).toContain("平均");
		expect(desc).toContain("みなし");
	});

	// #153: 候補モデルはフレックス記載の recall が不足。description で「フレックスの語を抽出する」と
	// 明示誘導し、recall を底上げする（schema-in-prompt と同系統）。
	it("flexWork の description はフレックスの語の抽出を誘導する", () => {
		const schema = buildExtractionJsonSchema();
		const desc = schema.properties.flexWork.description ?? "";
		expect(desc).toContain("フレックス");
	});

	// #151/#153: flexWork は flex 専用の closed categorical。裁量労働=みなし労働は対象外と明示し、
	// 誤って flex に寄せる recall 過剰を防ぐ。
	it("flexWork の description は裁量労働を対象外と明示する", () => {
		const schema = buildExtractionJsonSchema();
		const desc = schema.properties.flexWork.description ?? "";
		expect(desc).toContain("裁量");
	});

	// #106: 単体/連結の従業員数併記で揺れる。単体（自社）優先・グループ/連結除外を description で誘導する。
	it("companySize の description は単体優先・連結除外を誘導する", () => {
		const schema = buildExtractionJsonSchema();
		const desc = schema.properties.companySize.description ?? "";
		expect(desc).toContain("単体");
		expect(desc).toContain("連結");
	});
});

// 正規化マッピング（決定的）: AI の生出力（キーごとの生文字列）を NormalizedJob へ寄せる。
describe("rawFieldsToNormalizedJob", () => {
	it("全正規キーを必須で埋め、取れない項目は unknown 中立にする", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		// 指定しなかったキーは unknown
		expect(isUnknown(job.overtime)).toBe(true);
		// 値があるキーは unknown ではない
		expect(isUnknown(job.annualSalary)).toBe(false);
		// 全キーが必ず存在する
		for (const key of NORMALIZED_KEYS) {
			expect(job[key]).toBeDefined();
		}
	});

	it("未記載トークン（「-」「記載なし」）は unknown 中立に寄せる", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "-",
			overtime: "記載なし",
		});
		expect(isUnknown(job.annualSalary)).toBe(true);
		expect(isUnknown(job.overtime)).toBe(true);
	});

	it("overtime「残業あり」（有り明記だが定量なし）は unknown だが stated を立てる（減点特例）", () => {
		const job = rawFieldsToNormalizedJob({ overtime: "残業あり" });
		// 値は読めないので unknown のまま。ただし stated=true で減点対象になる（§5.2 例外）。
		expect(isUnknown(job.overtime)).toBe(true);
		expect(isStatedUnquantified(job.overtime)).toBe(true);
	});

	it("overtime「みなし残業」（定量なし）も有り明記とみなし stated を立てる", () => {
		const job = rawFieldsToNormalizedJob({ overtime: "みなし残業制度を採用" });
		expect(isStatedUnquantified(job.overtime)).toBe(true);
	});

	it("overtime「残業なし」（否定）は中立のまま（stated を立てない）", () => {
		const job = rawFieldsToNormalizedJob({ overtime: "残業なし" });
		expect(isUnknown(job.overtime)).toBe(true);
		expect(isStatedUnquantified(job.overtime)).toBe(false);
	});

	it("overtime「記載なし」は中立のまま（stated を立てない）", () => {
		const job = rawFieldsToNormalizedJob({ overtime: "記載なし" });
		expect(isStatedUnquantified(job.overtime)).toBe(false);
	});

	it("overtime「残業はありません」（否定）を誤って減点しない（中立のまま）", () => {
		// 裸の「あり」を needle にしないことで「ありません」の誤検出を避ける（precision 優先）。
		const job = rawFieldsToNormalizedJob({ overtime: "残業はありません" });
		expect(isStatedUnquantified(job.overtime)).toBe(false);
	});

	it("overtime「月平均20時間」（定量あり）は numericRange へ寄せ stated を立てない", () => {
		const job = rawFieldsToNormalizedJob({ overtime: "月平均20時間" });
		expect(job.overtime.kind).toBe("numericRange");
		if (job.overtime.kind === "numericRange") {
			expect(job.overtime.min).toBe(20);
			expect(job.overtime.max).toBe(20);
		}
		expect(isStatedUnquantified(job.overtime)).toBe(false);
	});

	it("数値レンジ項目は numericRange へ寄せ min/max を持つ", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("単一値の数値項目は min === max で表す", () => {
		const job = rawFieldsToNormalizedJob({ annualHolidays: "122日" });
		expect(job.annualHolidays.kind).toBe("numericRange");
		if (job.annualHolidays.kind === "numericRange") {
			expect(job.annualHolidays.min).toBe(122);
			expect(job.annualHolidays.max).toBe(122);
		}
	});

	it("括弧内の注記の数値を拾わない（注記付き単数値を正しく取る）", () => {
		// なぜ: 括弧内の補足（グループ全体・時点）の数値を本体の数値と混ぜると min/max が破損する。
		const job = rawFieldsToNormalizedJob({
			companySize: "442名（グループ全体　※2025年11月時点）",
		});
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(442);
			expect(job.companySize.max).toBe(442);
		}
	});

	it("※以降の注記の数値を拾わない", () => {
		// なぜ: 「※経験による」「※2024年実績」等の注記は本体のレンジに混入させない。
		const job = rawFieldsToNormalizedJob({
			annualSalary: "700万〜900万 ※経験により決定（2024年実績）",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("半角括弧の注記の数値も拾わない（NFKC 後も同等に扱う）", () => {
		const job = rawFieldsToNormalizedJob({
			companySize: "120名 (2025/03時点)",
		});
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(120);
			expect(job.companySize.max).toBe(120);
		}
	});

	it("多行値でも各行の ※ 注記の数値を拾わない", () => {
		// なぜ: 改行を含む値で ※ 注記が行末まで効かないと、注記内の数値が本体に混入する。
		const job = rawFieldsToNormalizedJob({
			annualSalary: "700万〜900万\n※経験により決定（2024年実績）",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("注記しか数値を含まない場合は unknown 中立に寄せる", () => {
		// なぜ: 本体に数値がなく括弧内にだけ数値があるとき、注記を本体値と誤認しない。
		const job = rawFieldsToNormalizedJob({
			companySize: "非公開（2025年時点）",
		});
		expect(isUnknown(job.companySize)).toBe(true);
	});

	it("カテゴリ項目（リモート可否）は categorical へ寄せる", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		expect(job.remoteWork.kind).toBe("categorical");
	});

	// gap1: 年収・月給は単位を万円へ正規化する（scoring の希望値が万円前提のため、§5.2）。
	it("円表記の年収を万円へ正規化する（900万円→900）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "9,000,000円" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(900);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("円表記の年収レンジを万円へ正規化する（900万〜1300万）", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "9,000,000円〜13,000,000円",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(900);
			expect(job.annualSalary.max).toBe(1300);
		}
	});

	it("万円表記の年収はそのまま万円で持つ（700万〜900万→700/900）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	// #142: 賞与は金額でなく年間支給回数で評価する。「年N回」の N のみを回数化する。
	it("年N回の賞与は回数を numericRange へ寄せる（年2回→2）", () => {
		const job = rawFieldsToNormalizedJob({ bonus: "年2回" });
		expect(job.bonus.kind).toBe("numericRange");
		if (job.bonus.kind === "numericRange") {
			expect(job.bonus.min).toBe(2);
			expect(job.bonus.max).toBe(2);
		}
	});

	it("年1回・年4回も回数化する（境界の単調性を固定）", () => {
		const once = rawFieldsToNormalizedJob({ bonus: "年1回" });
		const four = rawFieldsToNormalizedJob({ bonus: "年4回" });
		expect(once.bonus).toMatchObject({ kind: "numericRange", min: 1, max: 1 });
		expect(four.bonus).toMatchObject({ kind: "numericRange", min: 4, max: 4 });
	});

	it("回数＋注記が混在しても回数のみ採る（年2回 ※業績連動→2）", () => {
		// なぜ: ※以降の注記は stripAnnotations で除かれ、回数だけが残る。
		const job = rawFieldsToNormalizedJob({ bonus: "年2回 ※業績連動" });
		expect(job.bonus).toMatchObject({ kind: "numericRange", min: 2, max: 2 });
	});

	it("月数・金額・業績連動のみは回数でないので unknown 中立にする", () => {
		// なぜ: 「2ヶ月分」「30万円」「業績連動」の数値は支給回数ではない。誤抽出しない。
		expect(
			isUnknown(rawFieldsToNormalizedJob({ bonus: "2ヶ月分" }).bonus),
		).toBe(true);
		expect(isUnknown(rawFieldsToNormalizedJob({ bonus: "30万円" }).bonus)).toBe(
			true,
		);
		expect(
			isUnknown(rawFieldsToNormalizedJob({ bonus: "業績連動" }).bonus),
		).toBe(true);
	});

	it("非通貨の numericRange は単位換算しない（年間休日 122日→122）", () => {
		// なぜ: 単位換算は通貨項目だけの関心事。日数・人数・時間に副作用を出さない。
		const job = rawFieldsToNormalizedJob({ annualHolidays: "122日" });
		expect(job.annualHolidays.kind).toBe("numericRange");
		if (job.annualHolidays.kind === "numericRange") {
			expect(job.annualHolidays.min).toBe(122);
			expect(job.annualHolidays.max).toBe(122);
		}
	});

	it("非通貨の numericRange（企業規模・人数）は換算しない（9000名→9000）", () => {
		const job = rawFieldsToNormalizedJob({ companySize: "9,000名" });
		expect(job.companySize.kind).toBe("numericRange");
		if (job.companySize.kind === "numericRange") {
			expect(job.companySize.min).toBe(9000);
			expect(job.companySize.max).toBe(9000);
		}
	});

	// gap2: 主要 categorical は生 JP を canonical トークンへ寄せる（scoring の preferred と整合、§5.2）。
	it("リモート可否を canonical（full/partial/onsite）へ寄せる", () => {
		const full = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const partial = rawFieldsToNormalizedJob({ remoteWork: "一部リモート可" });
		const onsite = rawFieldsToNormalizedJob({ remoteWork: "出社" });
		if (full.remoteWork.kind === "categorical") {
			expect(full.remoteWork.categories).toEqual(["full"]);
		}
		if (partial.remoteWork.kind === "categorical") {
			expect(partial.remoteWork.categories).toEqual(["partial"]);
		}
		if (onsite.remoteWork.kind === "categorical") {
			expect(onsite.remoteWork.categories).toEqual(["onsite"]);
		}
	});

	it("フレックスは flex へ寄せ、裁量労働は flexWork に含めず unknown 中立にする", () => {
		const flex = rawFieldsToNormalizedJob({ flexWork: "フレックスタイム制" });
		const deemed = rawFieldsToNormalizedJob({ flexWork: "裁量労働制" });
		expect(flex.flexWork.kind).toBe("categorical");
		if (flex.flexWork.kind === "categorical") {
			expect(flex.flexWork.categories).toEqual(["flex"]);
		}
		// 裁量労働＝みなし労働は flex と別物。closed categorical のため生表記を残さず unknown へ畳む。
		expect(deemed.flexWork.kind).toBe("unknown");
	});

	// closed categorical 回帰: flex に寄らない値（みなし単体・否定）は unknown 中立。否定誤判定もしない。
	it("みなし・フレックス不可は flexWork に残さず unknown にする", () => {
		const deemed = rawFieldsToNormalizedJob({ flexWork: "みなし労働制" });
		const negated = rawFieldsToNormalizedJob({ flexWork: "フレックス不可" });
		expect(deemed.flexWork.kind).toBe("unknown");
		expect(negated.flexWork.kind).toBe("unknown");
	});

	// 修正1: 否定表現が positive canonical へ化けない（部分一致＋登録順の誤判定回帰）。
	it("リモートの否定（不可/なし）は onsite へ寄せる", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["リモート不可", "onsite"],
			["リモートなし", "onsite"],
			["フルリモート不可", "onsite"],
		];
		for (const [raw, expected] of cases) {
			const job = rawFieldsToNormalizedJob({ remoteWork: raw });
			if (job.remoteWork.kind === "categorical") {
				expect(job.remoteWork.categories).toEqual([expected]);
			}
		}
	});

	it("リモートの肯定（フルリモート/リモート可）は full/partial へ寄せる", () => {
		const full = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const partial = rawFieldsToNormalizedJob({ remoteWork: "リモート可" });
		if (full.remoteWork.kind === "categorical") {
			expect(full.remoteWork.categories).toEqual(["full"]);
		}
		if (partial.remoteWork.kind === "categorical") {
			expect(partial.remoteWork.categories).toEqual(["partial"]);
		}
	});

	it("フレックスの否定は flex に化けない（preferred 不一致になる）", () => {
		// なぜ: 「フレックス不可/なし」を flex と誤判定すると preferred と誤マッチする。
		const cases = [
			"フレックス不可",
			"フレックスタイム制なし",
			"フレックス制度なし",
		];
		for (const raw of cases) {
			const job = rawFieldsToNormalizedJob({ flexWork: raw });
			if (job.flexWork.kind === "categorical") {
				expect(job.flexWork.categories).not.toContain("flex");
			}
		}
	});

	it("裸の「あり」needle を撤去し無関係文を誤マッチしない（残業ありが yes に化けない）", () => {
		const job = rawFieldsToNormalizedJob({ flexWork: "残業あり" });
		if (job.flexWork.kind === "categorical") {
			expect(job.flexWork.categories).not.toContain("yes");
		}
	});

	// 修正2: 通貨単位を伴わない裸のノイズ数値を min/max に混入させない。
	it("年収のノイズ数値（年2回の2）を salary レンジに拾わない", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "賞与年2回 700万〜900万",
		});
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(900);
		}
	});

	it("単数の万円表記はそのまま 1 値で持つ（700万→[700]）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		expect(job.annualSalary.kind).toBe("numericRange");
		if (job.annualSalary.kind === "numericRange") {
			expect(job.annualSalary.min).toBe(700);
			expect(job.annualSalary.max).toBe(700);
		}
	});

	// skillMatch は求人スキル集合を categorical として保持する（突合は採点側・#106）。
	it("skillMatch は値を categorical（求人スキル集合）として保持する", () => {
		const job = rawFieldsToNormalizedJob({
			skillMatch: "TypeScript / 3年以上の実務経験",
		});
		expect(job.skillMatch.kind).toBe("categorical");
		// 監査用に生表記は保持する
		expect(job.skillMatch.raw).toBe("TypeScript / 3年以上の実務経験");
	});

	// benefitsCoverage は canonical 閉集合の signal を検出し coverage 値へ寄せる（#102）。
	it("benefitsCoverage は signal を検出し present/total/signals を持つ coverage 値にする", () => {
		const job = rawFieldsToNormalizedJob({
			benefitsCoverage: "完全週休2日制 / 退職金制度 / 住宅手当",
		});
		expect(job.benefitsCoverage.kind).toBe("coverage");
		if (job.benefitsCoverage.kind !== "coverage") return;
		// 完全週休2日制は完全版＋週休2日制の双方が立つ → 退職金・住宅手当 と合わせ 4 signal。
		expect(job.benefitsCoverage.signals).toEqual([
			"allowances",
			"completeTwoDayWeekoff",
			"retirementAllowance",
			"twoDayWeekoff",
		]);
		expect(job.benefitsCoverage.present).toBe(4);
		expect(job.benefitsCoverage.total).toBeGreaterThan(0);
		// 生表記は監査用に保持する
		expect(job.benefitsCoverage.raw).toBe(
			"完全週休2日制 / 退職金制度 / 住宅手当",
		);
	});

	// 生表記があるのに閉集合の signal が 0 件なら 0%（unknown 中立ではない・閉集合限定の充足率）。
	it("benefitsCoverage は閉集合外の記載のみなら present=0 の coverage にする", () => {
		const job = rawFieldsToNormalizedJob({
			benefitsCoverage: "社内にカフェあり",
		});
		expect(job.benefitsCoverage.kind).toBe("coverage");
		if (job.benefitsCoverage.kind !== "coverage") return;
		expect(job.benefitsCoverage.present).toBe(0);
	});

	// 未記載（"-"）は coverage 化せず unknown 中立に畳む（分母から外す・§5.2）。
	it("benefitsCoverage は未記載なら unknown 中立にする", () => {
		const job = rawFieldsToNormalizedJob({ benefitsCoverage: "-" });
		expect(isUnknown(job.benefitsCoverage)).toBe(true);
	});

	it("canonical 化しても生表記は raw に保持する（監査・UI 用）", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		expect(job.remoteWork.raw).toBe("フルリモート");
	});

	it("未知の categorical 値は生表記を 1 カテゴリとして残す", () => {
		// なぜ: マッピングに無い値を捨てると情報が失われる。canonical 化は best-effort。
		const job = rawFieldsToNormalizedJob({ remoteWork: "応相談" });
		if (job.remoteWork.kind === "categorical") {
			expect(job.remoteWork.categories).toEqual(["応相談"]);
		}
	});

	// 開集合キー（skillMatch）は canonical 化せず生表記を 1 カテゴリ保持する（情報を捨てない）。
	it("開集合キー（skillMatch）は生表記を 1 カテゴリ保持する", () => {
		const cases: ReadonlyArray<readonly [NormalizedKey, string]> = [
			["skillMatch", "TypeScript, React, Go, AWS"],
		];
		for (const [key, raw] of cases) {
			const job = rawFieldsToNormalizedJob({ [key]: raw });
			const value = job[key];
			expect(value.kind).toBe("categorical");
			if (value.kind === "categorical") {
				expect(value.categories).toEqual([raw]);
				expect(value.raw).toBe(raw);
			}
		}
	});

	it("生表記を raw として保持する（監査・UI 用）", () => {
		const job = rawFieldsToNormalizedJob({ annualSalary: "700万〜900万" });
		expect(job.annualSalary.raw).toBe("700万〜900万");
	});

	it("同一入力は常に同一結果（決定的）", () => {
		const a = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const b = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		expect(a).toEqual(b);
	});
});

// モデル解決（アダプタの差し戻し点・#106）: env 値を実効モデル ID に解決する。
describe("resolveExtractionModel", () => {
	it("未設定・空文字・空白のみはコード既定へフォールバックする（フォーク先で vars 未設定でも動く）", () => {
		expect(resolveExtractionModel(undefined)).toBe(EXTRACTION_MODEL);
		expect(resolveExtractionModel("")).toBe(EXTRACTION_MODEL);
		expect(resolveExtractionModel("   ")).toBe(EXTRACTION_MODEL);
	});

	it("設定値があればそれを採用し、前後空白は除く", () => {
		expect(resolveExtractionModel("@cf/forked/custom-model")).toBe(
			"@cf/forked/custom-model",
		);
		expect(resolveExtractionModel("  @cf/foo/bar  ")).toBe("@cf/foo/bar");
	});
});

// 抽出本体: AI を注入し JSON Mode で構造化抽出する。空入力は AI を呼ばない。
describe("extractJob", () => {
	it("options.model を渡すと当該モデルで run し、結果 model にも反映する（#106 横並び評価で注入）", async () => {
		const calls: Array<{ model: string }> = [];
		const fakeAi: AiRunner = {
			run: async (model: string) => {
				calls.push({ model });
				return { response: {} };
			},
		};

		const result = await extractJob(fakeAi, "本文", {
			model: "@cf/candidate/model",
		});

		expect(calls[0].model).toBe("@cf/candidate/model");
		expect(result.model).toBe("@cf/candidate/model");
	});

	it("options.model 未指定はコード既定モデルで run する", async () => {
		const calls: Array<{ model: string }> = [];
		const fakeAi: AiRunner = {
			run: async (model: string) => {
				calls.push({ model });
				return { response: {} };
			},
		};

		await extractJob(fakeAi, "本文");
		expect(calls[0].model).toBe(EXTRACTION_MODEL);
	});

	it("空本文では AI を呼ばず全 unknown を返す（unknown 中立・コスト最小化）", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};

		const result = await extractJob(fakeAi, "");

		expect(called).toBe(false);
		expect(result.model).toBe(EXTRACTION_MODEL);
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("空白のみの本文も空とみなし AI を呼ばない", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};

		await extractJob(fakeAi, "   \n  ");
		expect(called).toBe(false);
	});

	it("本文があれば JSON Mode で run し、生出力を正規スキーマへ寄せる", async () => {
		const calls: Array<{ model: string; inputs: unknown }> = [];
		const fakeAi: AiRunner = {
			run: async (model: string, inputs: unknown) => {
				calls.push({ model, inputs });
				// JSON Mode のレスポンスは { response: <object> } 形（一次ソース §7.1）
				return { response: { annualSalary: "700万〜900万" } };
			},
		};

		const result = await extractJob(fakeAi, "年収 700万〜900万");

		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe(EXTRACTION_MODEL);
		// JSON Mode を指示している（response_format に json_schema）
		const inputs = calls[0].inputs as {
			response_format?: { type?: string; json_schema?: unknown };
		};
		expect(inputs.response_format?.type).toBe("json_schema");
		expect(inputs.response_format?.json_schema).toBeDefined();
		// 生出力が正規スキーマへ寄っている
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("カタログ maxTokens を持つモデル（gpt-oss）は inputs に max_tokens を含める（#147）", async () => {
		const calls: unknown[] = [];
		const fakeAi: AiRunner = {
			run: async (_m, inputs) => {
				calls.push(inputs);
				return { response: {} };
			},
		};
		await extractJob(fakeAi, "本文", { model: "@cf/openai/gpt-oss-20b" });
		expect((calls[0] as { max_tokens?: number }).max_tokens).toBe(16384);
	});

	it("maxTokens 未設定モデルは inputs に max_tokens を含めない（モデル既定に委ねる・#147）", async () => {
		const calls: unknown[] = [];
		const fakeAi: AiRunner = {
			run: async (_m, inputs) => {
				calls.push(inputs);
				return { response: {} };
			},
		};
		await extractJob(fakeAi, "本文", { model: "@cf/forked/unknown-model" });
		expect((calls[0] as { max_tokens?: number }).max_tokens).toBeUndefined();
	});

	it("options.maxTokens で max_tokens を明示上書きできる（#147）", async () => {
		const calls: unknown[] = [];
		const fakeAi: AiRunner = {
			run: async (_m, inputs) => {
				calls.push(inputs);
				return { response: {} };
			},
		};
		await extractJob(fakeAi, "本文", { maxTokens: 2048 });
		expect((calls[0] as { max_tokens?: number }).max_tokens).toBe(2048);
	});

	it("AI が response 文字列（JSON）を返しても解釈できる", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({
				response: JSON.stringify({ annualSalary: "700万〜900万" }),
			}),
		};

		const result = await extractJob(fakeAi, "本文");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("OpenAI 互換形（choices[].message.content の JSON 文字列）も json-mode で解釈できる", async () => {
		// 一部 CF モデル（qwen3 / gemma / mistral 等）は json-mode でも WAI の { response } でなく
		// OpenAI 互換 { choices: [{ message: { content: "<json>" } }] } で返す（#145 で live 実証）。
		const fakeAi: AiRunner = {
			run: async () => ({
				choices: [
					{
						message: {
							content: JSON.stringify({ annualSalary: "700万〜900万" }),
						},
					},
				],
			}),
		};

		const result = await extractJob(fakeAi, "本文");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("OpenAI 互換形で content が object（parse 済）でも解釈できる", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({
				choices: [{ message: { content: { annualSalary: "700万〜900万" } } }],
			}),
		};

		const result = await extractJob(fakeAi, "本文");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("AI が想定外形（JSON Mode 未充足等）を返しても落とさず全 unknown へ畳む", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ error: "JSON Mode couldn't be met" }),
		};

		const result = await extractJob(fakeAi, "本文");
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("run が throw しても落とさず全 unknown を返す（抽出は堅牢に）", async () => {
		const fakeAi: AiRunner = {
			run: async () => {
				throw new Error("upstream down");
			},
		};

		const result = await extractJob(fakeAi, "本文");
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("成功時は status: ok を返す", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: { annualSalary: "700万" } }),
		};
		const result = await extractJob(fakeAi, "本文");
		expect(result.status).toBe("ok");
	});

	it("transient 504 は限定回数リトライし、成功すれば status: ok を返す", async () => {
		// なぜ: upstream の一時的 504 を無言で全 unknown へ畳まず、まずリトライで救う。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				if (attempts < 2) {
					throw { name: "InferenceUpstreamError", httpCode: 504 };
				}
				return { response: { annualSalary: "700万" } };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(2);
		expect(result.status).toBe("ok");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("transient 504 がリトライ上限まで続けば extraction_failed として畳む（呼び出し側が区別可能）", async () => {
		// なぜ: 「抽出失敗」と「unknown 中立」を呼び出し側が区別できる形にする（§5.2）。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				throw { name: "InferenceUpstreamError", httpCode: 504 };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		// 上限まで試行する
		expect(attempts).toBe(MAX_EXTRACTION_ATTEMPTS);
		expect(result.status).toBe("extraction_failed");
		// 全 unknown へ畳む（堅牢性は維持）
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("非 transient エラー（非 504）はリトライせず即 extraction_failed", async () => {
		// なぜ: 恒久的エラーをリトライしても無駄。区別して即座に失敗扱いにする。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				throw new Error("invalid request");
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(1);
		expect(result.status).toBe("extraction_failed");
	});

	it("想定外形（JSON Mode 未充足）はリトライせず status: ok の全 unknown（throw ではない）", async () => {
		// なぜ: throw されない想定外レスポンスは upstream 障害ではないためリトライ対象外。
		let attempts = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				attempts += 1;
				return { error: "JSON Mode couldn't be met" };
			},
		};
		const result = await extractJob(fakeAi, "本文", { backoffMs: 0 });
		expect(attempts).toBe(1);
		expect(result.status).toBe("ok");
	});

	it("抽出結果は再利用できる形（model と extractedAt を持つ）", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: {} }),
		};
		const result = await extractJob(fakeAi, "本文");
		// §5.3 再実行しない契約: 保存に必要なメタを持つ
		expect(typeof result.model).toBe("string");
		expect(typeof result.extractedAt).toBe("string");
	});
});

// 抽出↔スコアリングの正規化統合（#59）。抽出側の正規化が DEFAULT_SCORING_CONFIG の
// 単位前提（万円）・canonical 集合と噛み合い、妥当なサブスコアになることを担保する。
describe("正規化統合（抽出→スコアリング）", () => {
	it("円表記の年収が単位整合し annualSalary が常に 1.0 ではなくなる（gap1）", () => {
		// なぜ: 円のまま（9,000,000）だと desired:700 を桁違いに超え常に 1.0 になる回帰を防ぐ。
		const job = rawFieldsToNormalizedJob({ annualSalary: "5,000,000円" });
		const { breakdown } = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const row = breakdown.find((r) => r.key === "annualSalary");
		expect(row?.included).toBe(true);
		// desired:700 / floor:300 の補間域に入る（500万 → (500-300)/(700-300)=0.5）。
		expect(row?.score).toBeCloseTo(0.5);
	});

	it("canonical 化したリモート可否が preferred と突合できる（gap2）", () => {
		const job = rawFieldsToNormalizedJob({ remoteWork: "フルリモート" });
		const { breakdown } = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const row = breakdown.find((r) => r.key === "remoteWork");
		expect(row?.included).toBe(true);
		// "full" は tier 採点で別格の 1.0（#104）。
		expect(row?.score).toBe(1);
	});

	it("フルリモートは一部リモートより明確に高得点（別格加点・#104）", () => {
		// 抽出→canonical→tier 採点まで通し、full が partial を明確に上回ることを実証する。
		const fullRow = scoreJob(
			rawFieldsToNormalizedJob({ remoteWork: "フルリモート" }),
			DEFAULT_SCORING_CONFIG,
		).breakdown.find((r) => r.key === "remoteWork");
		const partialRow = scoreJob(
			rawFieldsToNormalizedJob({ remoteWork: "一部リモート可" }),
			DEFAULT_SCORING_CONFIG,
		).breakdown.find((r) => r.key === "remoteWork");
		expect(fullRow?.score).toBe(1);
		expect(partialRow?.score).toBe(0.5);
		expect(fullRow?.score ?? 0).toBeGreaterThan(partialRow?.score ?? 0);
	});

	// skillMatch は既定設定（keyword 未指定）では中立で total を引き下げない（§5.2・#105）。
	it("skillMatch に値があっても既定設定では total を引き下げない（keyword 未指定=中立）", () => {
		const withSkills = rawFieldsToNormalizedJob({
			annualSalary: "700万",
			skillMatch: "TypeScript 3年 / AWS",
		});
		const withoutSkills = rawFieldsToNormalizedJob({ annualSalary: "700万" });
		const a = scoreJob(withSkills, DEFAULT_SCORING_CONFIG);
		const b = scoreJob(withoutSkills, DEFAULT_SCORING_CONFIG);
		// skillMatch の有無で total が変わらない（既定 keyword は空＝中立）。
		expect(a.total).toBe(b.total);
		// breakdown 上も included=false（keyword 未指定の keywordMatch は中立）。
		expect(a.breakdown.find((r) => r.key === "skillMatch")?.included).toBe(
			false,
		);
	});

	// 修正2: 年収内のノイズ数値が min を汚染しサブスコアを破壊しないこと（決定性回帰）。
	it("年収のノイズ数値混入で annualSalary サブスコアが破損しない", () => {
		const job = rawFieldsToNormalizedJob({
			annualSalary: "賞与年2回 700万〜900万",
		});
		const { breakdown } = scoreJob(job, DEFAULT_SCORING_CONFIG);
		const row = breakdown.find((r) => r.key === "annualSalary");
		// max=900 が desired:700 を満たす → 1.0。min が 0.0002 に汚染されていないこと。
		expect(row?.score).toBe(1);
	});
});

// FC ツール定義（決定的）: json_schema と同じ properties を tools.parameters へ写し、全キー required にする。
describe("buildExtractionTool", () => {
	it("正規キーを properties に持ち、全キーを required にする（#15 取りこぼし対策）", () => {
		const tool = buildExtractionTool();
		expect(tool.name).toBe(EXTRACTION_TOOL_NAME);
		expect(tool.parameters.type).toBe("object");
		for (const key of NORMALIZED_KEYS) {
			expect(tool.parameters.properties[key]?.type).toBe("string");
			expect(tool.parameters.required).toContain(key);
		}
	});
});

// FC 機構: tools/tool_choice で要求し、tool_calls から正規スキーマへ寄せる（JSON Mode と同じ正規化へ合流）。
describe("extractJob (function-calling 機構)", () => {
	it("FC 候補モデルは tools + tool_choice で run し response_format を使わない", async () => {
		const calls: Array<{ model: string; inputs: unknown }> = [];
		const fakeAi: AiRunner = {
			run: async (model: string, inputs: unknown) => {
				calls.push({ model, inputs });
				return {
					tool_calls: [
						{
							name: EXTRACTION_TOOL_NAME,
							arguments: { annualSalary: "700万〜900万" },
						},
					],
				};
			},
		};

		// #147 時点でカタログ候補は全て json-mode のため、FC は options.mechanism 上書きで指定する。
		const result = await extractJob(fakeAi, "本文", {
			mechanism: "function-calling",
		});

		const inputs = calls[0].inputs as {
			tools?: unknown[];
			tool_choice?: unknown;
			response_format?: unknown;
		};
		expect(Array.isArray(inputs.tools)).toBe(true);
		expect(inputs.tool_choice).toBeDefined();
		expect(inputs.response_format).toBeUndefined();
		expect(result.mechanism).toBe("function-calling");
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("options.mechanism で機構を明示上書きできる（モデルと独立）", async () => {
		const calls: Array<{ inputs: unknown }> = [];
		const fakeAi: AiRunner = {
			run: async (_model: string, inputs: unknown) => {
				calls.push({ inputs });
				return {
					tool_calls: [
						{
							name: EXTRACTION_TOOL_NAME,
							arguments: { annualSalary: "700万" },
						},
					],
				};
			},
		};

		const result = await extractJob(fakeAi, "本文", {
			mechanism: "function-calling",
		});
		const inputs = calls[0].inputs as { tools?: unknown[] };
		expect(Array.isArray(inputs.tools)).toBe(true);
		expect(result.mechanism).toBe("function-calling");
	});

	it("arguments が JSON 文字列でも解釈できる", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({
				tool_calls: [
					{
						name: EXTRACTION_TOOL_NAME,
						arguments: JSON.stringify({ annualSalary: "700万〜900万" }),
					},
				],
			}),
		};
		const result = await extractJob(fakeAi, "本文", {
			mechanism: "function-calling",
		});
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("OpenAI 互換形（choices[].message.tool_calls[].function）も解釈できる", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({
				choices: [
					{
						message: {
							tool_calls: [
								{
									function: {
										name: EXTRACTION_TOOL_NAME,
										arguments: JSON.stringify({ annualSalary: "700万" }),
									},
								},
							],
						},
					},
				],
			}),
		};
		const result = await extractJob(fakeAi, "本文", {
			mechanism: "function-calling",
		});
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("FC 想定外形（tool_calls 無し）でも落とさず全 unknown へ畳む（status ok）", async () => {
		const fakeAi: AiRunner = {
			run: async () => ({ response: "平文に逃げた" }),
		};
		const result = await extractJob(fakeAi, "本文", {
			mechanism: "function-calling",
		});
		expect(result.status).toBe("ok");
		for (const key of NORMALIZED_KEYS) {
			expect(isUnknown(result.job[key])).toBe(true);
		}
	});

	it("空本文は AI を呼ばず機構を結果に反映する", async () => {
		let called = false;
		const fakeAi: AiRunner = {
			run: async () => {
				called = true;
				return {};
			},
		};
		const result = await extractJob(fakeAi, "", {
			mechanism: "function-calling",
		});
		expect(called).toBe(false);
		expect(result.mechanism).toBe("function-calling");
	});
});

// 生 HTML からの抽出（コンテンツ準備＋分割パス・#107 Task 14）。
describe("extractJobFromHtml", () => {
	it("予算内は主パス 1 回だけ実行する（従来挙動）", async () => {
		let runs = 0;
		const fakeAi: AiRunner = {
			run: async () => {
				runs += 1;
				return { response: { annualSalary: "700万" } };
			},
		};
		const html = "<html><body><p>年収 700万</p></body></html>";
		const result = await extractJobFromHtml(fakeAi, html);
		expect(runs).toBe(1);
		expect(result.job.annualSalary.kind).toBe("numericRange");
	});

	it("予算超過かつ福利厚生ありは主パス＋benefitsパスの2回で抽出し、福利厚生キーを統合する", async () => {
		const calls: string[] = [];
		const fakeAi: AiRunner = {
			run: async (_model: string, inputs: unknown) => {
				const body = (
					inputs as { messages: Array<{ role: string; content: string }> }
				).messages[1].content;
				calls.push(body);
				// benefits パス（福利厚生本文を含む）だけ年間休日を返す。
				if (body.includes("福利厚生")) {
					return { response: { annualHolidays: "125日" } };
				}
				return { response: { annualSalary: "700万" } };
			},
		};
		const filler = "業務内容の説明。".repeat(80);
		const html = `<html><body><p>${filler}</p><p>福利厚生</p><p>年間休日125日</p></body></html>`;

		const result = await extractJobFromHtml(fakeAi, html, { maxChars: 50 });

		expect(calls.length).toBe(2);
		// 主パスの年収と benefits パスの年間休日が統合される。
		expect(result.job.annualSalary.kind).toBe("numericRange");
		expect(result.job.annualHolidays.kind).toBe("numericRange");
	});
});
