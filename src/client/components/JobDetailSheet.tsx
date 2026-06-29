import type { JSX } from "react";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { RankingItem } from "../lib/useRanking";

// 求人詳細の右ドロワー（設計書 §4.4）。本コンポーネントは開閉ガワのみ。
//
// なぜガワだけか:
// - #108 シェルでは「行選択 → 右からスライド」の開閉と a11y（タイトル必須）を成立させるのが責務。
//   ヘッダ詳細・フラット内訳・再抽出/評判取得アクションは #111 で中身を実装する。
// - 開閉状態は親（Dashboard）が選択行として持ち、controlled に制御する。

export interface JobDetailSheetProps {
	// 選択中の求人（未選択は null）。
	job: RankingItem | null;
	// ドロワーの開閉。
	open: boolean;
	// 開閉変更（オーバーレイ／閉じるボタン／Esc を含む）。
	onOpenChange: (open: boolean) => void;
}

export function JobDetailSheet({
	job,
	open,
	onOpenChange,
}: JobDetailSheetProps): JSX.Element {
	// company/title は契約上まだ null（#95）。暫定で sourceUrl をタイトル代替にする。
	const heading = job?.title ?? job?.company ?? job?.sourceUrl ?? "求人詳細";

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" data-testid="job-detail-sheet">
				<SheetHeader>
					<SheetTitle>{heading}</SheetTitle>
					<SheetDescription>
						詳細（内訳・再抽出・評判取得）は #111 で実装します。
					</SheetDescription>
				</SheetHeader>
			</SheetContent>
		</Sheet>
	);
}
