import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// ローディング中のプレースホルダ（Wave 3 #112 の楽観的 UI で利用）。
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("animate-pulse rounded-md bg-muted", className)}
			{...props}
		/>
	);
}

export { Skeleton };
