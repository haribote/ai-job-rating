// CSS の副作用 import（main.tsx の globals.css）を型解決するための宣言。
// Vite が実体をバンドルするため、TS 側では値を持たないモジュールとして扱う。
declare module "*.css";
