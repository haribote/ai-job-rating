import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn 標準のクラス結合ユーティリティ。条件付きクラスを clsx で組み、tailwind-merge で競合を解消する。
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
