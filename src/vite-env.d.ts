// vite.config.ts define 注入的全局常量(版本号取自 package.json)
declare const __APP_VERSION__: string;

// 品牌图标以 URL 形式引入（Vite 会把 SVG 当静态资源处理）
declare module "*.svg" {
  const src: string;
  export default src;
}
